import type { ReactNode } from 'react';
import type { analytics } from '@a5/contracts';
import { StatTile } from '@/components/charts';
import { ErrorState, Notice, Section, Skeleton } from '@/components/ui';
import { usePermissions } from '@/features/auth/session';
import {
  AttentionList,
  BreakdownBars,
  DropOffTable,
  ExpiringCertificates,
  FailedObjections,
  FallingBehindList,
  FunnelPanel,
  HardestQuestions,
  KpiStrip,
  TrendChart,
  WeakestAreas,
  companyKpiItems,
  hasTrendData,
  teamKpiItems,
  trendSeries,
} from '@/features/analytics/panels';
import { useCompanyDashboard, useTeamDashboard } from '@/features/analytics/api';
import { formatDays, formatRatio } from '@/features/analytics/funnel';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime, pluralize } from '@/lib/format';

const pct = (n: number) => `${Math.round(n)}%`;

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-text-secondary">{children}</p>;
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-x-10 gap-y-2 lg:grid-cols-2">{children}</div>;
}

function Generated({ meta }: { meta: analytics.TeamDashboard['meta'] }) {
  return (
    <p className="mb-4 text-xs text-text-tertiary">
      {meta.scope === 'organization' || meta.scope === 'platform'
        ? 'Everyone in the organization'
        : meta.scope === 'managed'
          ? 'People on the teams you manage'
          : 'Your own records'}
      {' · '}updated {formatDateTime(meta.generatedAt)} · dates in {meta.timezone}
    </p>
  );
}

