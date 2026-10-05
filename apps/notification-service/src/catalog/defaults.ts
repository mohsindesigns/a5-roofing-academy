import { Injectable } from '@nestjs/common';
import { InjectDb } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import { json, type Channel, type Db, type DbOrTrx } from '../database/index.js';
import { NOTIFICATION_TYPE_DEFS, type NotificationTypeDef } from './notification-types.js';

/** Default template rows of a type (one per supported channel). */
export function defaultTemplates(def: NotificationTypeDef): Array<{ channel: Channel; subject: string; body: string }> {
  return def.channels.flatMap((channel) => {
    const content = def.defaults[channel];
    return content ? [{ channel, subject: content.subject, body: content.body }] : [];
  });
}

/**
 * Create the shipped templates and rules for an organization. Existing rows (including
 * administrator edits) are left untouched; types added in a later release are filled in.
 */
export async function provisionDefaults(db: DbOrTrx, organizationId: string): Promise<{ templates: number; rules: number }> {
  const templates = NOTIFICATION_TYPE_DEFS.flatMap((def) =>
    defaultTemplates(def).map((t) => ({
      id: uuidv7(),
      organization_id: organizationId,
      type: def.key,
      channel: t.channel,
      subject: t.subject,
      body: t.body,
      updated_by: null,
    })),
  );
  const rules = NOTIFICATION_TYPE_DEFS.map((def) => ({
    id: uuidv7(),
    organization_id: organizationId,
    key: def.key,
    event_type: def.eventType,
    notification_type: def.key,
    recipients: def.rule.recipients,
    channels: def.rule.channels,
    conditions: json(def.rule.conditions),
    delay_minutes: def.rule.delayMinutes,
    priority: def.rule.priority,
    updated_by: null,
  }));
  const t = await db
    .insertInto('notification_templates')
    .values(templates)
    .onConflict((oc) => oc.columns(['organization_id', 'type', 'channel']).doNothing())
    .executeTakeFirst();
  const r = await db
    .insertInto('notification_rules')
    .values(rules)
    .onConflict((oc) => oc.columns(['organization_id', 'key']).doNothing())
    .executeTakeFirst();
  return { templates: Number(t.numInsertedOrUpdatedRows ?? 0n), rules: Number(r.numInsertedOrUpdatedRows ?? 0n) };
}

/** Provisions defaults once per organization per process. */
@Injectable()
export class DefaultsService {
  private readonly done = new Map<string, Promise<void>>();

  constructor(@InjectDb() private readonly db: Db) {}

  ensure(organizationId: string): Promise<void> {
    let pending = this.done.get(organizationId);
    if (!pending) {
      pending = provisionDefaults(this.db, organizationId).then(() => undefined);
      pending.catch(() => this.done.delete(organizationId));
      this.done.set(organizationId, pending);
    }
    return pending;
  }
}
