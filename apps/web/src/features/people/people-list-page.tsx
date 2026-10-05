import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
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
import { useCan } from '@/features/auth/session';
import { useRoles } from '@/features/access/api';
import { useLocations, useTeams } from '@/features/organization/api';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSearchState } from '@/hooks/use-search-state';
import { errorMessage } from '@/lib/api/errors';
import { formatRelative } from '@/lib/format';
import { usePeople } from './api';
import { UserStatus } from './status';

const DEFAULTS = {
  q: '',
  status: 'active,invited',
  roleId: '',
  teamId: '',
  locationId: '',
  sort: 'name',
  page: '1',
};

function PeopleList() {
  const navigate = useNavigate();
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebouncedValue(search, 300);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const canInvite = useCan('users.create', 'roles.assign');
  const roles = useRoles();
  const teams = useTeams();
  const locations = useLocations();
  const people = usePeople({
    q: state.q || undefined,
    status: state.status || undefined,
    roleId: state.roleId || undefined,
    teamId: state.teamId || undefined,
    locationId: state.locationId || undefined,
    sort: state.sort,
    page: Number(state.page),
    pageSize: 25,
  });
  const filtered = Boolean(
    state.q || state.roleId || state.teamId || state.locationId || state.status !== DEFAULTS.status,
  );

  return (
    <>
      <PageHeader
        title="People"
        description="Everyone with access to the academy in your scope."
        actions={
          canInvite && (
            <Button asChild variant="primary" leading={<UserPlus className="size-4" />}>
              <Link to="/people/new">Add person</Link>
            </Button>
          )
        }
      />
      <FilterBar
        activeCount={
          [
            state.roleId,
            state.teamId,
            state.locationId,
            state.status !== DEFAULTS.status ? 'status' : '',
          ].filter(Boolean).length
        }
        search={
          <Input
            type="search"
            aria-label="Search people"
            placeholder="Search name, email or employee ID"
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
          <option value="active,invited">Active and invited</option>
          <option value="active">Active</option>
          <option value="invited">Invited</option>
          <option value="deactivated">Deactivated</option>
          <option value="">All statuses</option>
        </Select>
        <Select
          aria-label="Role"
          value={state.roleId}
          onChange={(e) => setState({ roleId: e.target.value })}
        >
          <option value="">All roles</option>
          {roles.data?.items.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
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
          aria-label="Location"
          value={state.locationId}
          onChange={(e) => setState({ locationId: e.target.value })}
        >
          <option value="">All locations</option>
          {locations.data?.items.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </FilterBar>

      {people.isPending ? (
        <TableSkeleton columns={5} />
      ) : people.isError ? (
        <ErrorState message={errorMessage(people.error)} onRetry={() => people.refetch()} />
      ) : people.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No one matches these filters' : 'No people yet'}
          description={
            filtered
              ? 'Try a different search or clear the filters.'
              : 'Add the first person to start assigning training.'
          }
          action={
            filtered ? (
              <Button
                onClick={() => {
                  setSearch('');
                  setState({
                    q: '',
                    roleId: '',
                    teamId: '',
                    locationId: '',
                    status: DEFAULTS.status,
                  });
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table caption="People">
            <THead>
              <tr>
                <SortTh field="name" sort={state.sort} onSort={(sort) => setState({ sort })}>
                  Name
                </SortTh>
                <Th className="hidden md:table-cell">Role</Th>
                <Th className="hidden lg:table-cell">Team</Th>
                <Th className="hidden xl:table-cell">Location</Th>
                <SortTh field="status" sort={state.sort} onSort={(sort) => setState({ sort })}>
                  Status
                </SortTh>
                <SortTh
                  field="lastLoginAt"
                  sort={state.sort}
                  onSort={(sort) => setState({ sort })}
                  className="hidden sm:table-cell"
                >
                  Last sign-in
                </SortTh>
              </tr>
            </THead>
            <TBody>
              {people.data.items.map((u) => (
                <Tr key={u.id} onClick={() => navigate(`/people/${u.id}`)}>
                  <Td>
                    <Link
                      to={`/people/${u.id}`}
                      className="flex min-w-0 items-center gap-3"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Avatar name={u.displayName} size={30} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{u.displayName}</span>
                        <span className="block truncate text-sm text-text-tertiary">
                          {u.jobTitle ?? u.email}
                        </span>
                      </span>
                    </Link>
                  </Td>
                  <Td className="hidden text-text-secondary md:table-cell">
                    {u.roles.map((r) => r.name).join(', ')}
                  </Td>
                  <Td className="hidden text-text-secondary lg:table-cell">
                    {u.teams.map((t) => t.name).join(', ') || '—'}
                  </Td>
                  <Td className="hidden text-text-secondary xl:table-cell">
                    {u.location?.name ?? '—'}
                  </Td>
                  <Td>
                    <UserStatus status={u.status} />
                  </Td>
                  <Td className="hidden text-sm text-text-secondary sm:table-cell">
                    {u.lastLoginAt ? formatRelative(u.lastLoginAt) : 'Never'}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <Pagination
            page={people.data.page}
            pageCount={people.data.pageCount}
            total={people.data.total}
            pageSize={people.data.pageSize}
            onPage={(page) => setState({ page: String(page) })}
            noun="people"
          />
        </>
      )}
    </>
  );
}

export function PeopleListPage() {
  return (
    <RequirePermission all={['users.view']}>
      <PeopleList />
    </RequirePermission>
  );
}
