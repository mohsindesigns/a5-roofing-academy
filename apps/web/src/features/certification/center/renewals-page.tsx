import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Search } from 'lucide-react';
import {
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
  type Tone,
  Table,
  TableSkeleton,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { usePermissions } from '@/features/auth/session';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSearchState } from '@/hooks/use-search-state';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/api/errors';
import { formatDate } from '@/lib/format';
import { useCertificates, useDefinitionOptions, useRenewals } from '../api';
import { daysUntil } from '../labels';
import { PersonCell } from '../person-cell';
import { CandidateStatusText } from '../status';
import type { RenewalItem } from '../types';
import { IssueDialog, type IssuePreset } from './certificate-dialogs';
import { CENTER_ROOT } from './nav';
import { Segmented } from './segmented';

const DEFAULTS = {
  view: 'expiring',
  q: '',
  within: '90',
  status: 'open,lapsed',
  definitionId: '',
  sort: 'expiresAt',
  page: '1',
};

const RENEWAL_STATUS: Array<{ value: string; label: string }> = [
  { value: 'open,lapsed', label: 'Open and lapsed' },
  { value: 'open', label: 'Window open' },
  { value: 'lapsed', label: 'Lapsed after expiry' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const RENEWAL_STATE: Record<RenewalItem['status'], { label: string; tone: Tone }> = {
  open: { label: 'Window open', tone: 'information' },
  lapsed: { label: 'Lapsed', tone: 'danger' },
  completed: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

function RenewalState({ status }: { status: RenewalItem['status'] }) {
  const state = RENEWAL_STATE[status];
  return <StatusText tone={state.tone}>{state.label}</StatusText>;
}

function daysLeft(expiresAt: string): string {
  const d = daysUntil(expiresAt);
  if (d < 0) return `${-d} ${-d === 1 ? 'day' : 'days'} ago`;
  if (d === 0) return 'Today';
  return `In ${d} ${d === 1 ? 'day' : 'days'}`;
}

function ExpiringTable({
  state,
  setState,
}: {
  state: typeof DEFAULTS;
  setState: (patch: Partial<typeof DEFAULTS>) => void;
}) {
  const navigate = useNavigate();
  const certs = useCertificates({
    q: state.q || undefined,
    status: 'issued',
    definitionId: state.definitionId || undefined,
    expiringWithinDays: Number(state.within) || 90,
    sort: state.sort,
    page: Number(state.page) || 1,
    pageSize: 25,
  });
  if (certs.isPending) return <TableSkeleton columns={5} />;
  if (certs.isError) {
    return <ErrorState message={errorMessage(certs.error)} onRetry={() => certs.refetch()} />;
  }
  if (certs.data.items.length === 0) {
    return (
      <EmptyState
        title={`Nothing expires in the next ${state.within} days`}
        description="Certificates with an expiry date show up here as they approach it."
      />
    );
  }
  return (
    <>
      <Table caption="Certificates expiring soon">
        <THead>
          <tr>
            <Th>Recipient</Th>
            <Th className="hidden md:table-cell">Certification</Th>
            <Th className="hidden sm:table-cell">Number</Th>
            <SortTh field="expiresAt" sort={state.sort} onSort={(sort) => setState({ sort })}>
              Expires
            </SortTh>
          </tr>
        </THead>
        <TBody>
          {certs.data.items.map((c) => (
            <Tr key={c.id} onClick={() => navigate(`${CENTER_ROOT}/issued/${c.id}`)}>
              <Td>
                <Link
                  to={`${CENTER_ROOT}/issued/${c.id}`}
                  className="block hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  <PersonCell name={c.recipient.displayName} />
                </Link>
              </Td>
              <Td className="hidden text-text-secondary md:table-cell">{c.definition.name}</Td>
              <Td className="hidden font-mono text-sm sm:table-cell">{c.certificateNumber}</Td>
              <Td>
                <span className="block">{c.expiresAt ? formatDate(c.expiresAt) : '—'}</span>
                {c.expiresAt && (
                  <span
                    className={cn(
                      'block text-sm',
                      daysUntil(c.expiresAt) <= 30 ? 'text-warning' : 'text-text-secondary',
                    )}
                  >
                    {daysLeft(c.expiresAt)}
                  </span>
                )}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      <Pagination
        page={certs.data.page}
        pageCount={certs.data.pageCount}
        total={certs.data.total}
        pageSize={certs.data.pageSize}
        onPage={(page) => setState({ page: String(page) })}
        noun="certificates"
      />
    </>
  );
}

function RenewalsTable({
  state,
  setState,
  onRenew,
  canIssue,
}: {
  state: typeof DEFAULTS;
  setState: (patch: Partial<typeof DEFAULTS>) => void;
  onRenew: (preset: IssuePreset) => void;
  canIssue: boolean;
}) {
  const navigate = useNavigate();
  const renewals = useRenewals({
    q: state.q || undefined,
    status: state.status,
    definitionId: state.definitionId || undefined,
    page: Number(state.page) || 1,
    pageSize: 25,
  });
  if (renewals.isPending) return <TableSkeleton columns={5} />;
  if (renewals.isError) {
    return <ErrorState message={errorMessage(renewals.error)} onRetry={() => renewals.refetch()} />;
  }
  if (renewals.data.items.length === 0) {
    return (
      <EmptyState
        title="No renewals in this view"
        description="A renewal opens automatically when a certificate enters its renewal window."
      />
    );
  }
  return (
    <>
      <Table caption="Certificate renewals">
        <THead>
          <tr>
            <Th>Recipient</Th>
            <Th className="hidden md:table-cell">Certification</Th>
            <Th className="hidden sm:table-cell">Renewal</Th>
            <Th className="hidden sm:table-cell">Requirements</Th>
            <Th className="hidden lg:table-cell">Due</Th>
            {canIssue && (
              <Th className="hidden sm:table-cell">
                <span className="sr-only">Actions</span>
              </Th>
            )}
          </tr>
        </THead>
        <TBody>
          {renewals.data.items.map((r) => {
            const ready = r.progress?.status === 'eligible' || r.progress?.status === 'approved';
            return (
              <Tr key={r.id} onClick={() => navigate(`${CENTER_ROOT}/issued/${r.certificate.id}`)}>
                <Td>
                  <Link
                    to={`${CENTER_ROOT}/issued/${r.certificate.id}`}
                    className="block hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <PersonCell
                      name={r.certificate.recipient.displayName}
                      detail={r.certificate.certificateNumber}
                    />
                  </Link>
                  <div className="mt-1.5 grid justify-items-start gap-2 sm:hidden">
                    <RenewalState status={r.status} />
                    {r.progress && (
                      <span className="tabular text-sm text-text-secondary">
                        {r.progress.metCount} of {r.progress.totalCount} requirements met
                      </span>
                    )}
                    {canIssue && (r.status === 'open' || r.status === 'lapsed') && (
                      <Button
                        size="sm"
                        variant={ready ? 'primary' : 'secondary'}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRenew({
                            definitionId: r.certificate.definition.id,
                            userId: r.certificate.recipient.id,
                            userName: r.certificate.recipient.displayName,
                          });
                        }}
                      >
                        Renew
                        <span className="sr-only"> {r.certificate.recipient.displayName}</span>
                      </Button>
                    )}
                  </div>
                </Td>
                <Td className="hidden text-text-secondary md:table-cell">
                  {r.certificate.definition.name}
                </Td>
                <Td className="hidden sm:table-cell">
                  <RenewalState status={r.status} />
                </Td>
                <Td className="hidden sm:table-cell">
                  {r.progress ? (
                    <div className="grid gap-1">
                      <div className="flex min-w-[130px] items-center gap-3">
                        <ProgressBar
                          value={
                            r.progress.totalCount
                              ? (r.progress.metCount / r.progress.totalCount) * 100
                              : 0
                          }
                          label={`${r.certificate.recipient.displayName}: ${r.progress.metCount} of ${r.progress.totalCount} renewal requirements`}
                          size="sm"
                          tone={ready ? 'success' : 'accent'}
                          className="flex-1"
                        />
                        <span className="tabular text-sm text-text-secondary">
                          {r.progress.metCount}/{r.progress.totalCount}
                        </span>
                      </div>
                      <CandidateStatusText status={r.progress.status} />
                    </div>
                  ) : (
                    <span className="text-text-secondary">—</span>
                  )}
                </Td>
                <Td className="hidden text-text-secondary lg:table-cell">
                  {r.dueAt ? formatDate(r.dueAt) : '—'}
                </Td>
                {canIssue && (
                  <Td className="hidden text-right sm:table-cell">
                    {(r.status === 'open' || r.status === 'lapsed') && (
                      <Button
                        size="sm"
                        variant={ready ? 'primary' : 'secondary'}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRenew({
                            definitionId: r.certificate.definition.id,
                            userId: r.certificate.recipient.id,
                            userName: r.certificate.recipient.displayName,
                          });
                        }}
                      >
                        Renew
                        <span className="sr-only"> {r.certificate.recipient.displayName}</span>
                      </Button>
                    )}
                  </Td>
                )}
              </Tr>
            );
          })}
        </TBody>
      </Table>
      <Pagination
        page={renewals.data.page}
        pageCount={renewals.data.pageCount}
        total={renewals.data.total}
        pageSize={renewals.data.pageSize}
        onPage={(page) => setState({ page: String(page) })}
        noun="renewals"
      />
    </>
  );
}

function Renewals() {
  const permissions = usePermissions();
  const canIssue = permissions.has('certificates.issue');
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebouncedValue(search, 300);
  const [renewing, setRenewing] = useState<IssuePreset | null>(null);
  const definitions = useDefinitionOptions();
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const view = state.view === 'renewals' ? 'renewals' : 'expiring';

  return (
    <>
      <PageHeader
        title="Expiry and renewals"
        description="What expires soon and who is working on recertifying. Renewals open automatically inside each certification's renewal window."
      />
      <Segmented
        label="List"
        className="mb-4"
        value={view}
        options={[
          { value: 'expiring', label: 'Expiring soon' },
          { value: 'renewals', label: 'Renewals' },
        ]}
        onChange={(next) => setState({ view: next, page: '1' })}
      />
      <FilterBar
        activeCount={[state.definitionId].filter(Boolean).length}
        search={
          <Input
            type="search"
            aria-label="Search people"
            placeholder="Search name, number or employee ID"
            leading={<Search className="size-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        {view === 'expiring' ? (
          <Select
            aria-label="Expiring within"
            value={state.within}
            onChange={(e) => setState({ within: e.target.value })}
          >
            {[30, 60, 90, 180, 365].map((d) => (
              <option key={d} value={d}>
                Within {d} days
              </option>
            ))}
          </Select>
        ) : (
          <Select
            aria-label="Renewal status"
            value={state.status}
            onChange={(e) => setState({ status: e.target.value })}
          >
            {RENEWAL_STATUS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
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
          {definitions.data?.items.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
      </FilterBar>
      {view === 'expiring' ? (
        <ExpiringTable state={state} setState={setState} />
      ) : (
        <RenewalsTable
          state={state}
          setState={setState}
          onRenew={setRenewing}
          canIssue={canIssue}
        />
      )}
      {renewing && (
        <IssueDialog
          open
          preset={renewing}
          onOpenChange={(open) => {
            if (!open) setRenewing(null);
          }}
        />
      )}
    </>
  );
}

export function RenewalsPage() {
  return (
    <RequirePermission all={['certificates.view']}>
      <Renewals />
    </RequirePermission>
  );
}
