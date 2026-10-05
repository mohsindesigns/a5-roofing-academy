import { useEffect, useState } from 'react';
import { Search, UserPlus } from 'lucide-react';
import {
  Avatar,
  Button,
  EmptyState,
  ErrorState,
  FilterBar,
  Input,
  PageHeader,
  Pagination,
  ProgressBar,
  Select,
  SortTh,
  StatusText,
  Switch,
  Table,
  TableSkeleton,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { useCan } from '@/features/auth/session';
import { useProgramOptions } from '@/features/analytics/options';
import { useTeams } from '@/features/organization/api';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSearchState } from '@/hooks/use-search-state';
import { errorMessage } from '@/lib/api/errors';
import { formatDate, formatRelative } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useTeamProgress } from './api';
import { AssignDialog } from './assign-dialog';
import { AttentionFlags } from './attention';
import {
  TEAM_DEFAULTS,
  TEAM_STATUS_OPTIONS,
  activeTeamFilters,
  isFiltered,
  toProgressParams,
} from './filters';
import { LearnerDrawer } from './learner-drawer';

function TeamProgress() {
  const [state, setState] = useSearchState(TEAM_DEFAULTS);
  const [search, setSearch] = useState(state.q);
  const q = useDebouncedValue(search, 300);
  useEffect(() => {
    if (q !== state.q) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const canAssign = useCan('programs.assign');
  const [assignOpen, setAssignOpen] = useState(false);
  const programs = useProgramOptions();
  const teams = useTeams();

  const params = toProgressParams(state);
  const progress = useTeamProgress(params);
  // How many of the people in this view the API flagged, whatever the attention toggle says.
  const flagged = useTeamProgress({ ...params, attention: true, page: 1, pageSize: 1 });
  const filtered = isFiltered(state);
  // Opening or closing the drawer must not reset the page of the table behind it.
  const openLearner = (id: string) => setState({ learner: id, page: state.page });

  return (
    <>
      <PageHeader
        title="Team"
        description="Progress of everyone you manage or coach. Flags come from the training rules set for each program."
        actions={
          canAssign && (
            <Button
              variant="primary"
              leading={<UserPlus className="size-4" />}
              onClick={() => setAssignOpen(true)}
            >
              Assign program
            </Button>
          )
        }
      />
      <FilterBar
        activeCount={activeTeamFilters(state)}
        search={
          <Input
            type="search"
            aria-label="Search people"
            placeholder="Search name or email"
            leading={<Search className="size-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        {programs.data && programs.data.items.length > 0 && (
          <Select
            aria-label="Program"
            value={state.programId}
            onChange={(e) => setState({ programId: e.target.value })}
          >
            <option value="">All programs</option>
            {programs.data.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </Select>
        )}
        {teams.data && teams.data.items.length > 0 && (
          <Select
            aria-label="Team"
            value={state.teamId}
            onChange={(e) => setState({ teamId: e.target.value })}
          >
            <option value="">All teams</option>
            {teams.data.items.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        )}
        <Select
          aria-label="Enrollment status"
          value={state.status}
          onChange={(e) => setState({ status: e.target.value })}
        >
          {TEAM_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <label className="flex h-[var(--a5-control-height)] items-center gap-2 text-sm text-text-secondary">
          <Switch
            aria-label="Needs attention only"
            checked={state.attention === 'true'}
            onCheckedChange={(on) => setState({ attention: on ? 'true' : '' })}
          />
          Needs attention only
        </label>
      </FilterBar>

      {flagged.data && (
        <p className="mb-3 text-sm text-text-secondary" aria-live="polite">
          <span className="tabular font-medium text-text-primary">{flagged.data.total}</span>{' '}
          {flagged.data.total === 1 ? 'enrollment needs' : 'enrollments need'} attention
          {progress.data && state.attention !== 'true' && (
            <>
              {' '}
              of <span className="tabular">{progress.data.total}</span> in this view
            </>
          )}
          .
        </p>
      )}

      {progress.isPending ? (
        <TableSkeleton columns={6} />
      ) : progress.isError ? (
        <ErrorState message={errorMessage(progress.error)} onRetry={() => progress.refetch()} />
      ) : progress.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No one matches these filters' : 'No enrollments to show yet'}
          description={
            filtered
              ? 'Try a different search or clear the filters.'
              : canAssign
                ? 'Assign a program to the people you manage to start tracking their progress.'
                : 'People appear here once they are enrolled in a program.'
          }
          action={
            filtered ? (
              <Button
                onClick={() => {
                  setSearch('');
                  setState({ ...TEAM_DEFAULTS, learner: state.learner });
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table caption="Team progress">
            <THead>
              <tr>
                <SortTh field="name" sort={state.sort} onSort={(sort) => setState({ sort })}>
                  Person
                </SortTh>
                <Th className="hidden lg:table-cell">Program</Th>
                <SortTh field="progress" sort={state.sort} onSort={(sort) => setState({ sort })}>
                  Progress
                </SortTh>
                <SortTh
                  field="lastActivity"
                  sort={state.sort}
                  onSort={(sort) => setState({ sort })}
                  className="hidden md:table-cell"
                >
                  Last activity
                </SortTh>
                <SortTh
                  field="dueAt"
                  sort={state.sort}
                  onSort={(sort) => setState({ sort })}
                  className="hidden sm:table-cell"
                >
                  Due
                </SortTh>
                <Th>Attention</Th>
              </tr>
            </THead>
            <TBody>
              {progress.data.items.map((row) => (
                <Tr
                  key={row.enrollmentId}
                  selected={state.learner === row.learner.id}
                  onClick={() => openLearner(row.learner.id)}
                >
                  <Td className="min-w-[180px]">
                    <button
                      type="button"
                      className="flex min-w-0 items-center gap-3 rounded text-left"
                      aria-haspopup="dialog"
                      aria-label={`${row.learner.displayName}, open progress details`}
                      onClick={(e) => {
                        e.stopPropagation();
                        openLearner(row.learner.id);
                      }}
                    >
                      <Avatar name={row.learner.displayName} size={30} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {row.learner.displayName}
                        </span>
                        <span className="block truncate text-sm text-text-tertiary">
                          <span className="lg:hidden">{row.program.title}</span>
                          <span className="hidden lg:inline">
                            {row.learner.jobTitle ??
                              row.learner.teams.map((t) => t.name).join(', ')}
                          </span>
                        </span>
                      </span>
                    </button>
                  </Td>
                  <Td className="hidden text-text-secondary lg:table-cell">{row.program.title}</Td>
                  <Td className="min-w-[150px]">
                    <ProgressBar
                      value={row.progressPercent}
                      label={`${row.learner.displayName} progress in ${row.program.title}`}
                      tone={row.status === 'completed' ? 'success' : 'accent'}
                      showValue
                    />
                    <p className="mt-0.5 text-xs text-text-tertiary">
                      {row.status === 'completed'
                        ? 'Completed'
                        : row.status === 'withdrawn'
                          ? 'Withdrawn'
                          : `${row.requiredCompleted} of ${row.requiredTotal} required${
                              row.currentPhase ? ` · ${row.currentPhase.label}` : ''
                            }`}
                    </p>
                  </Td>
                  <Td className="hidden text-sm text-text-secondary md:table-cell">
                    {row.lastActivityAt ? formatRelative(row.lastActivityAt) : 'No activity yet'}
                  </Td>
                  <Td
                    className={cn(
                      'hidden text-sm sm:table-cell',
                      row.overdue ? 'font-medium text-danger' : 'text-text-secondary',
                    )}
                  >
                    {row.dueAt ? (
                      formatDate(row.dueAt)
                    ) : (
                      <span className="text-text-tertiary">—</span>
                    )}
                  </Td>
                  <Td className="min-w-[150px]">
                    {row.status === 'withdrawn' ? (
                      <StatusText tone="neutral">Withdrawn</StatusText>
                    ) : (
                      <AttentionFlags flags={row.attention} compact />
                    )}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <Pagination
            page={progress.data.page}
            pageCount={progress.data.pageCount}
            total={progress.data.total}
            pageSize={progress.data.pageSize}
            onPage={(page) => setState({ page: String(page) })}
            noun="enrollments"
          />
        </>
      )}

      <LearnerDrawer
        userId={state.learner || null}
        onClose={() => openLearner('')}
        onAssign={canAssign ? () => setAssignOpen(true) : undefined}
      />
      {canAssign && (
        <AssignDialog
          open={assignOpen}
          onOpenChange={setAssignOpen}
          initialPeople={
            state.learner
              ? progress.data?.items
                  .filter((r) => r.learner.id === state.learner)
                  .slice(0, 1)
                  .map((r) => ({ id: r.learner.id, displayName: r.learner.displayName }))
              : undefined
          }
        />
      )}
    </>
  );
}

export function TeamPage() {
  return (
    <RequirePermission all={['enrollments.view']}>
      <TeamProgress />
    </RequirePermission>
  );
}
