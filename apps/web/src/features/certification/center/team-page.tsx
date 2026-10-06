import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Search } from 'lucide-react';
import { certification } from '@a5/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  FilterBar,
  Input,
  Notice,
  PageHeader,
  Pagination,
  ProgressBar,
  Select,
  Table,
  TableSkeleton,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui';
import { StatCell, StatRow, StatTile } from '@/components/charts';
import { RequirePermission } from '@/app/guards';
import { usePermissions } from '@/features/auth/session';
import { useTeams } from '@/features/organization/api';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSearchState } from '@/hooks/use-search-state';
import { errorMessage } from '@/lib/api/errors';
import { formatDate } from '@/lib/format';
import { useDashboard, useDefinitionOptions, useTeamStatus } from '../api';
import { expiryText } from '../labels';
import { PersonCell } from '../person-cell';
import { TeamStateStatus } from '../status';
import type { TeamStatusRow } from '../types';
import { CENTER_ROOT } from './nav';

const FILTER_LABELS: Record<certification.TeamFilter, string> = {
  certified: 'Certified',
  not_certified: 'Not yet certified',
  eligible: 'Ready to issue',
  pending_approval: 'Pending approval',
  expiring: 'Expiring soon',
  expired: 'Expired',
  revoked: 'Revoked',
};

const DEFAULTS = {
  q: '',
  definitionId: '',
  teamId: '',
  filter: '',
  within: '60',
  page: '1',
};

const WINDOWS = ['30', '60', '90', '180'];

