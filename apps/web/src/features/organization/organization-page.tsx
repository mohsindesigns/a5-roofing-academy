import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Plus } from 'lucide-react';
import type { identity } from '@a5/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  StatusText,
  Switch,
  Table,
  TableSkeleton,
  TabsContent,
  TabsList,
  TabsRoot,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { usePermissions } from '@/features/auth/session';
import { errorMessage } from '@/lib/api/errors';
import { useArchiveUnit, useDepartments, useLocations, useTeams } from './api';
import { TeamDialog } from './team-dialog';
import { UnitDialog } from './unit-dialog';

function TeamsTab() {
  const navigate = useNavigate();
  const p = usePermissions();
  const [archived, setArchived] = useState(false);
  const teams = useTeams({ includeArchived: archived });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <Switch checked={archived} onCheckedChange={setArchived} /> Show archived teams
        </label>
        {p.has('teams.manage') && (
          <Button
            variant="primary"
            leading={<Plus className="size-4" />}
            onClick={() => setCreating(true)}
          >
            New team
          </Button>
        )}
      </div>
      {teams.isPending ? (
        <TableSkeleton columns={5} />
      ) : teams.isError ? (
        <ErrorState message={errorMessage(teams.error)} onRetry={() => teams.refetch()} />
      ) : teams.data.items.length === 0 ? (
        <EmptyState
          title="No teams yet"
          description="Teams connect sales representatives with the managers who follow their training."
        />
      ) : (
        <Table caption="Teams">
          <THead>
            <tr>
              <Th>Team</Th>
              <Th className="hidden md:table-cell">Location</Th>
              <Th>Managers</Th>
              <Th className="text-right">Members</Th>
            </tr>
          </THead>
          <TBody>
            {teams.data.items.map((t) => (
              <Tr key={t.id} onClick={() => navigate(`/admin/organization/teams/${t.id}`)}>
                <Td>
                  <Link
                    to={`/admin/organization/teams/${t.id}`}
                    className="font-medium"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {t.name}
                  </Link>
                  {t.archived && <StatusText className="ml-2">Archived</StatusText>}
                  {t.description && (
                    <p className="line-clamp-1 max-w-[56ch] text-sm text-text-secondary">
                      {t.description}
                    </p>
                  )}
                </Td>
                <Td className="hidden text-text-secondary md:table-cell">
                  {t.location?.name ?? '—'}
                </Td>
                <Td className="text-text-secondary">
                  {t.managers.map((m) => m.displayName).join(', ') || (
                    <span className="text-warning">No manager</span>
                  )}
                </Td>
                <Td className="tabular text-right">{t.memberCount}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      <TeamDialog
        open={creating}
        onOpenChange={setCreating}
        onSaved={(t) => navigate(`/admin/organization/teams/${t.id}`)}
      />
    </>
  );
}

function UnitsTab({ kind }: { kind: 'locations' | 'departments' }) {
  const p = usePermissions();
  const canManage = p.has(kind === 'locations' ? 'locations.manage' : 'departments.manage');
  const [archived, setArchived] = useState(false);
  const locations = useLocations(archived);
  const departments = useDepartments(archived);
  const query = kind === 'locations' ? locations : departments;
  const archive = useArchiveUnit(kind);
  const [editing, setEditing] = useState<(identity.Location | identity.Department) | null | 'new'>(
    null,
  );
  const noun = kind === 'locations' ? 'location' : 'department';
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <Switch checked={archived} onCheckedChange={setArchived} /> Show archived
        </label>
        {canManage && (
          <Button
            variant="primary"
            leading={<Plus className="size-4" />}
            onClick={() => setEditing('new')}
          >
            New {noun}
          </Button>
        )}
      </div>
      {query.isPending ? (
        <TableSkeleton columns={3} rows={4} />
      ) : query.isError ? (
        <ErrorState message={errorMessage(query.error)} onRetry={() => query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState title={`No ${kind} yet`} />
      ) : (
        <Table caption={kind}>
          <THead>
            <tr>
              <Th>Name</Th>
              <Th className="hidden sm:table-cell">Code</Th>
              {kind === 'locations' && <Th className="hidden md:table-cell">City</Th>}
              <Th className="text-right">People</Th>
              {canManage && <Th className="w-0 text-right">Actions</Th>}
            </tr>
          </THead>
          <TBody>
            {query.data.items.map((u) => (
              <Tr key={u.id}>
                <Td className="font-medium">
                  {u.name}
                  {u.archived && <StatusText className="ml-2">Archived</StatusText>}
                </Td>
                <Td className="hidden font-mono text-sm sm:table-cell">{u.code ?? '—'}</Td>
                {kind === 'locations' && (
                  <Td className="hidden text-text-secondary md:table-cell">
                    {[(u as identity.Location).city, (u as identity.Location).state]
                      .filter(Boolean)
                      .join(', ') || '—'}
                  </Td>
                )}
                <Td className="tabular text-right">{u.userCount}</Td>
                {canManage && (
                  <Td className="text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(u)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await archive.mutateAsync({ id: u.id, archived: !u.archived });
                          toast.success(`${u.name} ${u.archived ? 'restored' : 'archived'}`);
                        } catch (err) {
                          toast.error('Change not saved', errorMessage(err));
                        }
                      }}
                    >
                      {u.archived ? 'Restore' : 'Archive'}
                    </Button>
                  </Td>
                )}
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      <UnitDialog
        kind={kind}
        unit={editing && editing !== 'new' ? editing : undefined}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      />
    </>
  );
}

function Organization() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'teams';
  return (
    <>
      <PageHeader
        title="Organization"
        description="Locations, departments and teams decide reporting lines and what each manager can see."
      />
      <TabsRoot value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList
          className="mb-5"
          items={[
            { value: 'teams', label: 'Teams' },
            { value: 'locations', label: 'Locations' },
            { value: 'departments', label: 'Departments' },
          ]}
        />
        <TabsContent value="teams">
          <TeamsTab />
        </TabsContent>
        <TabsContent value="locations">
          <UnitsTab kind="locations" />
        </TabsContent>
        <TabsContent value="departments">
          <UnitsTab kind="departments" />
        </TabsContent>
      </TabsRoot>
    </>
  );
}

export function OrganizationPage() {
  return (
    <RequirePermission any={['organization.view', 'teams.manage', 'locations.manage']}>
      <Organization />
    </RequirePermission>
  );
}
