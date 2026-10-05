import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import {
  Button,
  EmptyState,
  ErrorState,
  FilterBar,
  Input,
  PageHeader,
  Pagination,
  Select,
  SortTh,
  StatusText,
  Table,
  TableSkeleton,
  TBody,
  Td,
  Tag,
  Th,
  THead,
  Tr,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { useCan } from '@/features/auth/session';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSearchState } from '@/hooks/use-search-state';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';
import { useAssessments, useReviewAttempts } from '../api';
import { ATTEMPT_STATUS, KIND_LABELS, formatScore } from '../labels';
import { AttemptDetailSheet } from './attempt-detail-sheet';
import { ContentNav } from './content-nav';

const DEFAULTS = {
  q: '',
  assessmentId: '',
  status: '',
  from: '',
  to: '',
  sort: '-submittedAt',
  page: '1',
  attempt: '',
};

/** Local midnight of a yyyy-mm-dd date as an ISO instant. */
function dayStart(date: string, plusDays = 0): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + plusDays);
  return d.toISOString();
}

function AttemptsReview() {
  const canViewAssessments = useCan('assessments.view');
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebouncedValue(search, 300);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // Only people who can see assessments can list them for the filter.
  const assessments = useAssessments({ pageSize: 100, sort: 'title' }, canViewAssessments);
  const list = useReviewAttempts({
    q: state.q || undefined,
    assessmentId: state.assessmentId || undefined,
    status: state.status || undefined,
    submittedFrom: state.from ? dayStart(state.from) : undefined,
    submittedTo: state.to ? dayStart(state.to, 1) : undefined,
    sort: state.sort,
    page: Number(state.page),
    pageSize: 25,
  });
  const filtered = Boolean(state.q || state.assessmentId || state.status || state.from || state.to);
  const open = (id: string) => setState({ attempt: id, page: state.page });

  return (
    <>
      <PageHeader
        title="Attempts"
        description="Quiz and exam attempts from the learners you can follow. Open one to read the answers and see how each was marked."
      />
      <ContentNav />
      <FilterBar
        activeCount={
          [state.assessmentId, state.status, state.from, state.to].filter(Boolean).length
        }
        search={
          <Input
            type="search"
            aria-label="Search attempts"
            placeholder="Search learner or assessment"
            leading={<Search className="size-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        {canViewAssessments && (
          <Select
            aria-label="Assessment"
            value={state.assessmentId}
            onChange={(e) => setState({ assessmentId: e.target.value })}
          >
            <option value="">All assessments</option>
            {assessments.data?.items.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </Select>
        )}
        <Select
          aria-label="Status"
          value={state.status}
          onChange={(e) => setState({ status: e.target.value })}
        >
          <option value="">All statuses</option>
          <option value="pending_review">Awaiting review</option>
          <option value="graded">Graded</option>
          <option value="in_progress">In progress</option>
          <option value="expired">Timed out</option>
        </Select>
        <Input
          type="date"
          aria-label="Submitted from"
          value={state.from}
          onChange={(e) => setState({ from: e.target.value })}
        />
        <Input
          type="date"
          aria-label="Submitted to"
          value={state.to}
          onChange={(e) => setState({ to: e.target.value })}
        />
      </FilterBar>

      {list.isPending ? (
        <TableSkeleton columns={6} />
      ) : list.isError ? (
        <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No attempts match these filters' : 'No attempts yet'}
          description={
            filtered
              ? 'Try a different search or clear the filters.'
              : 'Attempts from the learners you follow appear here once they start an assessment.'
          }
          action={
            filtered ? (
              <Button
                onClick={() => {
                  setSearch('');
                  setState({ q: '', assessmentId: '', status: '', from: '', to: '' });
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table caption="Attempts">
            <THead>
              <tr>
                <SortTh field="learner" sort={state.sort} onSort={(sort) => setState({ sort })}>
                  Learner
                </SortTh>
                <SortTh
                  field="assessment"
                  sort={state.sort}
                  onSort={(sort) => setState({ sort })}
                  className="hidden md:table-cell"
                >
                  Assessment
                </SortTh>
                <Th className="hidden text-right sm:table-cell">Attempt</Th>
                <Th>Status</Th>
                <SortTh field="score" sort={state.sort} onSort={(sort) => setState({ sort })}>
                  Score
                </SortTh>
                <SortTh
                  field="submittedAt"
                  sort={state.sort}
                  onSort={(sort) => setState({ sort })}
                  className="hidden lg:table-cell"
                >
                  Submitted
                </SortTh>
              </tr>
            </THead>
            <TBody>
              {list.data.items.map((a) => {
                const status = ATTEMPT_STATUS[a.status];
                return (
                  <Tr key={a.id} onClick={() => open(a.id)} selected={state.attempt === a.id}>
                    <Td>
                      <button
                        type="button"
                        className="block min-w-0 text-left"
                        onClick={(e) => (e.stopPropagation(), open(a.id))}
                      >
                        <span className="block truncate font-medium">{a.learner.displayName}</span>
                        <span className="block truncate text-sm text-text-tertiary md:hidden">
                          {a.assessment.title}
                        </span>
                      </button>
                    </Td>
                    <Td className="hidden md:table-cell">
                      <span className="block max-w-[34ch] truncate">{a.assessment.title}</span>
                      <span className="block text-sm text-text-tertiary">
                        {KIND_LABELS[a.assessment.kind]}
                      </span>
                    </Td>
                    <Td className="tabular hidden text-right sm:table-cell">{a.attemptNumber}</Td>
                    <Td>
                      <StatusText tone={status.tone}>{status.label}</StatusText>
                      {a.pendingReviewCount > 0 && (
                        <Tag tone="warning" className="ml-2">
                          {a.pendingReviewCount} to review
                        </Tag>
                      )}
                    </Td>
                    <Td>
                      {a.scorePercent === null ? (
                        <span className="text-text-tertiary">—</span>
                      ) : (
                        <span className="inline-flex flex-wrap items-baseline gap-x-2">
                          <span className="tabular font-medium">{formatScore(a.scorePercent)}</span>
                          {a.passed !== null && (
                            <StatusText tone={a.passed ? 'success' : 'danger'}>
                              {a.passed ? 'Passed' : 'Not passed'}
                            </StatusText>
                          )}
                          {a.overridden && (
                            <span className="text-xs text-text-tertiary">adjusted</span>
                          )}
                        </span>
                      )}
                    </Td>
                    <Td className="hidden text-sm text-text-secondary lg:table-cell">
                      {a.submittedAt ? formatDateTime(a.submittedAt) : '—'}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
          <Pagination
            page={list.data.page}
            pageCount={list.data.pageCount}
            total={list.data.total}
            pageSize={list.data.pageSize}
            onPage={(page) => setState({ page: String(page), attempt: state.attempt })}
            noun="attempts"
          />
        </>
      )}
      <AttemptDetailSheet
        attemptId={state.attempt || undefined}
        onClose={() => setState({ attempt: '', page: state.page })}
      />
    </>
  );
}

export function AttemptsReviewPage() {
  return (
    <RequirePermission all={['assessment_attempts.view']}>
      <AttemptsReview />
    </RequirePermission>
  );
}
