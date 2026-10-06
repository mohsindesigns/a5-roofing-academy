import type { analytics } from '@a5/contracts';
import { sql, type SqlBool } from '@a5/database';
import type { RawBuilder } from 'kysely';
import type { Db } from '../database/index.js';
import { addDays, localDate } from '../rollups/rollup-builder.js';
import { round1, type QuerySql } from './query-context.js';

type Interval = analytics.TrendInterval;
type Agg = 'sum' | 'avg' | 'rate' | 'distinct';

export interface TrendWindow {
  from: string;
  to: string;
  interval: Interval;
}

export interface CategoryTrend extends TrendWindow {
  series: Array<{ key: string; label: string; points: analytics.TrendPoint[] }>;
}

/** Rollup metric and aggregation behind each public trend metric. */
export const TREND_METRICS: Record<analytics.TrendMetric, { metric: string; agg: Agg }> = {
  lessons_completed: { metric: 'lessons_completed', agg: 'sum' },
  enrollments_started: { metric: 'enrollments_started', agg: 'sum' },
  programs_completed: { metric: 'programs_completed', agg: 'sum' },
  assessment_attempts: { metric: 'assessment_attempts', agg: 'sum' },
  assessment_score: { metric: 'assessment_score', agg: 'avg' },
  assessment_failure_rate: { metric: 'assessment_failed', agg: 'rate' },
  ai_sessions: { metric: 'ai_sessions', agg: 'sum' },
  ai_score: { metric: 'ai_score', agg: 'avg' },
  certificates_issued: { metric: 'certificates_issued', agg: 'sum' },
  active_learners: { metric: 'active_learners', agg: 'distinct' },
};

const DEFAULT_TREND_DAYS = 84;

function spanDays(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

/** Trend window: the filter range, or the last 12 weeks; interval chosen to keep charts readable. */
export function trendWindow(q: QuerySql, requested?: Interval): TrendWindow {
  const f = q.ctx.filters;
  const to = f.to ?? localDate(q.now, q.tz);
  const from = f.from ?? addDays(to, -(DEFAULT_TREND_DAYS - 1));
  const span = spanDays(from, to);
  let interval: Interval = requested ?? (span <= 31 ? 'day' : span <= 366 ? 'week' : 'month');
  if (interval === 'day' && span > 366) interval = 'week';
  return { from, to, interval };
}

/** Bucket start for a calendar date, matching PostgreSQL date_trunc (ISO weeks start on Monday). */
export function bucketStart(date: string, interval: Interval): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (interval === 'week') {
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
  } else if (interval === 'month') {
    d.setUTCDate(1);
  }
  return d.toISOString().slice(0, 10);
}

