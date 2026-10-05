import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { notification } from '@a5/contracts';
import type { Selectable } from '@a5/database';
import { EventBus, InjectDb, NotFoundError, PreconditionError, ValidationError, type FieldError } from '@a5/nest-kit';
import { DefaultsService } from '../catalog/defaults.js';
import { NOTIFICATION_TYPE_DEFS, allowedRecipientKinds, getTypeDef, type NotificationTypeDef } from '../catalog/notification-types.js';
import { json, type Db, type NotificationRulesTable } from '../database/index.js';

type RuleRow = Selectable<NotificationRulesTable> & { updated_by_name: string | null };
type RuleDto = notification.NotificationRule;

const TYPE_ORDER = new Map(NOTIFICATION_TYPE_DEFS.map((d, i) => [d.key, i]));

function channelName(c: string): string {
  return c === 'email' ? 'email' : 'in-app notification';
}

@Injectable()
export class RulesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly defaults: DefaultsService,
    private readonly events: EventBus,
  ) {}

  async list(p: Principal, q: notification.ListRulesQuery): Promise<{ items: RuleDto[] }> {
    await this.defaults.ensure(p.organizationId);
    let query = this.baseQuery(p.organizationId);
    if (q.eventType) query = query.where('r.event_type', '=', q.eventType);
    if (q.enabled !== undefined) query = query.where('r.enabled', '=', q.enabled);
    if (q.category) query = query.where('r.notification_type', 'in', NOTIFICATION_TYPE_DEFS.filter((d) => d.category === q.category).map((d) => d.key));
    const rows = await query.execute();
    const items = rows.flatMap((r) => {
      const dto = this.toDto(r);
      return dto ? [dto] : [];
    });
    items.sort((a, b) => TYPE_ORDER.get(a.type)! - TYPE_ORDER.get(b.type)!);
    return { items };
  }

  async get(p: Principal, id: string): Promise<RuleDto> {
    const { row } = await this.load(p, id);
    return this.toDto(row)!;
  }

  async update(p: Principal, id: string, input: notification.UpdateRuleRequest, action = 'notification_rule.updated'): Promise<RuleDto> {
    const { row, def } = await this.load(p, id);
    if (def.mandatory && (input.enabled === false || input.recipients !== undefined || input.channels !== undefined || input.conditions !== undefined)) {
      throw new PreconditionError(
        'RULE_LOCKED',
        `${def.label} emails always go to the person by email for account security. You can change their wording in the template.`,
      );
    }
    const next = {
      recipients: input.recipients ?? row.recipients,
      channels: input.channels ?? row.channels,
      conditions: input.conditions ?? row.conditions,
      delayMinutes: input.delayMinutes ?? row.delay_minutes,
      priority: input.priority ?? row.priority,
      enabled: input.enabled ?? row.enabled,
    };
    const errors = this.validate(def, next.recipients, next.channels);
    if (errors.length) throw new ValidationError(errors);

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('notification_rules')
        .set({
          recipients: [...new Set(next.recipients)],
          channels: [...new Set(next.channels)],
          conditions: json(next.conditions),
          delay_minutes: next.delayMinutes,
          priority: next.priority,
          enabled: next.enabled,
          updated_by: p.userId,
        })
        .where('id', '=', id)
        .where('organization_id', '=', p.organizationId)
        .execute();
      await this.events.audit(trx, {
        action,
        resourceType: 'notification_rule',
        resourceId: id,
        actorDisplay: p.displayName,
        before: {
          recipients: row.recipients,
          channels: row.channels,
          conditions: row.conditions,
          delayMinutes: row.delay_minutes,
          priority: row.priority,
          enabled: row.enabled,
        },
        after: next,
        metadata: { key: row.key, eventType: row.event_type },
      });
    });
    return this.get(p, id);
  }

  setEnabled(p: Principal, id: string, enabled: boolean): Promise<RuleDto> {
    return this.update(p, id, { enabled }, enabled ? 'notification_rule.enabled' : 'notification_rule.disabled');
  }

  private validate(def: NotificationTypeDef, recipients: readonly string[], channels: readonly string[]): FieldError[] {
    const errors: FieldError[] = [];
    const allowed = allowedRecipientKinds(def.eventType);
    recipients.forEach((r, i) => {
      if (!r.startsWith('role:') && !allowed.includes(r)) {
        errors.push({ path: `recipients.${i}`, message: `${r} cannot receive ${def.label}. Choose from ${allowed.join(', ')}.` });
      }
    });
    channels.forEach((c, i) => {
      if (!def.channels.includes(c as never)) {
        errors.push({ path: `channels.${i}`, message: `${def.label} is only sent by ${def.channels.map(channelName).join(' or ')}.` });
      }
    });
    return errors;
  }

  private baseQuery(organizationId: string) {
    return this.db
      .selectFrom('notification_rules as r')
      .leftJoin('dir_users as u', 'u.id', 'r.updated_by')
      .selectAll('r')
      .select('u.display_name as updated_by_name')
      .where('r.organization_id', '=', organizationId);
  }

  private async load(p: Principal, id: string): Promise<{ row: RuleRow; def: NotificationTypeDef }> {
    const row = await this.baseQuery(p.organizationId).where('r.id', '=', id).executeTakeFirst();
    const def = row ? getTypeDef(row.notification_type) : undefined;
    if (!row || !def) throw new NotFoundError('Notification rule');
    return { row, def };
  }

  private toDto(row: RuleRow): RuleDto | null {
    const def = getTypeDef(row.notification_type);
    if (!def) return null;
    return {
      id: row.id,
      key: row.key,
      type: def.key,
      typeLabel: def.label,
      description: def.description,
      category: def.category,
      eventType: row.event_type,
      recipients: row.recipients,
      allowedRecipients: allowedRecipientKinds(def.eventType),
      channels: row.channels,
      supportedChannels: def.channels,
      fixedConditions: def.fixedConditions,
      conditions: row.conditions as notification.RuleConditions,
      delayMinutes: row.delay_minutes,
      priority: row.priority,
      enabled: row.enabled,
      mandatory: def.mandatory,
      updatedAt: row.updated_at.toISOString(),
      updatedBy: row.updated_by ? { id: row.updated_by, displayName: row.updated_by_name ?? 'Former team member' } : null,
    };
  }
}
