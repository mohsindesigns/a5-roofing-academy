import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { analytics } from '@a5/contracts';
import { sql } from '@a5/database';
import { Cache } from '@a5/messaging';
import { EventBus, InjectDb } from '@a5/nest-kit';
import type { Db } from '../database/index.js';

export type AnalyticsSettings = analytics.AnalyticsSettings;

export function dashboardCacheNamespace(organizationId: string): string {
  return `anl:dash:${organizationId}`;
}

/**
 * Per-organization analytics thresholds (inactivity, pace tolerance, low AI score, cohort size…).
 * Stored as a validated JSON document; missing keys fall back to the documented defaults.
 */
@Injectable()
export class SettingsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    private readonly cache: Cache,
  ) {}

  static resolve(config: unknown): AnalyticsSettings {
    const parsed = analytics.analyticsSettingsSchema.partial().safeParse(config ?? {});
    return { ...analytics.DEFAULT_ANALYTICS_SETTINGS, ...(parsed.success ? parsed.data : {}) };
  }

  async get(organizationId: string): Promise<{ settings: AnalyticsSettings; updatedAt: string | null }> {
    const row = await this.db
      .selectFrom('analytics_settings')
      .select(['config', 'updated_at'])
      .where('organization_id', '=', organizationId)
      .executeTakeFirst();
    return { settings: SettingsService.resolve(row?.config), updatedAt: row ? row.updated_at.toISOString() : null };
  }

  async update(
    actor: Principal,
    patch: Partial<AnalyticsSettings>,
  ): Promise<{ settings: AnalyticsSettings; updatedAt: string | null }> {
    const org = actor.organizationId;
    await this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('analytics_settings')
        .select('config')
        .where('organization_id', '=', org)
        .forUpdate()
        .executeTakeFirst();
      const before = SettingsService.resolve(existing?.config);
      const after = analytics.analyticsSettingsSchema.parse({ ...before, ...patch });
      await trx
        .insertInto('analytics_settings')
        .values({ organization_id: org, config: after, updated_by: actor.userId })
        .onConflict((oc) => oc.column('organization_id').doUpdateSet({ config: sql`excluded.config`, updated_by: actor.userId }))
        .execute();
      await this.events.audit(trx, {
        action: 'analytics.settings.updated',
        resourceType: 'analytics_settings',
        resourceId: org,
        actorDisplay: actor.displayName,
        before,
        after,
      });
    });
    await this.cache.bump(dashboardCacheNamespace(org));
    return this.get(org);
  }
}
