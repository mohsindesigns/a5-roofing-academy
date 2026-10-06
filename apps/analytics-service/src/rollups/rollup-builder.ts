import { sql } from '@a5/database';
import type { Db } from '../database/index.js';

export interface RollupRange {
  organizationId: string;
  /** Inclusive calendar dates (YYYY-MM-DD) in the reporting time zone. */
  from: string;
  to: string;
  timezone: string;
}

/**
 * Metrics written to `daily_rollups`. Counts are stored with `sample_count = value`; averages
 * store the mean in `value` and the number of samples in `sample_count`, so buckets can be
 * recombined as weighted means. `assessment_failed` stores failures in `value` and attempts in
 * `sample_count` (failure rate = value / sample_count). `ai_category_score:<key>` holds one
 * metric per rubric category. `active_learners` counts distinct learners with activity that day.
 */
export const ROLLUP_METRICS = [
  'enrollments_started',
  'lessons_completed',
  'programs_completed',
  'assessment_attempts',
  'assessment_failed',
  'assessment_score',
  'ai_sessions',
  'ai_score',
  'certificates_issued',
  'active_learners',
] as const;

export const DIMENSION_TYPES = ['organization', 'team', 'location', 'department', 'user'] as const;
export type DimensionType = (typeof DIMENSION_TYPES)[number];

/**
 * Recompute rollups for an organization and an inclusive date range in one transaction (readers
 * never see a partially rebuilt day). A transaction-scoped advisory lock serialises concurrent
 * rebuilds of the same organization.
 */
