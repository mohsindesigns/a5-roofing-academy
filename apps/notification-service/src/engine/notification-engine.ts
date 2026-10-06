import { Inject, Injectable } from '@nestjs/common';
import type { Insertable, Selectable } from '@a5/database';
import { DirectoryReader } from '@a5/directory';
import type { notification } from '@a5/contracts';
import type { EventEnvelope } from '@a5/events';
import { processOnce } from '@a5/messaging';
import { InjectDb, LOGGER } from '@a5/nest-kit';
import { uuidv7, type Logger } from '@a5/observability';
import { matchesConditions, readPath } from '../catalog/conditions.js';
import { DefaultsService } from '../catalog/defaults.js';
import {
  EVENT_DESCRIPTORS,
  getTypeDef,
  type BuildContext,
  type NotificationTypeDef,
} from '../catalog/notification-types.js';
import { NOTIFICATION_CONFIG, type NotificationConfig } from '../config.js';
import {
  json,
  type Channel,
  type Db,
  type EmailDeliveriesTable,
  type NotificationRulesTable,
  type NotificationsTable,
} from '../database/index.js';
import { EmailDispatcher } from '../email/email.dispatcher.js';
import { ContentSealer } from '../email/sealer.js';
import { toNotificationDto } from '../inbox/notifications.repository.js';
import { optOuts } from '../inbox/preferences.service.js';
import { DelayedPushScheduler } from '../realtime/push.scheduler.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import {
  renderEmail,
  renderInApp,
  renderInline,
  type TemplateVars,
} from '../templates/renderer.js';
import { RecipientResolver, type ResolvedRecipient, type SubjectFallback } from './recipients.js';

export const DISPATCH_HANDLER = 'notification.dispatch';
/** Deliveries of an event before recipients are resolved without the subject's directory record. */
export const DIRECTORY_RETRY_LIMIT = 3;
const DIRECTORY_KINDS = new Set(['managers', 'team_managers', 'trainers']);

/** The person an event is about is not in the directory projection yet; retry the event later. */
export class DirectoryNotReadyError extends Error {
  constructor(readonly userId: string) {
    super(`Directory record for ${userId} is not available yet; the event will be retried`);
    this.name = 'DirectoryNotReadyError';
  }
}

export interface DispatchSummary {
  processed: boolean;
  notifications: number;
  emails: number;
}

type RuleRow = Selectable<NotificationRulesTable>;
type RuleConditions = notification.RuleConditions;
type NotificationInsert = Insertable<NotificationsTable>;
type EmailInsert = Insertable<EmailDeliveriesTable>;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

/**
 * Turns domain events into in-app notifications and emails: matching rules → recipients from the
 * directory → preferences → rendered templates. All rows of one event are written in one
 * transaction together with the inbox claim, so redelivery never duplicates anything; pushes and
 * email jobs are dispatched after commit.
 */
