import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Pencil, UsersRound } from 'lucide-react';
import {
  Avatar,
  Button,
  ConfirmDialog,
  DialogContent,
  DialogRoot,
  EmptyState,
  ErrorState,
  Field,
  Notice,
  PageHeader,
  Section,
  Skeleton,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { usePermissions } from '@/features/auth/session';
import { PeoplePicker } from '@/features/people/people-picker';
import { UserStatus } from '@/features/people/status';
import { errorMessage } from '@/lib/api/errors';
import { useArchiveUnit, useSetTeamMembers, useTeam } from './api';
import { TeamDialog } from './team-dialog';

function Team() {
  const { id = '' } = useParams();
  const team = useTeam(id);
  const p = usePermissions();
  const setMembers = useSetTeamMembers(id);
  const archive = useArchiveUnit('teams');
  const [editing, setEditing] = useState(false);
  const [managing, setManaging] = useState(false);
  const [members, setMembersDraft] = useState<string[]>([]);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (team.isPending) return <Skeleton className="h-64 w-full" />;
  if (team.isError)
    return <ErrorState message={errorMessage(team.error)} onRetry={() => team.refetch()} />;
  const t = team.data;
  const canManage = p.has('teams.manage');

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Organization', to: '/admin/organization' }, { label: t.name }]}
        title={t.name}
        description={t.description}
        meta={
          <>
            {t.location && <span>{t.location.name}</span>}
            {t.department && <span>{t.department.name}</span>}
            <span>
              Managed by {t.managers.map((m) => m.displayName).join(', ') || 'nobody yet'}
            </span>
          </>
        }
        actions={
          canManage &&
          !t.archived && (
            <>
              <Button leading={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                leading={<UsersRound className="size-4" />}
                onClick={() => {
                  setMembersDraft(t.members.map((m) => m.id));
                  setManaging(true);
                }}
              >
                Change members
              </Button>
              <Button variant="ghost" onClick={() => setConfirmArchive(true)}>
                Archive
              </Button>
            </>
          )
        }
      />
      {t.archived && (
        <Notice
          tone="warning"
          className="mb-6"
          title="This team is archived"
          action={
            canManage && (
              <Button size="sm" onClick={() => archive.mutate({ id: t.id, archived: false })}>
                Restore
              </Button>
            )
          }
        >
          Archived teams keep their history but no longer grant managers visibility.
        </Notice>
      )}
      <Section title={`Members (${t.members.length})`}>
        {t.members.length === 0 ? (
          <EmptyState
            title="No members yet"
            description="Add the representatives this team's managers should follow."
          />
        ) : (
          <Table caption="Team members">
            <THead>
              <tr>
                <Th>Name</Th>
                <Th className="hidden md:table-cell">Email</Th>
                <Th>Status</Th>
              </tr>
            </THead>
            <TBody>
              {t.members.map((m) => (
                <Tr key={m.id}>
                  <Td>
                    <Link to={`/people/${m.id}`} className="flex items-center gap-3">
                      <Avatar name={m.displayName} />
                      <span>
                        <span className="block font-medium">{m.displayName}</span>
                        <span className="block text-sm text-text-tertiary">{m.jobTitle}</span>
                      </span>
                    </Link>
                  </Td>
                  <Td className="hidden text-text-secondary md:table-cell">{m.email}</Td>
                  <Td>
                    <UserStatus status={m.status} />
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Section>

      <TeamDialog team={t} open={editing} onOpenChange={setEditing} />
      <DialogRoot
        open={managing}
        onOpenChange={(o) => {
          setManaging(o);
          setError(null);
        }}
      >
        <DialogContent
          title={`Members of ${t.name}`}
          description="People can belong to several teams. Moving someone between teams changes which managers see their training."
          footer={
            <>
              <Button onClick={() => setManaging(false)}>Cancel</Button>
              <Button
                variant="primary"
                loading={setMembers.isPending}
                onClick={async () => {
                  setError(null);
                  try {
                    await setMembers.mutateAsync(members);
                    toast.success('Members updated');
                    setManaging(false);
                  } catch (err) {
                    setError(errorMessage(err));
                  }
                }}
              >
                Save members
              </Button>
            </>
          }
        >
          <Field label="Members">
            <PeoplePicker
              value={members}
              onChange={setMembersDraft}
              initial={t.members}
              placeholder="Search to add people"
            />
          </Field>
          {error && (
            <p role="alert" className="mt-3 rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </DialogContent>
      </DialogRoot>
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`Archive ${t.name}?`}
        description="Its managers lose visibility of members through this team. Members keep their training records."
        confirmLabel="Archive team"
        tone="danger"
        loading={archive.isPending}
        error={archive.error ? errorMessage(archive.error) : null}
        onConfirm={async () => {
          await archive.mutateAsync({ id: t.id, archived: true });
          toast.success(`${t.name} archived`);
          setConfirmArchive(false);
        }}
      />
    </>
  );
}

export function TeamPage() {
  return (
    <RequirePermission any={['teams.view', 'teams.manage']}>
      <Team />
    </RequirePermission>
  );
}
