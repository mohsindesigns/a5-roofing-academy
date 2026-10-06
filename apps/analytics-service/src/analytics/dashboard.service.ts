import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { analytics } from '@a5/contracts';
import { Cache } from '@a5/messaging';
import { ForbiddenError, InjectDb } from '@a5/nest-kit';
import { scopeCovers } from '@a5/permissions';
import { ANALYTICS_CONFIG, type AnalyticsConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { AnalyticsScope } from '../common/scope.service.js';
import { dashboardCacheNamespace } from '../common/settings.service.js';
import { DashboardQueries } from './dashboard.queries.js';
import { LearnerQueries } from './learner.queries.js';
import { QuerySql, ratio, round1, type QueryContext } from './query-context.js';
import { TrendReader, trendWindow } from './trends.js';

type DashboardQuery = analytics.DashboardQuery;

/**
 * Assembles chart-ready dashboard payloads. Results are cached for a short time (60 s by default)
 * per organization, scope and filters; the data behind them is already aggregated.
 */
@Injectable()
export class DashboardService {
  private readonly queries: DashboardQueries;
  private readonly trends: TrendReader;
  private readonly learners: LearnerQueries;

  constructor(
    @InjectDb() db: Db,
    private readonly cache: Cache,
    private readonly scope: AnalyticsScope,
    @Inject(ANALYTICS_CONFIG) private readonly config: AnalyticsConfig,
  ) {
    this.queries = new DashboardQueries(db);
    this.trends = new TrendReader(db);
    this.learners = new LearnerQueries(db);
  }

  private async cached<T>(
    kind: string,
    ctx: QueryContext,
    extra: unknown,
    load: () => Promise<T>,
  ): Promise<T> {
    const s = ctx.scope;
    const scopeKey =
      s.kind === 'managed'
        ? {
            kind: s.kind,
            userId: s.userId,
            teams: [...s.teamIds].sort(),
            users: [...s.userIds].sort(),
          }
        : s.kind === 'own'
          ? { kind: s.kind, userId: s.userId }
          : { kind: s.kind };
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          scope: scopeKey,
          filters: ctx.filters,
          extra,
          settings: ctx.settings,
          minute: Math.floor(ctx.now.getTime() / 60_000),
        }),
      )
      .digest('hex')
      .slice(0, 32);
    const key = await this.cache.versioned(dashboardCacheNamespace(ctx.organizationId), kind, hash);
    return this.cache.getOrSet(key, this.config.analytics.dashboardCacheTtlSeconds, load);
  }

  private meta(ctx: QueryContext): analytics.TeamDashboard['meta'] {
    return {
      generatedAt: ctx.now.toISOString(),
      scope: ctx.scope.kind === 'none' ? 'own' : ctx.scope.kind,
      filters: ctx.filters,
      timezone: ctx.timezone,
    };
  }

  async team(p: Principal, query: DashboardQuery): Promise<analytics.TeamDashboard> {
    const ctx = await this.scope.context(p, 'analytics.view', query);
    return this.cached('team', ctx, { interval: query.interval ?? null }, async () => {
      const q = new QuerySql(ctx);
      const window = trendWindow(q, query.interval);
      const [
        kpis,
        fallingBehind,
        requiringAttention,
        expiringCertifications,
        recentActivity,
        weakestAreas,
        lessons,
        ai,
      ] = await Promise.all([
        this.queries.kpis(q),
        this.queries.fallingBehind(q),
        this.queries.requiringAttention(q),
        this.queries.expiringCertificates(q),
        this.queries.recentActivity(q),
        this.queries.weakestAreas(q),
        this.trends.trend(q, 'lessons_completed', window),
        this.trends.trend(q, 'ai_score', window),
      ]);
      return {
        meta: this.meta(ctx),
        kpis: DashboardQueries.teamKpis(kpis),
        fallingBehind,
        requiringAttention,
        expiringCertifications,
        recentActivity,
        weakestAreas,
        activityTrend: { lessonsCompleted: lessons, aiAverageScore: ai },
      };
    });
  }

  async company(p: Principal, query: DashboardQuery): Promise<analytics.CompanyDashboard> {
    const scope = p.scopeOf('analytics.view');
    if (!scope || !scopeCovers(scope, 'organization')) {
      throw new ForbiddenError(
        'The company dashboard needs organization-wide analytics access. Use the team dashboard instead.',
      );
    }
    const ctx = await this.scope.context(p, 'analytics.view', query);
    return this.cached('company', ctx, { interval: query.interval ?? null }, async () => {
      const q = new QuerySql(ctx);
      const window = trendWindow(q, query.interval);
      const [
        kpis,
        byLocation,
        byTeam,
        dropOffLessons,
        hardestQuestions,
        mostFailedObjections,
        weakestAreas,
        certification,
        aiScoreTrend,
        aiCompetencyTrend,
        lessonsCompleted,
        programsCompleted,
        averageScore,
        failureRate,
      ] = await Promise.all([
        this.queries.kpis(q),
        this.queries.breakdown(q, 'location'),
        this.queries.breakdown(q, 'team'),
        this.queries.dropOffLessons(q),
        this.queries.hardestQuestions(q),
        this.queries.mostFailedObjections(q),
        this.queries.weakestAreas(q),
        this.queries.certification(q),
        this.trends.trend(q, 'ai_score', window),
        this.trends.categoryTrend(q, window),
        this.trends.trend(q, 'lessons_completed', window),
        this.trends.trend(q, 'programs_completed', window),
        this.trends.trend(q, 'assessment_score', window),
        this.trends.trend(q, 'assessment_failure_rate', window),
      ]);
      return {
        meta: this.meta(ctx),
        kpis: {
          ...DashboardQueries.teamKpis(kpis),
          trainingCompletionRate: ratio(kpis.completed, kpis.due_or_done),
          averageCompletionDays: round1(kpis.avg_completion_days),
          overdueEnrollments: Number(kpis.overdue),
          quizFailureRate: ratio(kpis.failed_attempts, kpis.attempts),
          certificationConversion: certification.conversion,
          averageDaysToCertification: certification.averageDays,
          medianDaysToCertification: certification.medianDays,
        },
        breakdowns: { byLocation, byTeam },
        dropOffLessons,
        hardestQuestions,
        mostFailedObjections,
        weakestAreas,
        aiScoreTrend,
        aiCompetencyTrend,
        completionTrend: { lessonsCompleted, programsCompleted },
        assessmentTrend: { averageScore, failureRate },
      };
    });
  }

  async trend(
    p: Principal,
    metric: analytics.TrendMetric,
    query: DashboardQuery,
  ): Promise<analytics.Trend & { metric: analytics.TrendMetric }> {
    const ctx = await this.scope.context(p, 'analytics.view', query);
    return this.cached(`trend:${metric}`, ctx, { interval: query.interval ?? null }, async () => {
      const q = new QuerySql(ctx);
      return { metric, ...(await this.trends.trend(q, metric, trendWindow(q, query.interval))) };
    });
  }

  /** Own learning summary (self-service). */
  async mySummary(p: Principal, programId: string | undefined): Promise<analytics.LearnerSummary> {
    return this.learners.summary({
      organizationId: p.organizationId,
      userId: p.userId,
      programId,
      now: this.scope.now(),
      timezone: this.scope.timezone,
      minCohortSize: (
        await this.scope.build(p.organizationId, { kind: 'own', userId: p.userId }, {})
      ).settings.minCohortSize,
    });
  }

  /** A learner's summary for a manager, trainer or administrator (scoped; 404 when out of scope). */
  async learnerSummary(
    p: Principal,
    userId: string,
    programId: string | undefined,
  ): Promise<analytics.LearnerSummary> {
    await this.scope.assertLearnerVisible(p, 'analytics.view', userId);
    const ctx = await this.scope.build(p.organizationId, p.scopeFilter('analytics.view'), {});
    return this.learners.summary({
      organizationId: p.organizationId,
      userId,
      programId,
      now: ctx.now,
      timezone: ctx.timezone,
      minCohortSize: ctx.settings.minCohortSize,
    });
  }
}