function Loading() {
  return (
    <div className="grid gap-6" aria-busy="true" aria-label="Loading dashboard">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

/** Organization-wide dashboards: funnel, certification speed, assessments, AI practice, stalls. */
function CompanyOverview({ filters }: { filters: analytics.AnalyticsFilters }) {
  const dash = useCompanyDashboard(filters);
  if (dash.isPending) return <Loading />;
  if (dash.isError)
    return <ErrorState message={errorMessage(dash.error)} onRetry={() => dash.refetch()} />;
  const d = dash.data;
  const k = d.kpis;
  return (
    <div aria-busy={dash.isFetching}>
      <Generated meta={d.meta} />
      <KpiStrip items={companyKpiItems(k)} />

      <div className="mt-8" />
      <Grid>
        <Section title="Completion funnel" description="From enrollment to certification.">
          <FunnelPanel kpis={k} />
        </Section>
        <Section
          title="Time to certification"
          description="Days from enrollment to an issued certificate."
        >
          <div className="grid grid-cols-3 gap-4">
            <StatTile label="Average" value={formatDays(k.averageDaysToCertification)} />
            <StatTile label="Median" value={formatDays(k.medianDaysToCertification)} />
            <StatTile
              label="Conversion"
              value={formatRatio(k.certificationConversion)}
              context={`${k.certificationConversion.numerator} of ${k.certificationConversion.denominator}`}
            />
          </div>
          <div className="mt-5">
            {hasTrendData(d.completionTrend.programsCompleted) ? (
              <TrendChart
                ariaLabel="Programs completed over time"
                series={[
                  trendSeries(
                    'programs',
                    'Programs completed',
                    d.completionTrend.programsCompleted,
                  ),
                ]}
                formatY={(n) => `${Math.round(n)}`}
              />
            ) : (
              <Empty>No programs were completed in this period.</Empty>
            )}
          </div>
        </Section>
      </Grid>

      <Grid>
        <Section
          title="Assessment pass rates"
          description="Graded quizzes and exams, practice attempts excluded."
        >
          <div className="grid grid-cols-3 gap-4">
            <StatTile
              label="Pass rate"
              value={
                k.quizFailureRate.percent === null ? '—' : pct(100 - k.quizFailureRate.percent)
              }
              context={`${k.quizFailureRate.denominator - k.quizFailureRate.numerator} of ${k.quizFailureRate.denominator} attempts`}
            />
            <StatTile
              label="Average score"
              value={k.averageAssessmentScore === null ? '—' : pct(k.averageAssessmentScore)}
            />
            <StatTile label="Attempts" value={k.assessmentAttempts.toLocaleString()} />
          </div>
          <div className="mt-5">
            {hasTrendData(d.assessmentTrend.averageScore) ? (
              <TrendChart
                ariaLabel="Assessment score and failure rate over time"
                yDomain={[0, 100]}
                formatY={pct}
                series={[
                  trendSeries('score', 'Average score', d.assessmentTrend.averageScore),
                  trendSeries('failure', 'Failure rate', d.assessmentTrend.failureRate),
                ]}
              />
            ) : (
              <Empty>No assessments were graded in this period.</Empty>
            )}
          </div>
        </Section>
        <Section
          title="AI practice scores"
          description="Evaluated role-play sessions, test runs excluded."
        >
          <div className="grid grid-cols-2 gap-4">
            <StatTile
              label="Average score"
              value={k.aiRolePlayAverage === null ? '—' : Math.round(k.aiRolePlayAverage)}
            />
            <StatTile label="Sessions" value={k.aiSessions.toLocaleString()} />
          </div>
          <div className="mt-5">
            {hasTrendData(d.aiScoreTrend) ? (
              <TrendChart
                ariaLabel="AI role-play average score over time"
                yDomain={[0, 100]}
                series={[trendSeries('ai', 'Average score', d.aiScoreTrend)]}
              />
            ) : (
              <Empty>No AI role-plays were scored in this period.</Empty>
            )}
          </div>
        </Section>
      </Grid>

      <Section title="Weak spots" description="Where learners lose the most points.">
        <WeakestAreas data={d.weakestAreas} />
      </Section>

      <Grid>
        <Section title="Hardest quiz questions">
          <HardestQuestions rows={d.hardestQuestions} />
        </Section>
        <Section title="Hardest AI objections">
          <FailedObjections rows={d.mostFailedObjections} />
        </Section>
      </Grid>

      <Section
        title="Where learners stall"
        description="Lessons with the longest average time between one completion and the next. Video watch time is not part of the analytics data yet."
      >
        <DropOffTable rows={d.dropOffLessons} />
      </Section>

      <Grid>
        <Section title="Completion by team">
          <BreakdownBars rows={d.breakdowns.byTeam} noun="team" />
        </Section>
        <Section title="Completion by location">
          <BreakdownBars rows={d.breakdowns.byLocation} noun="location" />
        </Section>
      </Grid>
    </div>
  );
}

/** Dashboards for managers and trainers: the same questions, limited to their people. */
function TeamOverview({ filters }: { filters: analytics.AnalyticsFilters }) {
  const dash = useTeamDashboard(filters);
  if (dash.isPending) return <Loading />;
  if (dash.isError)
    return <ErrorState message={errorMessage(dash.error)} onRetry={() => dash.refetch()} />;
  const d = dash.data;
  const k = d.kpis;
  return (
    <div aria-busy={dash.isFetching}>
      <Generated meta={d.meta} />
      <KpiStrip items={teamKpiItems(k)} />
      <div className="mt-8" />
      <Grid>
        <Section title="Completion funnel" description="From enrollment to certification.">
          <FunnelPanel kpis={k} />
        </Section>
        <Section title="Lessons completed" description="Activity across the people in view.">
          {hasTrendData(d.activityTrend.lessonsCompleted) ? (
            <TrendChart
              ariaLabel="Lessons completed over time"
              series={[
                trendSeries('lessons', 'Lessons completed', d.activityTrend.lessonsCompleted),
              ]}
            />
          ) : (
            <Empty>No lessons were completed in this period.</Empty>
          )}
        </Section>
      </Grid>
      <Grid>
        <Section
          title="AI practice scores"
          description={`${pluralize(k.aiSessions, 'evaluated session')}, average ${k.aiRolePlayAverage === null ? 'not available' : Math.round(k.aiRolePlayAverage)}.`}
        >
          {hasTrendData(d.activityTrend.aiAverageScore) ? (
            <TrendChart
              ariaLabel="AI role-play average score over time"
              yDomain={[0, 100]}
              series={[trendSeries('ai', 'Average score', d.activityTrend.aiAverageScore)]}
            />
          ) : (
            <Empty>No AI role-plays were scored in this period.</Empty>
          )}
        </Section>
        <Section title="Weak spots" description="Where your people lose the most points.">
          <WeakestAreas data={d.weakestAreas} />
        </Section>
      </Grid>
      <Grid>
        <Section title="Falling behind">
          <FallingBehindList data={d.fallingBehind} />
        </Section>
        <Section title="Need coaching">
          <AttentionList data={d.requiringAttention} />
        </Section>
      </Grid>
      <Section title="Certificates expiring soon">
        <ExpiringCertificates data={d.expiringCertifications} />
      </Section>
      <Notice tone="information">
        Time to certification, assessment pass rates by quiz and breakdowns by team and location
        need organization-wide analytics access.
      </Notice>
    </div>
  );
}

/** Picks the dashboard that matches the viewer's data scope. */
export function ReportsOverview({ filters }: { filters: analytics.AnalyticsFilters }) {
  const scope = usePermissions().scope('analytics.view');
  return scope === 'organization' || scope === 'platform' ? (
    <CompanyOverview filters={filters} />
  ) : (
    <TeamOverview filters={filters} />
  );
}
