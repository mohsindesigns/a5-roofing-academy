import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Plus, Search } from 'lucide-react';
import {
  Button,
  EmptyState,
  ErrorState,
  FilterBar,
  Input,
  PageHeader,
  Pagination,
  Select,
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
import { errorMessage } from '@/lib/api/errors';
import { useDefinitions } from '../api';
import { APPROVAL_POLICY_LABEL, describeValidity } from '../labels';
import { DefinitionStatusText } from '../status';
import { CENTER_ROOT } from './nav';

const DEFAULTS = { q: '', status: 'draft,active', page: '1' };

const STATUS_FILTERS = [
  { value: 'draft,active', label: 'Draft and active' },
  { value: 'active', label: 'Active' },
  { value: 'draft', label: 'Draft' },
  { value: 'archived', label: 'Archived' },
  { value: 'draft,active,archived', label: 'All' },
];

function Certifications() {
  const navigate = useNavigate();
  const permissions = usePermissions();
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebouncedValue(search, 300);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const list = useDefinitions({
    q: state.q || undefined,
    status: state.status,
    page: Number(state.page) || 1,
    pageSize: 25,
  });
  const filtered = Boolean(state.q || state.status !== DEFAULTS.status);

  return (
    <>
      <PageHeader
        title="Certifications"
        description="Each certification defines what people must complete, how long it lasts and what the certificate looks like."
        actions={
          permissions.has('certifications.create') && (
            <Button asChild variant="primary" leading={<Plus className="size-4" />}>
              <Link to={`${CENTER_ROOT}/certifications/new`}>New certification</Link>
            </Button>
          )
        }
      />
      <FilterBar
        activeCount={state.status !== DEFAULTS.status ? 1 : 0}
        search={
          <Input
            type="search"
            aria-label="Search certifications"
            placeholder="Search name or code"
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
      </FilterBar>
      {list.isPending ? (
        <TableSkeleton columns={5} />
      ) : list.isError ? (
        <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No certifications match' : 'No certifications yet'}
          description={
            filtered
              ? 'Try a different search or status.'
              : 'Create the first certification to start tracking who has earned it.'
          }
          action={
            !filtered && permissions.has('certifications.create') ? (
              <Button asChild variant="primary">
                <Link to={`${CENTER_ROOT}/certifications/new`}>New certification</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table caption="Certifications">
            <THead>
              <tr>
                <Th>Certification</Th>
                <Th>Status</Th>
                <Th className="hidden md:table-cell">Validity</Th>
                <Th className="hidden lg:table-cell">Approval</Th>
                <Th className="hidden text-right sm:table-cell">Requirements</Th>
                <Th className="text-right">Active</Th>
                <Th className="hidden text-right md:table-cell">In progress</Th>
              </tr>
            </THead>
            <TBody>
              {list.data.items.map((d) => (
                <Tr key={d.id} onClick={() => navigate(`${CENTER_ROOT}/certifications/${d.id}`)}>
                  <Td>
                    <Link
                      to={`${CENTER_ROOT}/certifications/${d.id}`}
                      className="font-medium hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {d.name}
                    </Link>
                    <span className="block font-mono text-xs text-text-tertiary">{d.code}</span>
                  </Td>
                  <Td>
                    <DefinitionStatusText status={d.status} />
                  </Td>
                  <Td className="hidden text-text-secondary md:table-cell">
                    {describeValidity(d.validity)}
                  </Td>
                  <Td className="hidden text-text-secondary lg:table-cell">
                    {APPROVAL_POLICY_LABEL[d.approvalPolicy]}
                  </Td>
                  <Td className="tabular hidden text-right sm:table-cell">{d.requirementCount}</Td>
                  <Td className="tabular text-right">{d.counts.active}</Td>
                  <Td className="tabular hidden text-right text-text-secondary md:table-cell">
                    {d.counts.inProgress}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <Pagination
            page={list.data.page}
            pageCount={list.data.pageCount}
            total={list.data.total}
            pageSize={list.data.pageSize}
            onPage={(page) => setState({ page: String(page) })}
            noun="certifications"
          />
        </>
      )}
    </>
  );
}

export function CertificationsPage() {
  return (
    <RequirePermission all={['certifications.view']}>
      <Certifications />
    </RequirePermission>
  );
}
