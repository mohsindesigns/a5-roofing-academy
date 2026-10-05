import { useMemo } from 'react';
import { Link2 } from 'lucide-react';
import {
  Button,
  EmptyState,
  PageHeader,
  TabsContent,
  TabsList,
  TabsRoot,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { usePermissions } from '@/features/auth/session';
import { AnalyticsFilterBar } from '@/features/analytics/filter-controls';
import {
  ANALYTICS_FILTER_DEFAULTS,
  rangeError,
  toApiFilters,
  type AnalyticsFilterState,
} from '@/features/analytics/filters';
import { useTeams, useLocations } from '@/features/organization/api';
import { useProgramOptions } from '@/features/analytics/options';
import { useSearchState } from '@/hooks/use-search-state';
import { ExportsPanel } from './exports-panel';
import { ReportsOverview } from './overview';
import { ReportTable } from './report-table';

const DEFAULTS = {
  ...ANALYTICS_FILTER_DEFAULTS,
  tab: '',
  report: '',
  q: '',
  sort: '',
  page: '1',
};

function Reports() {
  const p = usePermissions();
  const [state, setState] = useSearchState(DEFAULTS);
  const tabs = [
    ...(p.has('analytics.view') ? [{ value: 'overview', label: 'Overview' }] : []),
    ...(p.has('reports.view') ? [{ value: 'reports', label: 'Reports' }] : []),
    ...(p.has('reports.export') ? [{ value: 'exports', label: 'Exports' }] : []),
  ];
  const tab = tabs.some((t) => t.value === state.tab) ? state.tab : (tabs[0]?.value ?? 'overview');

  const filters: AnalyticsFilterState = {
    from: state.from,
    to: state.to,
    programId: state.programId,
    teamId: state.teamId,
    locationId: state.locationId,
    certificationId: state.certificationId,
  };
  const invalidRange = rangeError(filters);
  const apiFilters = toApiFilters(filters);

  const programs = useProgramOptions();
  const teams = useTeams();
  const locations = useLocations();
  const names = useMemo(
    () => ({
      programs: new Map(programs.data?.items.map((x) => [x.id, x.title])),
      teams: new Map(teams.data?.items.map((x) => [x.id, x.name])),
      locations: new Map(locations.data?.items.map((x) => [x.id, x.name])),
    }),
    [programs.data, teams.data, locations.data],
  );

  return (
    <>
      <PageHeader
        title="Reports"
        description="Dashboards and detailed reports for the people you are allowed to see."
        actions={
          <Button
            leading={<Link2 className="size-4" />}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                toast.success('Link copied', 'It opens this view with the same filters.');
              } catch {
                toast.error(
                  'Could not copy the link',
                  'Copy the address from your browser instead.',
                );
              }
            }}
          >
            Copy link to this view
          </Button>
        }
      />
      {tabs.length === 0 ? (
        <EmptyState title="No reports are available for your role." />
      ) : (
        <TabsRoot
          value={tab}
          onValueChange={(v) => setState({ tab: v, page: '1', q: '', sort: '' })}
        >
          <TabsList className="mb-5" items={tabs} />
          {tab !== 'exports' && (
            <AnalyticsFilterBar
              state={filters}
              setState={(patch) => setState(patch)}
              showCertification={tab === 'reports' && state.report === 'certification-status'}
            />
          )}
          {invalidRange && tab !== 'exports' && (
            <p role="alert" className="mb-3 rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {invalidRange}
            </p>
          )}
          <TabsContent value="overview">
            {!invalidRange && <ReportsOverview filters={apiFilters} />}
          </TabsContent>
          <TabsContent value="reports">
            {!invalidRange && (
              <ReportTable
                filters={filters}
                reportKey={state.report}
                q={state.q}
                sort={state.sort}
                page={Number.parseInt(state.page, 10) || 1}
                onChange={(patch) => setState(patch)}
                onExported={() => setState({ tab: 'exports', page: '1' })}
              />
            )}
          </TabsContent>
          <TabsContent value="exports">
            <ExportsPanel names={names} />
          </TabsContent>
        </TabsRoot>
      )}
    </>
  );
}

export function ReportsPage() {
  return (
    <RequirePermission any={['reports.view', 'analytics.view']}>
      <Reports />
    </RequirePermission>
  );
}
