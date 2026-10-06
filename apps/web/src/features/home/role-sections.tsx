import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { ErrorState, Section, Skeleton } from '@/components/ui';
import { useCompanyDashboard, useTeamDashboard } from '@/features/analytics/api';
import {
  AttentionList,
  BreakdownBars,
  ExpiringCertificates,
  FallingBehindList,
  FunnelPanel,
  KpiStrip,
  RecentActivity,
  TrendChart,
  companyKpiItems,
  hasTrendData,
  teamKpiItems,
  trendSeries,
} from '@/features/analytics/panels';
import { useProgramOptions } from '@/features/analytics/options';
import { usePermissions } from '@/features/auth/session';
import { errorMessage } from '@/lib/api/errors';
import { formatRelative } from '@/lib/format';

/** Link into the full view, kept as plain text so it reads as navigation, not a call to action. */
function MoreLink({ to, children }: { to: string; children: string }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-sm text-information underline-offset-2 hover:underline"
    >
      {children}
      <ArrowRight aria-hidden className="size-3.5" />
    </Link>
  );
}

function Loading() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading dashboard">
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/** What a manager or trainer opens the app for: who is stuck, who needs coaching, what expires. */
function ManagerSection() {
  const dash = useTeamDashboard({});
  const canReports = usePermissions().hasAny(['reports.view']);
  return (
    <Section
      id="home-team"
      title="Your team"
      description="The people you manage or coach. Trends cover the last 12 weeks."
      actions={<MoreLink to="/team">Team progress</MoreLink>}
    >
      {dash.isPending ? (
        <Loading />
      ) : dash.isError ? (
        <ErrorState message={errorMessage(dash.error)} onRetry={() => dash.refetch()} />
      ) : (
        <>
          <KpiStrip items={teamKpiItems(dash.data.kpis)} />
          <div className="mt-6 grid gap-x-10 gap-y-6 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-medium text-text-secondary">Falling behind</h3>
              <FallingBehindList data={dash.data.fallingBehind} limit={5} />
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium text-text-secondary">Need coaching</h3>
              <AttentionList data={dash.data.requiringAttention} limit={5} />
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium text-text-secondary">
                Certificates expiring soon
              </h3>
              <ExpiringCertificates data={dash.data.expiringCertifications} limit={4} />
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium text-text-secondary">Recent activity</h3>
              <RecentActivity items={dash.data.recentActivity} limit={6} />
            </div>
          </div>
          {canReports && (
            <p className="mt-4">
              <MoreLink to="/reports">Reports and exports</MoreLink>
            </p>
          )}
        </>
      )}
    </Section>
  );
}

/** Programs whose working copy differs from what learners see. */
function UnpublishedPrograms() {
  const canPublish = usePermissions().has('programs.publish');
  const programs = useProgramOptions('active');
  const pending = programs.data?.items.filter((p) => p.hasUnpublishedChanges) ?? [];
  if (!canPublish || pending.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-text-secondary">Waiting to be published</h3>
      <ul
        aria-label="Programs with unpublished changes"
        className="divide-y divide-divider border-y border-divider"
      >
        {pending.slice(0, 5).map((p) => (
          <li key={p.id} className="flex items-baseline justify-between gap-4 py-2.5">
            <Link
              to={`/content/programs/${p.id}`}
              className="min-w-0 truncate font-medium underline-offset-2 hover:underline"
            >
              {p.title}
            </Link>
            <span className="shrink-0 text-xs text-text-tertiary">
              {p.status === 'draft' ? 'Never published' : `Updated ${formatRelative(p.updatedAt)}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Organization-wide health for administrators, training administrators and auditors. */
function AdminSection() {
  const dash = useCompanyDashboard({});
  return (
    <Section
      id="home-organization"
      title="Organization"
      description="Everyone in the academy. Trends cover the last 12 weeks."
      actions={<MoreLink to="/reports">All reports</MoreLink>}
    >
      {dash.isPending ? (
        <Loading />
      ) : dash.isError ? (
        <ErrorState message={errorMessage(dash.error)} onRetry={() => dash.refetch()} />
      ) : (
        <>
          <KpiStrip items={companyKpiItems(dash.data.kpis)} />
          <div className="mt-6 grid gap-x-10 gap-y-6 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-medium text-text-secondary">Completion funnel</h3>
              <FunnelPanel kpis={dash.data.kpis} />
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium text-text-secondary">Lessons completed</h3>
              {hasTrendData(dash.data.completionTrend.lessonsCompleted) ? (
                <TrendChart
                  ariaLabel="Lessons completed over time"
                  series={[
                    trendSeries(
                      'lessons',
                      'Lessons completed',
                      dash.data.completionTrend.lessonsCompleted,
                    ),
                  ]}
                />
              ) : (
                <p className="text-sm text-text-secondary">No lessons were completed yet.</p>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium text-text-secondary">Completion by team</h3>
              <BreakdownBars rows={dash.data.breakdowns.byTeam} noun="team" />
            </div>
            <UnpublishedPrograms />
          </div>
        </>
      )}
    </Section>
  );
}

/**
 * Manager and administrator dashboards, shown by data scope: organization-wide analytics access
 * gets the organization view, narrower analytics access gets the team view. Each section is
 * independent, so a failing API only affects its own block.
 */
export function RoleDashboards() {
  const p = usePermissions();
  if (!p.has('analytics.view')) return null;
  const scope = p.scope('analytics.view');
  if (scope === 'organization' || scope === 'platform') return <AdminSection />;
  if (scope === 'managed') return <ManagerSection />;
  return null;
}
