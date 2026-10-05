import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Plus, Search } from 'lucide-react';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  Input,
  PageHeader,
  Pagination,
  Select,
  SortTh,
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
import { useTeams } from '@/features/organization/api';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSearchState } from '@/hooks/use-search-state';
import { errorMessage } from '@/lib/api/errors';
import { formatDate } from '@/lib/format';
import { useCandidates, useCertificates, useDefinitionOptions } from '../api';
import { PersonCell } from '../person-cell';
import { CandidateStatusText, CertificateStatus, PdfStatusText } from '../status';
import { IssueDialog, type IssuePreset } from './certificate-dialogs';
import { CENTER_ROOT } from './nav';
import { Segmented } from './segmented';

const DEFAULTS = {
  view: 'issued',
  q: '',
  status: '',
  definitionId: '',
  teamId: '',
  issuedFrom: '',
  issuedTo: '',
  expiring: '',
  sort: '-issuedAt',
  page: '1',
};

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'issued', label: 'Active' },
  { value: 'expired', label: 'Expired' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'superseded', label: 'Replaced' },
];

function IssuedTable({
  state,
  setState,
  search,
  setSearch,
}: {
  state: typeof DEFAULTS;
  setState: (patch: Partial<typeof DEFAULTS>) => void;
  search: string;
  setSearch: (v: string) => void;
}) {
  const navigate = useNavigate();
  const definitions = useDefinitionOptions();
  const teams = useTeams();
  const expiring = Number(state.expiring) || undefined;
  const certs = useCertificates({
    q: state.q || undefined,
    status: expiring ? 'issued' : state.status || undefined,
    definitionId: state.definitionId || undefined,
    teamId: state.teamId || undefined,
    issuedFrom: state.issuedFrom || undefined,
    issuedTo: state.issuedTo || undefined,
    expiringWithinDays: expiring,
    sort: state.sort,
    page: Number(state.page) || 1,
    pageSize: 25,
  });
  const filtered = Boolean(
    state.q ||
    state.status ||
    state.definitionId ||
    state.teamId ||
    state.issuedFrom ||
    state.issuedTo ||
    state.expiring,
  );
  const onSort = (sort: string) => setState({ sort });

  return (
    <>
      <FilterBar
        activeCount={
          [
            state.status,
            state.definitionId,
            state.teamId,
            state.issuedFrom,
            state.issuedTo,
            state.expiring,
          ].filter(Boolean).length
        }
        search={
          <Input
            type="search"
            aria-label="Search certificates"
            placeholder="Search number, name or employee ID"
            leading={<Search className="size-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        <Select
          aria-label="Status"
          value={state.status}
          disabled={Boolean(expiring)}
          onChange={(e) => setState({ status: e.target.value })}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
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
        <Select
          aria-label="Expiring within"
          value={state.expiring}
          onChange={(e) => setState({ expiring: e.target.value })}
        >
          <option value="">Any expiry</option>
          {[30, 60, 90, 180].map((d) => (
            <option key={d} value={d}>
              Expiring within {d} days
            </option>
          ))}
        </Select>
      </FilterBar>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="Issued from" className="w-40">
          <Input
            type="date"
            value={state.issuedFrom}
            max={state.issuedTo || undefined}
            onChange={(e) => setState({ issuedFrom: e.target.value })}
          />
        </Field>
        <Field label="Issued to" className="w-40">
          <Input
            type="date"
            value={state.issuedTo}
            min={state.issuedFrom || undefined}
            onChange={(e) => setState({ issuedTo: e.target.value })}
          />
        </Field>
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setSearch('');
              setState({
                q: '',
                status: '',
                definitionId: '',
                teamId: '',
                issuedFrom: '',
                issuedTo: '',
                expiring: '',
              });
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {certs.isPending ? (
        <TableSkeleton columns={6} />
      ) : certs.isError ? (
        <ErrorState message={errorMessage(certs.error)} onRetry={() => certs.refetch()} />
      ) : certs.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No certificates match these filters' : 'No certificates issued yet'}
          description={
            filtered
              ? 'Try a different search or widen the dates.'
              : 'Certificates appear here as soon as they are issued, automatically or by an administrator.'
          }
        />
      ) : (
        <>
          <Table caption="Issued certificates">
            <THead>
              <tr>
                <SortTh field="number" sort={state.sort} onSort={onSort}>
                  Number
                </SortTh>
                <Th>Recipient</Th>
                <Th className="hidden md:table-cell">Certification</Th>
                <SortTh field="status" sort={state.sort} onSort={onSort}>
                  Status
                </SortTh>
                <SortTh
                  field="issuedAt"
                  sort={state.sort}
                  onSort={onSort}
                  className="hidden sm:table-cell"
                >
                  Issued
                </SortTh>
                <SortTh
                  field="expiresAt"
                  sort={state.sort}
                  onSort={onSort}
                  className="hidden lg:table-cell"
                >
                  Expires
                </SortTh>
                <Th className="hidden xl:table-cell">PDF</Th>
              </tr>
            </THead>
            <TBody>
              {certs.data.items.map((c) => (
                <Tr key={c.id} onClick={() => navigate(`${CENTER_ROOT}/issued/${c.id}`)}>
                  <Td>
                    <Link
                      to={`${CENTER_ROOT}/issued/${c.id}`}
                      className="font-mono text-sm font-medium hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {c.certificateNumber}
                    </Link>
                  </Td>
                  <Td>
                    <PersonCell name={c.recipient.displayName} />
                  </Td>
                  <Td className="hidden text-text-secondary md:table-cell">{c.definition.name}</Td>
                  <Td>
                    <CertificateStatus status={c.effectiveStatus} />
                  </Td>
                  <Td className="hidden text-text-secondary sm:table-cell">
                    {formatDate(c.issuedAt)}
                  </Td>
                  <Td className="hidden text-text-secondary lg:table-cell">
                    {c.expiresAt ? formatDate(c.expiresAt) : 'Never'}
                  </Td>
                  <Td className="hidden xl:table-cell">
                    <PdfStatusText status={c.pdfStatus} />
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
      )}
    </>
  );
}

function ReadyTable({
  search,
  setSearch,
  state,
  setState,
  onIssue,
  canIssue,
}: {
  search: string;
  setSearch: (v: string) => void;
  state: typeof DEFAULTS;
  setState: (patch: Partial<typeof DEFAULTS>) => void;
  onIssue: (preset: IssuePreset) => void;
  canIssue: boolean;
}) {
  const definitions = useDefinitionOptions();
  const candidates = useCandidates({
    q: state.q || undefined,
    status: 'eligible,approved',
    definitionId: state.definitionId || undefined,
    page: Number(state.page) || 1,
    pageSize: 25,
  });
  return (
    <>
      <FilterBar
        activeCount={state.definitionId ? 1 : 0}
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
      {candidates.isPending ? (
        <TableSkeleton columns={4} />
      ) : candidates.isError ? (
        <ErrorState message={errorMessage(candidates.error)} onRetry={() => candidates.refetch()} />
      ) : candidates.data.items.length === 0 ? (
        <EmptyState
          title="No one is waiting for a certificate"
          description="People who meet every requirement but have not received a certificate appear here, for example when a certification is set to be issued by hand."
        />
      ) : (
        <>
          <Table caption="People ready to receive a certificate">
            <THead>
              <tr>
                <Th>Person</Th>
                <Th className="hidden md:table-cell">Certification</Th>
                <Th>Status</Th>
                <Th className="hidden sm:table-cell">Ready since</Th>
                {canIssue && (
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                )}
              </tr>
            </THead>
            <TBody>
              {candidates.data.items.map((c) => (
                <Tr key={c.id}>
                  <Td>
                    <PersonCell name={c.user.displayName} detail={c.user.employeeId} />
                    {(c.onHold || c.issueError) && (
                      <p className="mt-1 text-sm text-warning">
                        {c.onHold
                          ? `On hold: ${c.holdReason}`
                          : `Automatic issue failed: ${c.issueError}`}
                      </p>
                    )}
                  </Td>
                  <Td className="hidden text-text-secondary md:table-cell">
                    {c.definition.name}
                    {c.purpose === 'renewal' && (
                      <span className="text-text-tertiary"> (renewal)</span>
                    )}
                  </Td>
                  <Td>
                    <CandidateStatusText status={c.status} />
                  </Td>
                  <Td className="hidden text-text-secondary sm:table-cell">
                    {c.eligibleAt ? formatDate(c.eligibleAt) : '—'}
                  </Td>
                  {canIssue && (
                    <Td className="text-right">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() =>
                          onIssue({
                            definitionId: c.definition.id,
                            userId: c.user.id,
                            userName: c.user.displayName,
                          })
                        }
                      >
                        {c.purpose === 'renewal' ? 'Renew' : 'Issue'}
                        <span className="sr-only"> for {c.user.displayName}</span>
                      </Button>
                    </Td>
                  )}
                </Tr>
              ))}
            </TBody>
          </Table>
          <Pagination
            page={candidates.data.page}
            pageCount={candidates.data.pageCount}
            total={candidates.data.total}
            pageSize={candidates.data.pageSize}
            onPage={(page) => setState({ page: String(page) })}
            noun="people"
          />
        </>
      )}
    </>
  );
}

function Issued() {
  const permissions = usePermissions();
  const canIssue = permissions.has('certificates.issue');
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebouncedValue(search, 300);
  const [issuing, setIssuing] = useState<IssuePreset | null>(null);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const view = state.view === 'ready' ? 'ready' : 'issued';

  return (
    <>
      <PageHeader
        title="Issued certificates"
        description="Every certificate in your scope. Open one to download it, reissue it or revoke it."
        actions={
          canIssue && (
            <Button
              variant="primary"
              leading={<Plus className="size-4" />}
              onClick={() => setIssuing({})}
            >
              Issue certificate
            </Button>
          )
        }
      />
      <Segmented
        label="List"
        className="mb-4"
        value={view}
        options={[
          { value: 'issued', label: 'Issued certificates' },
          { value: 'ready', label: 'Ready to issue' },
        ]}
        onChange={(next) => setState({ view: next, page: '1', status: '' })}
      />
      {view === 'issued' ? (
        <IssuedTable state={state} setState={setState} search={search} setSearch={setSearch} />
      ) : (
        <ReadyTable
          state={state}
          setState={setState}
          search={search}
          setSearch={setSearch}
          canIssue={canIssue}
          onIssue={setIssuing}
        />
      )}
      {issuing && (
        <IssueDialog
          open
          preset={issuing}
          onOpenChange={(open) => {
            if (!open) setIssuing(null);
          }}
        />
      )}
    </>
  );
}

export function IssuedPage() {
  return (
    <RequirePermission all={['certificates.view']}>
      <Issued />
    </RequirePermission>
  );
}