@Injectable()
export class NotificationEngine {
  private readonly dateFormat: Intl.DateTimeFormat;
  private readonly dateTimeFormat: Intl.DateTimeFormat;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly defaults: DefaultsService,
    private readonly resolver: RecipientResolver,
    private readonly directory: DirectoryReader,
    private readonly realtime: RealtimePublisher,
    private readonly pushes: DelayedPushScheduler,
    private readonly email: EmailDispatcher,
    private readonly sealer: ContentSealer,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    const timeZone = config.timezone;
    this.dateFormat = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone,
    });
    this.dateTimeFormat = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone,
    });
  }

  /**
   * Process one event. `attempt` is the stream delivery count; while it is below
   * {@link DIRECTORY_RETRY_LIMIT} a subject missing from the directory makes the event retry.
   */
  async handle(event: EventEnvelope, attempt = DIRECTORY_RETRY_LIMIT): Promise<DispatchSummary> {
    const none: DispatchSummary = { processed: false, notifications: 0, emails: 0 };
    const descriptor = EVENT_DESCRIPTORS[event.type];
    const organizationId = event.organizationId;
    if (!descriptor || !organizationId) return none;
    if (await this.alreadyProcessed(event.id)) return none;

    await this.defaults.ensure(organizationId);
    const payload = event.payload;
    const rules = await this.db
      .selectFrom('notification_rules')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('event_type', '=', event.type)
      .where('enabled', '=', true)
      .orderBy('key')
      .execute();
    const matching = rules.flatMap((rule) => {
      const def = getTypeDef(rule.notification_type);
      if (!def || def.eventType !== event.type) return [];
      if (
        !matchesConditions(payload, def.fixedConditions) ||
        !matchesConditions(payload, rule.conditions as RuleConditions)
      )
        return [];
      return [{ rule, def }];
    });

    const subjectId = descriptor.subjectPath
      ? asString(readPath(payload, descriptor.subjectPath))
      : null;
    const programId = descriptor.programPath
      ? asString(readPath(payload, descriptor.programPath))
      : null;
    const fallback: SubjectFallback = {
      email: asString(readPath(payload, 'email')),
      displayName: asString(readPath(payload, 'displayName')),
    };

    const subjectUser = subjectId ? await this.directory.getUser(subjectId) : null;
    if (subjectId && !subjectUser && attempt < DIRECTORY_RETRY_LIMIT && matching.length > 0) {
      const needsDirectory =
        !fallback.displayName ||
        matching.some(
          ({ rule }) =>
            rule.recipients.some((k) => DIRECTORY_KINDS.has(k)) ||
            (rule.recipients.includes('subject') &&
              rule.channels.includes('email') &&
              !fallback.email),
        );
      if (needsDirectory) throw new DirectoryNotReadyError(subjectId);
    }

    const nameIds = new Set<string>();
    for (const { def } of matching) {
      for (const field of def.nameFields) {
        const id = asString(readPath(payload, field));
        if (id) nameIds.add(id);
      }
    }
    const people = await this.directory.getUsers([...nameIds]);
    const ctx: BuildContext = {
      appUrl: this.config.publicAppUrl,
      formatDate: (iso) => this.dateFormat.format(new Date(iso)),
      // Newer ICU data separates time and AM/PM with U+202F; plain spaces read better in every mail client.
      formatDateTime: (iso) =>
        this.dateTimeFormat.format(new Date(iso)).replace(/[\u202f\u00a0]/g, ' '),
      nameOf: (id, fallbackName) =>
        id ? (people.get(id)?.displayName ?? fallbackName) : fallbackName,
    };
    const learnerName = subjectUser?.displayName ?? fallback.displayName ?? 'A5 team member';
    const actorUserId = event.actor.type === 'user' ? event.actor.id : null;

    const notifications: NotificationInsert[] = [];
    const emails: EmailInsert[] = [];
    const seen = new Set<string>();
    for (const { rule, def } of matching) {
      const recipients = await this.resolver.resolve(rule.recipients, {
        organizationId,
        subjectId,
        programId,
        actorUserId,
        subjectFallback: fallback,
      });
      if (recipients.length === 0) continue;
      const built = def.build(payload, ctx);
      const subjectVars: TemplateVars = subjectId
        ? { learnerName, learnerFirstName: firstName(learnerName) }
        : {};
      const plan = await this.plan(rule, def, recipients);
      for (const { recipient, channel, template } of plan) {
        const key = `${recipient.userId}:${def.key}:${channel}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const link = built.secretLink ?? `${this.config.publicAppUrl}${built.path ?? ''}`;
        const vars: TemplateVars = {
          ...built.vars,
          ...subjectVars,
          recipientFirstName: recipient.firstName,
          recipientName: recipient.displayName,
          appUrl: this.config.publicAppUrl,
        };
        if (channel === 'in_app') {
          if (def.sensitive) continue;
          const rendered = renderInApp(template, { ...vars, link });
          notifications.push({
            id: uuidv7(),
            organization_id: organizationId,
            user_id: recipient.userId,
            type: def.key,
            title: rendered.title,
            body: rendered.body,
            link: built.path,
            data: json(built.data),
            priority: rule.priority,
            source_event_id: event.id,
            ...(rule.delay_minutes > 0
              ? { available_at: new Date(Date.now() + rule.delay_minutes * 60_000) }
              : {}),
          });
          continue;
        }
        if (!recipient.email) {
          this.logger.warn(
            { eventId: event.id, type: def.key, userId: recipient.userId },
            'no email address on file; email skipped',
          );
          continue;
        }
        const rendered = renderEmail(
          template,
          { ...vars, link },
          {
            actionLabel: def.actionLabel,
            actionUrl: link,
            appUrl: this.config.publicAppUrl,
            mandatory: def.mandatory,
          },
        );
        emails.push({
          id: uuidv7(),
          organization_id: organizationId,
          user_id: recipient.userId,
          notification_type: def.key,
          source_event_id: event.id,
          to_address: recipient.email,
          to_name: recipient.displayName,
          // Subjects of security emails are rendered without the secret link.
          subject: def.sensitive ? renderInline(template.subject, vars) : rendered.subject,
          body_text: def.sensitive ? null : rendered.text,
          body_html: def.sensitive ? null : rendered.html,
          sealed_content: def.sensitive
            ? this.sealer.seal({ text: rendered.text, html: rendered.html })
            : null,
          sensitive: def.sensitive,
          ...(rule.delay_minutes > 0
            ? { scheduled_at: new Date(Date.now() + rule.delay_minutes * 60_000) }
            : {}),
        });
      }
    }

    let created: Array<Selectable<NotificationsTable>> = [];
    let queued: Array<{ id: string; scheduled_at: Date }> = [];
    const processed = await processOnce(this.db, DISPATCH_HANDLER, event, async (trx) => {
      if (notifications.length) {
        created = await trx
          .insertInto('notifications')
          .values(notifications)
          .onConflict((oc) => oc.columns(['source_event_id', 'user_id', 'type']).doNothing())
          .returningAll()
          .execute();
      }
      if (emails.length) {
        queued = await trx
          .insertInto('email_deliveries')
          .values(emails)
          .onConflict((oc) =>
            oc.columns(['source_event_id', 'user_id', 'notification_type']).doNothing(),
          )
          .returning(['id', 'scheduled_at'])
          .execute();
      }
    });
    if (!processed) return none;

    await this.afterCommit(created, queued);
    if (created.length || queued.length) {
      this.logger.debug(
        {
          eventId: event.id,
          type: event.type,
          notifications: created.length,
          emails: queued.length,
        },
        'notifications dispatched',
      );
    }
    return { processed: true, notifications: created.length, emails: queued.length };
  }

  private async plan(
    rule: RuleRow,
    def: NotificationTypeDef,
    recipients: ResolvedRecipient[],
  ): Promise<
    Array<{
      recipient: ResolvedRecipient;
      channel: Channel;
      template: { subject: string; body: string };
    }>
  > {
    const channels = rule.channels.filter((c) => def.channels.includes(c));
    const templates = await this.db
      .selectFrom('notification_templates')
      .select(['channel', 'subject', 'body'])
      .where('organization_id', '=', rule.organization_id)
      .where('type', '=', def.key)
      .where('enabled', '=', true)
      .execute();
    const byChannel = new Map(templates.map((t) => [t.channel, t]));
    const blocked = def.mandatory
      ? new Set<string>()
      : await optOuts(
          this.db,
          def.key,
          recipients.map((r) => r.userId),
        );
    const out: Array<{
      recipient: ResolvedRecipient;
      channel: Channel;
      template: { subject: string; body: string };
    }> = [];
    for (const recipient of recipients) {
      for (const channel of channels) {
        const template = byChannel.get(channel);
        if (!template || blocked.has(`${recipient.userId}:${channel}`)) continue;
        out.push({ recipient, channel, template });
      }
    }
    return out;
  }

  private async afterCommit(
    created: Array<Selectable<NotificationsTable>>,
    queued: Array<{ id: string; scheduled_at: Date }>,
  ): Promise<void> {
    const now = Date.now();
    const immediate = created.filter((n) => n.available_at.getTime() <= now + 1_000);
    await this.realtime.notificationsCreated(
      immediate.map((n) => ({ userId: n.user_id, notification: toNotificationDto(n) })),
    );
    for (const n of created) {
      if (n.available_at.getTime() > now + 1_000)
        await this.pushes.schedule(n.id, n.available_at.getTime() - now);
    }
    await this.email.enqueueMany(queued.map((q) => ({ id: q.id, scheduledAt: q.scheduled_at })));
  }

  private async alreadyProcessed(eventId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('inbox_events')
      .select('event_id')
      .where('event_id', '=', eventId)
      .where('handler', '=', DISPATCH_HANDLER)
      .executeTakeFirst();
    return Boolean(row);
  }
}
