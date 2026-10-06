import { Inject, Injectable } from '@nestjs/common';
import type { Principal, ScopeFilter } from '@a5/auth';
import { sql } from '@a5/database';
import { userScopeCondition } from '@a5/directory';
import { ForbiddenError, InjectDb, NotFoundError } from '@a5/nest-kit';
import type { PermissionKey } from '@a5/permissions';
import { ANALYTICS_CONFIG, type AnalyticsConfig } from '../config.js';
import type { Db } from '../database/index.js';
import type { AnalyticsFilters, QueryContext } from '../analytics/query-context.js';
import { AnalyticsClock } from './clock.js';
import { SettingsService } from './settings.service.js';

const FILTER_KEYS = [
  'from',
  'to',
  'programId',
  'certificationId',
  'teamId',
  'managerId',
  'departmentId',
  'locationId',
  'userId',
] as const;

/** Keep only known, defined filter keys (stable cache keys and stored export filters). */
export function cleanFilters(input: Partial<Record<string, unknown>>): AnalyticsFilters {
  const out: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out as AnalyticsFilters;
}

/**
 * Turns a principal and request filters into a query context. Filters are checked against the
 * caller's scope so a manager gets a clear 403 instead of silently empty results, and the SQL
 * layer additionally ANDs every filter with the scope condition.
 */
@Injectable()
export class AnalyticsScope {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(ANALYTICS_CONFIG) private readonly config: AnalyticsConfig,
    private readonly settings: SettingsService,
    private readonly clock: AnalyticsClock,
  ) {}

  now(): Date {
    return this.clock.now();
  }

  get timezone(): string {
    return this.config.analytics.timezone;
  }

  async context(
    p: Principal,
    permission: PermissionKey,
    filters: Partial<Record<string, unknown>>,
  ): Promise<QueryContext> {
    const scope = p.scopeFilter(permission);
    if (scope.kind === 'none') throw new ForbiddenError();
    const clean = cleanFilters(filters);
    await this.assertFilters(p, scope, clean);
    return this.build(p.organizationId, scope, clean);
  }

  /** Context for a stored request (export jobs run later with the scope captured at request time). */
  async build(
    organizationId: string,
    scope: ScopeFilter,
    filters: AnalyticsFilters,
  ): Promise<QueryContext> {
    const { settings } = await this.settings.get(organizationId);
    return {
      organizationId,
      scope,
      filters,
      now: this.clock.now(),
      timezone: this.config.analytics.timezone,
      settings,
    };
  }

  private async assertFilters(
    p: Principal,
    scope: ScopeFilter,
    f: AnalyticsFilters,
  ): Promise<void> {
    if (scope.kind === 'organization' || scope.kind === 'platform') return;
    if (f.teamId && (scope.kind !== 'managed' || !scope.teamIds.includes(f.teamId))) {
      throw new ForbiddenError('You can only filter by teams you manage.');
    }
    if (f.userId && !(await this.admits(p, scope, f.userId))) {
      throw new ForbiddenError('You can only filter by people in your teams.');
    }
    if (f.managerId && scope.kind === 'own' && f.managerId !== p.userId) {
      throw new ForbiddenError('You can only view your own analytics.');
    }
  }

  private async admits(p: Principal, scope: ScopeFilter, userId: string): Promise<boolean> {
    if (scope.kind === 'own') return userId === p.userId;
    const row = await sql<{ ok: number }>`
      select 1 as ok from (
        select id as user_id, organization_id from dir_users
        union select user_id, organization_id from learner_activity
        union select user_id, organization_id from fact_enrollments
      ) x
      where x.user_id = ${userId} and x.organization_id = ${p.organizationId}
        and ${userScopeCondition(scope, { userColumn: 'x.user_id', orgColumn: 'x.organization_id' })}
      limit 1
    `.execute(this.db);
    return row.rows.length > 0;
  }

  /** 404 unless the learner is visible to the caller under `permission`. */
  async assertLearnerVisible(
    p: Principal,
    permission: PermissionKey,
    userId: string,
  ): Promise<void> {
    const scope = p.scopeFilter(permission);
    if (scope.kind === 'none') throw new ForbiddenError();
    if (!(await this.admits(p, scope, userId))) throw new NotFoundError('Learner');
  }
}
