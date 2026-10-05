import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FilterBar,
  Input,
  PageHeader,
  Pagination,
  Select,
  Skeleton,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { useMe, usePermissions } from '@/features/auth/session';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSearchState } from '@/hooks/use-search-state';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useApprovals, useDecideApproval, useDefinitionOptions } from '../api';
import { decisionBlocker } from '../approval-rules';
import { APPROVAL_KIND } from '../labels';
import { PersonCell } from '../person-cell';
import { RequirementChecklist } from '../requirement-checklist';
import { ApprovalStatusText } from '../status';
import type { Approval } from '../types';

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'pending', label: 'Waiting for a decision' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Not approved' },
  { value: 'pending,approved,rejected,cancelled', label: 'All requests' },
];

const DEFAULTS = { q: '', status: 'pending', definitionId: '', page: '1' };

export function ApprovalRow({ approval }: { approval: Approval }) {
  const me = useMe();
  const permissions = usePermissions();
  const decide = useDecideApproval();
  const [open, setOpen] = useState(false);
  const [deciding, setDeciding] = useState<'approved' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const blocker = decisionBlocker(approval, {
    userId: me.data?.user.id,
    scope: permissions.scope('certificate_approvals.decide'),
  });
  const pending = approval.status === 'pending';
  const { metCount, totalCount, requirements } = approval.progress;

  const close = (next: boolean) => {
    if (!next) {
      setDeciding(null);
      setError(null);
    }
  };

  return (
    <li className="px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <PersonCell
            name={approval.user.displayName}
            detail={[approval.user.jobTitle, approval.user.employeeId].filter(Boolean).join(' · ')}
            size={32}
          />
          <p className="mt-2 text-base">
            <span className="font-medium">{approval.definition.name}</span>
            <span className="text-text-secondary"> · {APPROVAL_KIND[approval.kind]}</span>
          </p>
          <p className="mt-0.5 text-sm text-text-secondary">
            <span className="tabular">
              {metCount} of {totalCount}
            </span>{' '}
            requirements met · requested{' '}
            <time dateTime={approval.requestedAt} title={formatDateTime(approval.requestedAt)}>
              {formatRelative(approval.requestedAt)}
            </time>
          </p>
        </div>
        {pending ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              leading={<Check className="size-4" />}
              disabled={blocker !== null}
              onClick={() => setDeciding('approved')}
            >
              Approve
            </Button>
            <Button
              leading={<X className="size-4" />}
              disabled={blocker !== null}
              onClick={() => setDeciding('rejected')}
            >
              Not yet
            </Button>
          </div>
        ) : (
          <ApprovalStatusText status={approval.status} />
        )}
      </div>

      {pending && blocker && (
        <p className="mt-3 max-w-2xl text-sm text-text-secondary" role="note">
          {blocker}
        </p>
      )}
      {!pending && (
        <p className="mt-2 text-sm text-text-secondary">
          {approval.decidedBy ? `${approval.decidedBy.displayName}, ` : ''}
          {approval.decidedAt ? formatDateTime(approval.decidedAt) : ''}
          {approval.comment ? `. “${approval.comment}”` : ''}
        </p>
      )}

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="mt-3 inline-flex items-center gap-1 rounded text-sm font-medium text-information hover:underline"
      >
        {open ? (
          <ChevronDown aria-hidden className="size-4" />
        ) : (
          <ChevronRight aria-hidden className="size-4" />
        )}
        {open ? 'Hide requirements' : 'Review requirements'}
      </button>
      {open && (
        <RequirementChecklist
          className="mt-3 max-w-2xl"
          requirements={requirements}
          metCount={metCount}
          totalCount={totalCount}
        />
      )}

      <ConfirmDialog
        open={deciding === 'approved'}
        onOpenChange={close}
        title={`Approve ${approval.definition.name}`}
        description={`${approval.user.displayName} will receive the certification as soon as it is approved.`}
        confirmLabel="Approve certification"
        reasonLabel="Comment (optional)"
        loading={decide.isPending}
        error={error}
        onConfirm={(comment) => {
          setError(null);
          decide.mutate(
            { id: approval.id, decision: 'approved', comment: comment || null },
            {
              onSuccess: () => {
                setDeciding(null);
                toast.success(`${approval.user.displayName} was approved`);
              },
              onError: (err) => setError(errorMessage(err)),
            },
          );
        }}
      />
      <ConfirmDialog
        open={deciding === 'rejected'}
        onOpenChange={close}
        title={`Not ready for ${approval.definition.name}`}
        description={`${approval.user.displayName} is told what is still missing and keeps working toward it.`}
        confirmLabel="Send back"
        tone="danger"
        reasonLabel="What is still missing?"
        reasonRequired
        loading={decide.isPending}
        error={error}
        onConfirm={(comment) => {
          setError(null);
          decide.mutate(
            { id: approval.id, decision: 'rejected', comment },
            {
              onSuccess: () => {
                setDeciding(null);
                toast.success(`${approval.user.displayName} was told what to work on`);
              },
              onError: (err) => setError(errorMessage(err)),
            },
          );
        }}
      />
    </li>
  );
}

function Approvals() {
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebouncedValue(search, 300);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const definitions = useDefinitionOptions();
  const approvals = useApprovals({
    q: state.q || undefined,
    status: state.status,
    definitionId: state.definitionId || undefined,
    page: Number(state.page) || 1,
    pageSize: 20,
  });
  const filtered = Boolean(state.q || state.definitionId || state.status !== DEFAULTS.status);

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Certification requests that need a person's sign-off. You only see people you are allowed to approve."
      />
      <FilterBar
        activeCount={
          [state.definitionId, state.status !== DEFAULTS.status ? 's' : ''].filter(Boolean).length
        }
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
          value={state.status}
          onChange={(e) => setState({ status: e.target.value })}
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Certification"
          value={state.definitionId}
          onChange={(e) => setState({ definitionId: e.target.value })}
        >
          <option value="">All certifications</option>
          {definitions.data?.items.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
      </FilterBar>

      {approvals.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : approvals.isError ? (
        <ErrorState message={errorMessage(approvals.error)} onRetry={() => approvals.refetch()} />
      ) : approvals.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No requests match these filters' : 'Nothing is waiting for approval'}
          description={
            filtered
              ? 'Try a different status or clear the filters.'
              : 'When someone you approve for meets every requirement, their request appears here and you are notified.'
          }
          action={
            filtered ? (
              <Button
                onClick={() => {
                  setSearch('');
                  setState({ q: '', definitionId: '', status: DEFAULTS.status });
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className="divide-y divide-divider overflow-hidden rounded-lg border border-border bg-surface">
            {approvals.data.items.map((a) => (
              <ApprovalRow key={a.id} approval={a} />
            ))}
          </ul>
          <Pagination
            page={approvals.data.page}
            pageCount={approvals.data.pageCount}
            total={approvals.data.total}
            pageSize={approvals.data.pageSize}
            onPage={(page) => setState({ page: String(page) })}
            noun="requests"
          />
        </>
      )}
    </>
  );
}

export function ApprovalsPage() {
  return (
    <RequirePermission all={['certificate_approvals.decide']}>
      <Approvals />
    </RequirePermission>
  );
}