export function buckets(window: TrendWindow): string[] {
  const out: string[] = [];
  let cursor = bucketStart(window.from, window.interval);
  while (cursor <= window.to) {
    out.push(cursor);
    if (window.interval === 'day') cursor = addDays(cursor, 1);
    else if (window.interval === 'week') cursor = addDays(cursor, 7);
    else {
      const d = new Date(`${cursor}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + 1);
      cursor = d.toISOString().slice(0, 10);
    }
  }
  return out;
}

interface BucketRow {
  metric: string;
  bucket: string;
  sum_value: number;
  weighted: number;
  samples: number;
  distinct_dims: number;
}

/**
 * Reads trend series from `daily_rollups`. Organization-wide views use the organization grain; a
 * single team/location/department filter uses that grain; everything narrower (managed scope,
 * manager, employee or program filters, combinations) aggregates the per-user grain restricted
 * by the same scope and filter conditions as the dashboards.
 */
export class TrendReader {
  constructor(private readonly db: Db) {}

  private grain(q: QuerySql, agg: Agg): RawBuilder<SqlBool> {
    const { scope, filters: f } = q.ctx;
    const orgWide = scope.kind === 'organization' || scope.kind === 'platform';
    const userLevel = Boolean(f.managerId || f.userId || f.programId);
    const single = [
      f.teamId ? (['team', f.teamId] as const) : null,
      f.locationId ? (['location', f.locationId] as const) : null,
      f.departmentId ? (['department', f.departmentId] as const) : null,
    ].filter((g) => g !== null);
    if (orgWide && !userLevel && agg !== 'distinct') {
      if (single.length === 0)
        return sql<SqlBool>`r.dimension_type = 'organization' and r.dimension_id = ${q.org}`;
      if (single.length === 1) {
        const [type, id] = single[0]!;
        return sql<SqlBool>`r.dimension_type = ${type} and r.dimension_id = ${id}`;
      }
    }
    return sql<SqlBool>`r.dimension_type = 'user' and r.dimension_id in (
      select x.user_id::text from (
        select id as user_id, organization_id from dir_users
        union
        select user_id, organization_id from learner_activity
      ) x
      where x.organization_id = ${q.org} and ${q.people('x.user_id', 'x.organization_id')}
    )`;
  }

  private async rows(
    q: QuerySql,
    metricCondition: RawBuilder<SqlBool>,
    agg: Agg,
    window: TrendWindow,
  ): Promise<BucketRow[]> {
    const result = await sql<BucketRow>`
      select r.metric,
             date_trunc(${window.interval}, r.date::timestamp)::date::text as bucket,
             sum(r.value) as sum_value,
             sum(r.value * r.sample_count) as weighted,
             sum(r.sample_count) as samples,
             count(distinct r.dimension_id) filter (where r.value > 0) as distinct_dims
      from daily_rollups r
      where r.organization_id = ${q.org}
        and ${metricCondition}
        and ${this.grain(q, agg)}
        and r.date >= ${window.from}::date and r.date <= ${window.to}::date
      group by r.metric, bucket
    `.execute(this.db);
    return result.rows;
  }

  private point(row: BucketRow | undefined, agg: Agg): { value: number | null; count: number } {
    if (!row) return { value: agg === 'sum' || agg === 'distinct' ? 0 : null, count: 0 };
    const samples = Number(row.samples);
    switch (agg) {
      case 'sum':
        return { value: Number(row.sum_value), count: samples };
      case 'avg':
        return {
          value: samples > 0 ? round1(Number(row.weighted) / samples) : null,
          count: samples,
        };
      case 'rate':
        return {
          value: samples > 0 ? round1((Number(row.sum_value) / samples) * 100) : null,
          count: samples,
        };
      case 'distinct':
        return { value: Number(row.distinct_dims), count: Number(row.distinct_dims) };
    }
  }

  async trend(
    q: QuerySql,
    metric: analytics.TrendMetric,
    window: TrendWindow,
  ): Promise<analytics.Trend> {
    const def = TREND_METRICS[metric];
    const rows = await this.rows(q, sql<SqlBool>`r.metric = ${def.metric}`, def.agg, window);
    const byBucket = new Map(rows.map((r) => [r.bucket, r]));
    return {
      interval: window.interval,
      from: window.from,
      to: window.to,
      points: buckets(window).map((date) => ({ date, ...this.point(byBucket.get(date), def.agg) })),
    };
  }

  /** One weighted-average series per AI rubric category. */
  async categoryTrend(q: QuerySql, window: TrendWindow): Promise<CategoryTrend> {
    const rows = await this.rows(
      q,
      sql<SqlBool>`starts_with(r.metric, 'ai_category_score:')`,
      'avg',
      window,
    );
    const labels = await sql<{ category_key: string; category_label: string }>`
      select distinct on (category_key) category_key, category_label
      from fact_ai_category_scores
      where organization_id = ${q.org}
      order by category_key, evaluated_at desc
    `.execute(this.db);
    const labelOf = new Map(labels.rows.map((r) => [r.category_key, r.category_label]));
    const byMetric = new Map<string, Map<string, BucketRow>>();
    for (const r of rows) {
      const key = r.metric.slice('ai_category_score:'.length);
      if (!byMetric.has(key)) byMetric.set(key, new Map());
      byMetric.get(key)!.set(r.bucket, r);
    }
    const list = buckets(window);
    const series = [...byMetric.entries()]
      .map(([key, map]) => ({
        key,
        label: labelOf.get(key) ?? key,
        points: list.map((date) => ({ date, ...this.point(map.get(date), 'avg') })),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return { interval: window.interval, from: window.from, to: window.to, series };
  }
}
