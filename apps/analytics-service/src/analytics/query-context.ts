import type { ScopeFilter } from '@a5/auth';
import type { analytics } from '@a5/contracts';
import { sql, type Expression, type SqlBool } from '@a5/database';
import { userScopeCondition } from '@a5/directory';
import type { RawBuilder } from 'kysely';

export type AnalyticsFilters = analytics.AnalyticsFilters;
export type AnalyticsSettings = analytics.AnalyticsSettings;

/** Everything a dashboard, report or export query needs to know about the caller and request. */
export interface QueryContext {
  organizationId: string;
  scope: ScopeFilter;
  filters: AnalyticsFilters;
  now: Date;
  timezone: string;
  settings: AnalyticsSettings;
}

type SqlExpr = RawBuilder<unknown> | Expression<unknown>;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export function and(parts: Array<RawBuilder<SqlBool> | Expression<SqlBool>>): RawBuilder<SqlBool> {
  if (parts.length === 0) return sql<SqlBool>`true`;
  return sql<SqlBool>`(${sql.join(parts, sql` and `)})`;
}

function toExpr(target: string | SqlExpr): SqlExpr {
  return typeof target === 'string' ? sql.ref(target) : target;
}

/**
 * Builds SQL fragments for the caller's data scope and the request filters. Filters only ever
 * add conditions on top of the scope, so they cannot widen what the caller may see.
 */
export class QuerySql {
  constructor(readonly ctx: QueryContext) {}

  get org(): string {
    return this.ctx.organizationId;
  }

  get now(): Date {
    return this.ctx.now;
  }

  get tz(): string {
    return this.ctx.timezone;
  }

  /**
   * People restriction on a user id column: data scope (via `userScopeCondition`), people filters
   * and, unless disabled, the program population (people enrolled in the filtered program).
   */
  people(
    userColumn: string,
    orgColumn: string,
    { programPopulation = true }: { programPopulation?: boolean } = {},
  ): RawBuilder<SqlBool> {
    const { scope, filters: f } = this.ctx;
    const user = sql.ref(userColumn);
    const parts: Array<RawBuilder<SqlBool> | Expression<SqlBool>> = [
      userScopeCondition(scope, { userColumn, orgColumn }),
    ];
    if (scope.kind === 'managed') {
      // Managed scope covers managed teams and direct reports, not the manager's own learning.
      const teams = scope.teamIds.length ? scope.teamIds : [NIL_UUID];
      parts.push(
        sql<SqlBool>`(${user} <> ${scope.userId} or ${user} in (select user_id from dir_user_teams where team_id = any(${sql.val(teams)}::uuid[])))`,
      );
    }
    if (f.teamId)
      parts.push(
        sql<SqlBool>`${user} in (select user_id from dir_user_teams where team_id = ${f.teamId})`,
      );
    if (f.managerId) {
      parts.push(sql<SqlBool>`${user} in (
        select ut.user_id from dir_user_teams ut join dir_team_managers tm on tm.team_id = ut.team_id where tm.user_id = ${f.managerId}
        union
        select s.user_id from dir_user_supervisors s where s.supervisor_id = ${f.managerId} and s.kind = 'manager'
      )`);
    }
    if (f.departmentId)
      parts.push(
        sql<SqlBool>`${user} in (select id from dir_users where department_id = ${f.departmentId})`,
      );
    if (f.locationId)
      parts.push(
        sql<SqlBool>`${user} in (select id from dir_users where location_id = ${f.locationId})`,
      );
    if (f.userId) parts.push(sql<SqlBool>`${user} = ${f.userId}`);
    if (programPopulation && f.programId) {
      parts.push(
        sql<SqlBool>`${user} in (select user_id from fact_enrollments where organization_id = ${this.org} and program_id = ${f.programId})`,
      );
    }
    return and(parts);
  }

  /**
   * Active learners in view: active directory users admitted by scope and filters who belong to a
   * team or have an enrollment.
   */
  population(): RawBuilder<unknown> {
    return sql`
      select u.id as user_id, u.display_name
      from dir_users u
      where u.organization_id = ${this.org}
        and u.status = 'active'
        and ${this.people('u.id', 'u.organization_id')}
        and (exists (select 1 from dir_user_teams t where t.user_id = u.id)
             or exists (select 1 from fact_enrollments e where e.user_id = u.id and e.organization_id = ${this.org}))
    `;
  }

  /** Lower bound (inclusive) of the date filter as a timestamptz, or null. */
  private lower(): RawBuilder<Date> | null {
    const from = this.ctx.filters.from;
    return from ? sql<Date>`(${from}::date::timestamp at time zone ${this.tz})` : null;
  }

  /** Upper bound (exclusive) of the date filter as a timestamptz, or null. */
  private upper(): RawBuilder<Date> | null {
    const to = this.ctx.filters.to;
    return to ? sql<Date>`((${to}::date + 1)::timestamp at time zone ${this.tz})` : null;
  }

  get hasRange(): boolean {
    return Boolean(this.ctx.filters.from || this.ctx.filters.to);
  }

  /** Date filter on a timestamp expression. */
  range(target: string | SqlExpr): RawBuilder<SqlBool> {
    const expr = toExpr(target);
    const parts: RawBuilder<SqlBool>[] = [];
    const lo = this.lower();
    const hi = this.upper();
    if (lo) parts.push(sql<SqlBool>`${expr} >= ${lo}`);
    if (hi) parts.push(sql<SqlBool>`${expr} < ${hi}`);
    return and(parts);
  }

  /** Date filter, or "since `fallbackFrom`" when no date filter is given (e.g. attention look-back). */
  rangeOr(target: string | SqlExpr, fallbackFrom: Date): RawBuilder<SqlBool> {
    if (this.hasRange) return this.range(target);
    return sql<SqlBool>`${toExpr(target)} >= ${fallbackFrom}::timestamptz`;
  }

  program(column: string): RawBuilder<SqlBool> {
    const p = this.ctx.filters.programId;
    return p ? sql<SqlBool>`${sql.ref(column)} = ${p}` : sql<SqlBool>`true`;
  }

  /** Program filter for assessment facts: attempt context or the assessment's program. */
  programAssessment(programColumn: string, assessmentColumn: string): RawBuilder<SqlBool> {
    const p = this.ctx.filters.programId;
    if (!p) return sql<SqlBool>`true`;
    return sql<SqlBool>`(${sql.ref(programColumn)} = ${p} or ${sql.ref(assessmentColumn)} in (select id from dim_assessments where program_id = ${p}))`;
  }

  certification(column: string): RawBuilder<SqlBool> {
    const c = this.ctx.filters.certificationId;
    return c ? sql<SqlBool>`${sql.ref(column)} = ${c}` : sql<SqlBool>`true`;
  }
}

// ------------------------------------------------------------------ value helpers

export function round1(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Math.round(Number(value) * 10) / 10;
}

export function ratio(numerator: number, denominator: number): analytics.Ratio {
  return {
    numerator: Number(numerator),
    denominator: Number(denominator),
    percent:
      Number(denominator) > 0 ? round1((Number(numerator) / Number(denominator)) * 100) : null,
  };
}

export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function isoRequired(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