function parseFilter(value: string | undefined): certification.TeamFilter | undefined {
  const parsed = certification.teamFilterSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function ProgressCell({ row }: { row: TeamStatusRow }) {
  if (
    row.certificate &&
    (row.state === 'certified' || row.state === 'expiring' || row.state === 'renewal_required')
  ) {
    return (
      <span className="text-sm text-text-secondary">{expiryText(row.certificate.expiresAt)}</span>
    );
  }
  if (row.certificate && (row.state === 'expired' || row.state === 'revoked')) {
    return (
      <span className="text-sm text-text-secondary">
        Issued {formatDate(row.certificate.issuedAt)}
      </span>
    );
  }
  if (row.totalCount === 0) return <span className="text-sm text-text-secondary">—</span>;
  return (
    <div className="flex min-w-[140px] items-center gap-3">
      <ProgressBar
        value={(row.metCount / row.totalCount) * 100}
        label={`${row.user.displayName}: ${row.metCount} of ${row.totalCount} requirements`}
        size="sm"
        tone={row.metCount === row.totalCount ? 'success' : 'accent'}
        className="flex-1"
      />
      <span className="tabular text-sm text-text-secondary">
        {row.metCount}/{row.totalCount}
      </span>
    </div>
  );
}

function TeamCertifications() {
  const navigate = useNavigate();
  const permissions = usePermissions();
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebouncedValue(search, 300);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const filter = parseFilter(state.filter);
  const within = Number(state.within) || 60;
  const rows = useTeamStatus({
    q: state.q || undefined,
    definitionId: state.definitionId || undefined,
    teamId: state.teamId || undefined,
    filter,
    expiringWithinDays: within,
    page: Number(state.page) || 1,
    pageSize: 25,
  });
  const definitions = useDefinitionOptions();
  const teams = useTeams();
  const dashboard = useDashboard();
  const canDecide = permissions.has('certificate_approvals.decide');
  const filtered = Boolean(state.q || state.definitionId || state.teamId || state.filter);
  const d = dashboard.data;

  return (
    <>
      <PageHeader
        title="Team certifications"
        description="Who is certified, who is close, and what needs attention across the people you manage."
        actions={
          canDecide && (
            <Button asChild variant={d && d.pendingApprovals > 0 ? 'primary' : 'secondary'}>
              <Link to={`${CENTER_ROOT}/approvals`}>
                {d && d.pendingApprovals > 0
                  ? `Review ${d.pendingApprovals} ${d.pendingApprovals === 1 ? 'approval' : 'approvals'}`
                  : 'Approvals'}
              </Link>
            </Button>
          )
        }
      />
      {d && (
        <StatRow className="mb-6">
          <StatCell>
            <StatTile label="Active certificates" value={d.active} />
          </StatCell>
          <StatCell>
            <StatTile
              label="Expiring in 30 days"
              value={d.expiring.within30}
              context={`${d.expiring.within90} in 90`}
            />
          </StatCell>
          <StatCell>
            <StatTile label="Waiting for approval" value={d.pendingApprovals} />
          </StatCell>
          <StatCell>
            <StatTile label="Ready to issue" value={d.eligible} />
          </StatCell>
        </StatRow>
      )}
      <FilterBar
        activeCount={[state.definitionId, state.teamId, state.filter].filter(Boolean).length}
        search={
          <Input
            type="search"
            aria-label="Search people"
            placeholder="Search name or employee ID"
            leading={<Search className="size-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        <Select
          aria-label="Status"
          value={state.filter}
          onChange={(e) => setState({ filter: e.target.value })}
        >
          <option value="">All statuses</option>
          {certification.teamFilterSchema.options.map((f) => (
            <option key={f} value={f}>
              {FILTER_LABELS[f]}
            </option>
          ))}
        </Select>
        {filter === 'expiring' && (
          <Select
            aria-label="Expiring within"
            value={state.within}
            onChange={(e) => setState({ within: e.target.value })}
          >
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                Within {w} days
              </option>
            ))}
          </Select>
        )}
        <Select
          aria-label="Certification"
          value={state.definitionId}
          onChange={(e) => setState({ definitionId: e.target.value })}
        >
          <option value="">All certifications</option>
          {definitions.data?.items.map((def) => (
            <option key={def.id} value={def.id}>
              {def.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Team"
          value={state.teamId}
          onChange={(e) => setState({ teamId: e.target.value })}
        >
          <option value="">All teams</option>
          {teams.data?.items.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </FilterBar>

      {filter === 'pending_approval' && canDecide && (
        <Notice tone="information" className="mb-3">
          You decide these requests in the{' '}
          <Link className="underline underline-offset-2" to={`${CENTER_ROOT}/approvals`}>
            approvals queue
          </Link>
          .
        </Notice>
      )}

      {rows.isPending ? (
        <TableSkeleton columns={5} />
      ) : rows.isError ? (
        <ErrorState message={errorMessage(rows.error)} onRetry={() => rows.refetch()} />
      ) : rows.data.items.length === 0 ? (
        <EmptyState
          title={
            filtered
              ? 'No one matches these filters'
              : 'No one is working toward a certification yet'
          }
          description={
            filtered
              ? 'Try a different search or clear the filters.'
              : 'People appear here once they are enrolled in a program that leads to a certification.'
          }
          action={
            filtered ? (
              <Button
                onClick={() => {
                  setSearch('');
                  setState({ q: '', definitionId: '', teamId: '', filter: '' });
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table caption="Team certification status">
            <THead>
              <tr>
                <Th>Person</Th>
                <Th className="hidden md:table-cell">Certification</Th>
                <Th className="hidden sm:table-cell">Status</Th>
                <Th className="hidden sm:table-cell">Progress or validity</Th>
                <Th className="hidden lg:table-cell">Certificate</Th>
              </tr>
            </THead>
            <TBody>
              {rows.data.items.map((row) => {
                const open = row.certificate
                  ? () => navigate(`${CENTER_ROOT}/issued/${row.certificate!.id}`)
                  : undefined;
                return (
                  <Tr key={`${row.user.id}-${row.definition.id}`} onClick={open}>
                    <Td>
                      {row.certificate ? (
                        <Link
                          to={`${CENTER_ROOT}/issued/${row.certificate.id}`}
                          className="block hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <PersonCell
                            name={row.user.displayName}
                            detail={row.user.jobTitle ?? row.user.employeeId}
                          />
                        </Link>
                      ) : (
                        <PersonCell
                          name={row.user.displayName}
                          detail={row.user.jobTitle ?? row.user.employeeId}
                        />
                      )}
                      <span className="mt-1 block text-sm text-text-secondary md:hidden">
                        {row.definition.name}
                      </span>
                      <span className="mt-1 block sm:hidden">
                        <TeamStateStatus state={row.state} />
                      </span>
                    </Td>
                    <Td className="hidden text-text-secondary md:table-cell">
                      {row.definition.name}
                    </Td>
                    <Td className="hidden sm:table-cell">
                      <TeamStateStatus state={row.state} />
                    </Td>
                    <Td className="hidden sm:table-cell">
                      <ProgressCell row={row} />
                    </Td>
                    <Td className="hidden lg:table-cell">
                      {row.certificate ? (
                        <Link
                          to={`${CENTER_ROOT}/issued/${row.certificate.id}`}
                          className="font-mono text-sm hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {row.certificate.certificateNumber}
                        </Link>
                      ) : (
                        <span className="text-text-secondary">—</span>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
          <Pagination
            page={rows.data.page}
            pageCount={rows.data.pageCount}
            total={rows.data.total}
            pageSize={rows.data.pageSize}
            onPage={(page) => setState({ page: String(page) })}
            noun="rows"
          />
        </>
      )}
    </>
  );
}

export function TeamCertificationsPage() {
  return (
    <RequirePermission all={['certificates.view']}>
      <TeamCertifications />
    </RequirePermission>
  );
}