export async function refreshRollups(db: Db, range: RollupRange): Promise<number> {
  const { organizationId: org, from, to, timezone: tz } = range;
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`analytics.rollup:${org}`}))`.execute(trx);
    await trx
      .deleteFrom('daily_rollups')
      .where('organization_id', '=', org)
      .where('date', '>=', from)
      .where('date', '<=', to)
      .execute();
    const result = await sql`
      with bounds as (
        select (${from}::date::timestamp at time zone ${tz}) as lo,
               ((${to}::date + 1)::timestamp at time zone ${tz}) as hi
      ),
      samples as (
        select f.user_id, (f.completed_at at time zone ${tz})::date as d, 'lessons_completed'::text as metric, 'sum'::text as agg, 1::numeric as v
          from fact_lesson_events f, bounds b
          where f.organization_id = ${org} and f.completed_at >= b.lo and f.completed_at < b.hi
        union all
        select e.user_id, (coalesce(e.enrolled_at, e.first_seen_at) at time zone ${tz})::date, 'enrollments_started', 'sum', 1
          from fact_enrollments e, bounds b
          where e.organization_id = ${org} and coalesce(e.enrolled_at, e.first_seen_at) >= b.lo and coalesce(e.enrolled_at, e.first_seen_at) < b.hi
        union all
        select e.user_id, (e.completed_at at time zone ${tz})::date, 'programs_completed', 'sum', 1
          from fact_enrollments e, bounds b
          where e.organization_id = ${org} and e.completed_at >= b.lo and e.completed_at < b.hi
        union all
        select a.user_id, (a.graded_at at time zone ${tz})::date, m.metric, m.agg,
               case m.metric when 'assessment_attempts' then 1 when 'assessment_failed' then (not a.passed)::int else a.score_percent end
          from fact_assessment_attempts a, bounds b,
               (values ('assessment_attempts', 'sum'), ('assessment_failed', 'sum'), ('assessment_score', 'avg')) as m(metric, agg)
          where a.organization_id = ${org} and a.kind <> 'practice' and a.graded_at >= b.lo and a.graded_at < b.hi
        union all
        select s.user_id, (s.evaluated_at at time zone ${tz})::date, m.metric, m.agg,
               case m.metric when 'ai_sessions' then 1 else s.overall_score end
          from fact_ai_sessions s, bounds b,
               (values ('ai_sessions', 'sum'), ('ai_score', 'avg')) as m(metric, agg)
          where s.organization_id = ${org} and s.evaluated_at >= b.lo and s.evaluated_at < b.hi
        union all
        select c.user_id, (c.evaluated_at at time zone ${tz})::date, 'ai_category_score:' || c.category_key, 'avg', c.score
          from fact_ai_category_scores c, bounds b
          where c.organization_id = ${org} and c.evaluated_at >= b.lo and c.evaluated_at < b.hi
        union all
        select c.user_id, (c.issued_at at time zone ${tz})::date, 'certificates_issued', 'sum', 1
          from fact_certificates c, bounds b
          where c.organization_id = ${org} and c.issued_at >= b.lo and c.issued_at < b.hi
        union all
        select x.user_id, (x.at at time zone ${tz})::date, 'active_learners', 'distinct', 1
          from (
            select f.user_id, f.started_at as at from fact_lesson_events f where f.organization_id = ${org}
            union all select f.user_id, f.completed_at from fact_lesson_events f where f.organization_id = ${org}
            union all select a.user_id, a.graded_at from fact_assessment_attempts a where a.organization_id = ${org}
            union all select s.user_id, s.evaluated_at from fact_ai_sessions s where s.organization_id = ${org}
          ) x, bounds b
          where x.at >= b.lo and x.at < b.hi
      ),
      dims as (
        select s.*, 'organization'::text as dimension_type, ${org}::text as dimension_id from samples s
        union all
        select s.*, 'user', s.user_id::text from samples s
        union all
        select s.*, 'team', t.team_id::text from samples s join dir_user_teams t on t.user_id = s.user_id
        union all
        select s.*, 'location', u.location_id::text from samples s join dir_users u on u.id = s.user_id where u.location_id is not null
        union all
        select s.*, 'department', u.department_id::text from samples s join dir_users u on u.id = s.user_id where u.department_id is not null
      )
      insert into daily_rollups (organization_id, date, metric, dimension_type, dimension_id, value, sample_count)
      select ${org}::uuid, d, metric, dimension_type, dimension_id,
             case agg when 'avg' then avg(v) when 'distinct' then count(distinct user_id) else sum(v) end,
             case agg when 'distinct' then count(distinct user_id) else count(*) end
      from dims
      group by d, metric, agg, dimension_type, dimension_id
    `.execute(trx);
    return Number(result.numAffectedRows ?? 0n);
  });
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Group sorted calendar dates into contiguous inclusive ranges. */
export function contiguousRanges(dates: string[]): Array<{ from: string; to: string }> {
  const sorted = [...new Set(dates)].sort();
  const ranges: Array<{ from: string; to: string }> = [];
  for (const date of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && addDays(last.to, 1) === date) last.to = date;
    else ranges.push({ from: date, to: date });
  }
  return ranges;
}

/**
 * Claim and rebuild days flagged by the fact writers. Claimed rows are deleted up front (SKIP
 * LOCKED, so parallel workers split the work); marks written while we rebuild create new rows and
 * are picked up by the next run. On failure the claimed days are flagged again.
 */
export async function processDirtyDays(
  db: Db,
  timezone: string,
  limit = 2_000,
): Promise<{ days: number; rows: number }> {
  const claimed = await sql<{ organization_id: string; date: string }>`
    delete from rollup_dirty_days d
    using (
      select organization_id, date from rollup_dirty_days
      order by organization_id, date
      limit ${limit}
      for update skip locked
    ) c
    where d.organization_id = c.organization_id and d.date = c.date
    returning d.organization_id, d.date::text as date
  `.execute(db);
  const byOrg = new Map<string, string[]>();
  for (const r of claimed.rows)
    byOrg.set(r.organization_id, [...(byOrg.get(r.organization_id) ?? []), r.date]);
  let rows = 0;
  try {
    for (const [org, dates] of byOrg) {
      for (const range of contiguousRanges(dates)) {
        rows += await refreshRollups(db, { organizationId: org, timezone, ...range });
      }
    }
  } catch (err) {
    if (claimed.rows.length) {
      await db
        .insertInto('rollup_dirty_days')
        .values(claimed.rows.map((r) => ({ organization_id: r.organization_id, date: r.date })))
        .onConflict((oc) => oc.columns(['organization_id', 'date']).doNothing())
        .execute();
    }
    throw err;
  }
  return { days: claimed.rows.length, rows };
}

/** Organizations that have any analytics data. */
export async function analyticsOrganizations(db: Db): Promise<string[]> {
  const rows = await sql<{ organization_id: string }>`
    select organization_id from dir_users
    union select organization_id from fact_enrollments
    union select organization_id from fact_ai_sessions
    union select organization_id from fact_assessment_attempts
  `.execute(db);
  return rows.rows.map((r) => r.organization_id);
}

/** Calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export { addDays };
