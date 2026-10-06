import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { notification } from '@a5/contracts';
import type { Selectable } from '@a5/database';
import {
  EventBus,
  InjectDb,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '@a5/nest-kit';
import type { FieldError } from '@a5/nest-kit';
import { DefaultsService } from '../catalog/defaults.js';
import {
  NOTIFICATION_TYPE_DEFS,
  getTypeDef,
  variablesOf,
  type NotificationTypeDef,
} from '../catalog/notification-types.js';
import { NOTIFICATION_CONFIG, type NotificationConfig } from '../config.js';
import type { Channel, Db, NotificationTemplatesTable } from '../database/index.js';
import {
  malformedPlaceholders,
  referencedVariables,
  renderEmail,
  renderInApp,
  type TemplateVars,
} from './renderer.js';

type TemplateRow = Selectable<NotificationTemplatesTable> & { updated_by_name: string | null };
type TemplateDto = notification.NotificationTemplate;

const TYPE_ORDER = new Map(NOTIFICATION_TYPE_DEFS.map((d, i) => [d.key, i]));

/** Check placeholders against the variables of the type. Returns field errors (empty when valid). */
export function validateTemplate(
  def: NotificationTypeDef,
  content: { subject: string; body: string },
): FieldError[] {
  const allowed = variablesOf(def).map((v) => v.name);
  const errors: FieldError[] = [];
  for (const field of ['subject', 'body'] as const) {
    const text = content[field];
    for (const token of malformedPlaceholders(text)) {
      errors.push({
        path: field,
        message: `Fix the placeholder ${token}. Placeholders look like {{variableName}}.`,
      });
    }
    for (const name of referencedVariables(text)) {
      if (!allowed.includes(name)) {
        errors.push({
          path: field,
          message: `Unknown variable {{${name}}}. Available: ${allowed.map((a) => `{{${a}}}`).join(', ')}.`,
        });
      }
    }
  }
  if (def.sensitive && referencedVariables(content.subject).includes('link')) {
    errors.push({
      path: 'subject',
      message: 'The one-time link can only appear in the message body, never in the subject.',
    });
  }
  return errors;
}

@Injectable()
export class TemplatesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly defaults: DefaultsService,
    private readonly events: EventBus,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {}

  async list(p: Principal, q: notification.ListTemplatesQuery): Promise<{ items: TemplateDto[] }> {
    await this.defaults.ensure(p.organizationId);
    let query = this.baseQuery(p.organizationId);
    if (q.type) query = query.where('t.type', '=', q.type);
    if (q.channel) query = query.where('t.channel', '=', q.channel);
    if (q.category)
      query = query.where(
        't.type',
        'in',
        NOTIFICATION_TYPE_DEFS.filter((d) => d.category === q.category).map((d) => d.key),
      );
    const rows = await query.execute();
    const items = rows.flatMap((r) => {
      const dto = this.toDto(r);
      return dto ? [dto] : [];
    });
    items.sort(
      (a, b) =>
        TYPE_ORDER.get(a.type)! - TYPE_ORDER.get(b.type)! || a.channel.localeCompare(b.channel),
    );
    return { items };
  }

  async get(p: Principal, id: string): Promise<TemplateDto> {
    const { row } = await this.load(p, id);
    return this.toDto(row)!;
  }

  async update(
    p: Principal,
    id: string,
    input: notification.UpdateTemplateRequest,
  ): Promise<TemplateDto> {
    const { row, def } = await this.load(p, id);
    const next = {
      subject: input.subject ?? row.subject,
      body: input.body ?? row.body,
      enabled: input.enabled ?? row.enabled,
    };
    const errors = validateTemplate(def, next);
    if (errors.length) throw new ValidationError(errors);
    if (!next.enabled && def.mandatory) {
      throw new PreconditionError(
        'TEMPLATE_REQUIRED',
        `${def.label} emails are required for account security and cannot be switched off. You can change their wording.`,
      );
    }
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('notification_templates')
        .set({
          subject: next.subject,
          body: next.body,
          enabled: next.enabled,
          updated_by: p.userId,
        })
        .where('id', '=', id)
        .where('organization_id', '=', p.organizationId)
        .execute();
      await this.events.audit(trx, {
        action: 'notification_template.updated',
        resourceType: 'notification_template',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { subject: row.subject, body: row.body, enabled: row.enabled },
        after: next,
        metadata: { type: row.type, channel: row.channel },
      });
    });
    return this.get(p, id);
  }

  async reset(p: Principal, id: string): Promise<TemplateDto> {
    const { row, def } = await this.load(p, id);
    const content = def.defaults[row.channel];
    if (!content) throw new NotFoundError('Default template');
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('notification_templates')
        .set({ subject: content.subject, body: content.body, enabled: true, updated_by: p.userId })
        .where('id', '=', id)
        .where('organization_id', '=', p.organizationId)
        .execute();
      await this.events.audit(trx, {
        action: 'notification_template.reset',
        resourceType: 'notification_template',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { subject: row.subject, body: row.body, enabled: row.enabled },
        after: { subject: content.subject, body: content.body, enabled: true },
        metadata: { type: row.type, channel: row.channel },
      });
    });
    return this.get(p, id);
  }

  async preview(
    p: Principal,
    id: string,
    input: notification.PreviewTemplateRequest,
  ): Promise<notification.TemplatePreview> {
    const { row, def } = await this.load(p, id);
    const content = { subject: input.subject ?? row.subject, body: input.body ?? row.body };
    const errors = validateTemplate(def, content);
    if (errors.length) throw new ValidationError(errors);
    const appUrl = this.config.publicAppUrl;
    const vars: TemplateVars = Object.fromEntries(variablesOf(def).map((v) => [v.name, v.sample]));
    vars.appUrl = appUrl;
    vars.link = def.sensitive ? `${appUrl}/activate?token=preview-only` : `${appUrl}/training`;
    for (const [name, value] of Object.entries(input.data ?? {})) {
      if (name in vars) vars[name] = value;
    }
    const link = vars.link ?? null;
    if (row.channel === 'email') {
      const email = renderEmail(content, vars, {
        actionLabel: def.actionLabel,
        actionUrl: link,
        appUrl,
        mandatory: def.mandatory,
      });
      return { channel: 'email', subject: email.subject, text: email.text, html: email.html, link };
    }
    const inApp = renderInApp(content, vars);
    return { channel: 'in_app', subject: inApp.title, text: inApp.body, html: null, link };
  }

  private baseQuery(organizationId: string) {
    return this.db
      .selectFrom('notification_templates as t')
      .leftJoin('dir_users as u', 'u.id', 't.updated_by')
      .selectAll('t')
      .select('u.display_name as updated_by_name')
      .where('t.organization_id', '=', organizationId);
  }

  private async load(
    p: Principal,
    id: string,
  ): Promise<{ row: TemplateRow; def: NotificationTypeDef }> {
    const row = await this.baseQuery(p.organizationId).where('t.id', '=', id).executeTakeFirst();
    const def = row ? getTypeDef(row.type) : undefined;
    if (!row || !def) throw new NotFoundError('Notification template');
    return { row, def };
  }

  private toDto(row: TemplateRow): TemplateDto | null {
    const def = getTypeDef(row.type);
    if (!def) return null;
    const shipped = def.defaults[row.channel as Channel];
    return {
      id: row.id,
      type: def.key,
      typeLabel: def.label,
      category: def.category,
      channel: row.channel,
      subject: row.subject,
      body: row.body,
      enabled: row.enabled,
      isDefault: Boolean(shipped && shipped.subject === row.subject && shipped.body === row.body),
      sensitive: def.sensitive,
      variables: variablesOf(def),
      updatedAt: row.updated_at.toISOString(),
      updatedBy: row.updated_by
        ? { id: row.updated_by, displayName: row.updated_by_name ?? 'Former team member' }
        : null,
    };
  }
}
