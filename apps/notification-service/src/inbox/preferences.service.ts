import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { notification } from '@a5/contracts';
import { sql } from '@a5/database';
import { InjectDb, ValidationError } from '@a5/nest-kit';
import { DefaultsService } from '../catalog/defaults.js';
import { NOTIFICATION_TYPE_DEFS, getTypeDef } from '../catalog/notification-types.js';
import type { Channel, Db, DbOrTrx } from '../database/index.js';

/**
 * Per-person opt-outs by notification type and channel. Everything is on by default; security
 * messages (activation, password reset) cannot be switched off.
 */
@Injectable()
export class PreferencesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly defaults: DefaultsService,
  ) {}

  async list(p: Principal): Promise<notification.PreferencesResponse> {
    await this.defaults.ensure(p.organizationId);
    const [rules, prefs] = await Promise.all([
      this.db
        .selectFrom('notification_rules')
        .select(['notification_type', 'channels', 'enabled'])
        .where('organization_id', '=', p.organizationId)
        .execute(),
      this.db
        .selectFrom('notification_preferences')
        .select(['type', 'channel', 'enabled'])
        .where('user_id', '=', p.userId)
        .execute(),
    ]);
    const ruleByType = new Map(rules.map((r) => [r.notification_type, r]));
    const prefByKey = new Map(prefs.map((r) => [`${r.type}:${r.channel}`, r.enabled]));
    const supervises =
      p.managedTeamIds.length > 0 ||
      p.managedUserIds.length > 0 ||
      p.can('approvals.decide') ||
      p.can('certificate_approvals.decide');

    const items: notification.NotificationPreference[] = [];
    for (const def of NOTIFICATION_TYPE_DEFS) {
      if (def.mandatory || (def.audience === 'manager' && !supervises)) continue;
      const rule = ruleByType.get(def.key);
      if (!rule?.enabled) continue;
      const channels = def.channels.filter((c) => rule.channels.includes(c));
      if (channels.length === 0) continue;
      items.push({
        type: def.key,
        label: def.label,
        description: def.description,
        category: def.category,
        channels: channels.map((channel) => ({
          channel,
          enabled: prefByKey.get(`${def.key}:${channel}`) ?? true,
        })),
      });
    }
    return { items };
  }

  async update(
    p: Principal,
    input: notification.UpdatePreferencesRequest,
  ): Promise<notification.PreferencesResponse> {
    const fields: Array<{ path: string; message: string }> = [];
    input.preferences.forEach((pref, i) => {
      const def = getTypeDef(pref.type);
      if (!def)
        fields.push({ path: `preferences.${i}.type`, message: 'Unknown notification type' });
      else if (def.mandatory)
        fields.push({
          path: `preferences.${i}.type`,
          message: `${def.label} messages are always sent for account security`,
        });
      else if (!def.channels.includes(pref.channel)) {
        fields.push({
          path: `preferences.${i}.channel`,
          message: `${def.label} is not sent by ${pref.channel === 'email' ? 'email' : 'in-app notification'}`,
        });
      }
    });
    if (fields.length) throw new ValidationError(fields);

    const unique = new Map(input.preferences.map((pref) => [`${pref.type}:${pref.channel}`, pref]));
    await this.db
      .insertInto('notification_preferences')
      .values(
        [...unique.values()].map((pref) => ({
          user_id: p.userId,
          organization_id: p.organizationId,
          type: pref.type,
          channel: pref.channel,
          enabled: pref.enabled,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['user_id', 'type', 'channel']).doUpdateSet((eb) => ({
          enabled: eb.ref('excluded.enabled'),
          updated_at: sql<Date>`now()`,
        })),
      )
      .execute();
    return this.list(p);
  }
}

/** Opted-out (user, channel) pairs for a type among the given users. */
export async function optOuts(
  db: DbOrTrx,
  type: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .selectFrom('notification_preferences')
    .select(['user_id', 'channel'])
    .where('type', '=', type)
    .where('user_id', 'in', [...new Set(userIds)])
    .where('enabled', '=', false)
    .execute();
  return new Set(rows.map((r) => `${r.user_id}:${r.channel as Channel}`));
}
