import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { MoreHorizontal, Pencil, ShieldCheck } from 'lucide-react';
import {
  Avatar,
  Button,
  Checkbox,
  ConfirmDialog,
  DescriptionList,
  DialogContent,
  DialogRoot,
  ErrorState,
  IconButton,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  Notice,
  PageHeader,
  Section,
  SheetContent,
  Skeleton,
  StatusText,
  Table,
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
import type { identity } from '@a5/contracts';
import { useCan, usePermissions } from '@/features/auth/session';
import { useRoles } from '@/features/access/api';
import { useAuth } from '@/lib/auth-store';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { applyServerErrors } from '@/lib/forms';
import { describeUserAgent, formatDate, formatDateTime, formatRelative } from '@/lib/format';
import {
  useDeactivatePerson,
  usePerson,
  usePersonLogins,
  usePersonSessions,
  useReactivatePerson,
  useResendInvitation,
  useRevokePersonSessions,
  useSetPersonRoles,
  useUpdatePerson,
} from './api';
import { PersonForm, fromDetail, toRequest } from './person-form';
import { UserStatus } from './status';

const FIELDS = [
  'email',
  'firstName',
  'lastName',
  'employeeId',
  'jobTitle',
  'phone',
  'hiredAt',
  'locationId',
  'departmentId',
  'teamIds',
  'managerIds',
  'trainerIds',
];

function people(list: Array<{ id: string; displayName: string }>) {
  if (list.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {list.map((p) => (
        <Link key={p.id} to={`/people/${p.id}`} className="text-information hover:underline">
          {p.displayName}
        </Link>
      ))}
    </span>
  );
}

function RolesDialog({
  user,
  open,
  onOpenChange,
}: {
  user: identity.UserDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const roles = useRoles();
  const setRoles = useSetPersonRoles(user.id);
  const [selected, setSelected] = useState<string[]>(user.roles.map((r) => r.id));
  const [error, setError] = useState<string | null>(null);
  return (
    <DialogRoot
      open={open}
      onOpenChange={(o) => {
        if (o) setSelected(user.roles.map((r) => r.id));
        setError(null);
        onOpenChange(o);
      }}
    >
      <DialogContent
        title={`Roles for ${user.displayName}`}
        description="Roles decide what this person can see and do. Changes apply to their next request."
        footer={
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={setRoles.isPending}
              disabled={selected.length === 0}
              onClick={async () => {
                setError(null);
                try {
                  await setRoles.mutateAsync(selected);
                  toast.success('Roles updated');
                  onOpenChange(false);
                } catch (err) {
                  setError(errorMessage(err));
                }
              }}
            >
              Save roles
            </Button>
          </>
        }
      >
        <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border">
          {roles.data?.items.map((r) => (
            <label
              key={r.id}
              className="flex cursor-pointer items-start gap-3 bg-surface px-4 py-3 hover:bg-surface-hover"
            >
              <Checkbox
                className="mt-0.5"
                checked={selected.includes(r.id)}
                onCheckedChange={(c) =>
                  setSelected((s) => (c ? [...s, r.id] : s.filter((x) => x !== r.id)))
                }
              />
              <span>
                <span className="block font-medium">{r.name}</span>
                <span className="block text-sm text-text-secondary">{r.description}</span>
              </span>
            </label>
          ))}
        </div>
        {selected.length === 0 && (
          <p className="mt-2 text-sm text-warning">Keep at least one role.</p>
        )}
        {error && (
          <p role="alert" className="mt-3 rounded bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
      </DialogContent>
    </DialogRoot>
  );
}

function ActivityTab({ userId }: { userId: string }) {
  const canView = useCan('sessions.view');
  const canRevoke = useCan('sessions.revoke');
  const sessions = usePersonSessions(userId, canView);
  const logins = usePersonLogins(userId, canView);
  const revoke = useRevokePersonSessions(userId);
  const [confirm, setConfirm] = useState(false);
  if (!canView)
    return <Notice tone="information">Your role does not include viewing sign-in activity.</Notice>;
  return (
    <>
      <Section
        title="Active sessions"
        actions={
          canRevoke &&
          (sessions.data?.items.length ?? 0) > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setConfirm(true)}>
              Sign out everywhere
            </Button>
          )
        }
      >
        {sessions.isError ? (
          <ErrorState message={errorMessage(sessions.error)} onRetry={() => sessions.refetch()} />
        ) : sessions.data?.items.length === 0 ? (
          <p className="text-sm text-text-secondary">No active sessions.</p>
        ) : (
          <Table caption="Active sessions">
            <THead>
              <tr>
                <Th>Device</Th>
                <Th>IP address</Th>
                <Th>Last active</Th>
                <Th>Signed in</Th>
              </tr>
            </THead>
            <TBody>
              {sessions.data?.items.map((s) => (
                <Tr key={s.id}>
                  <Td>{describeUserAgent(s.userAgent)}</Td>
                  <Td className="font-mono text-sm">{s.ip ?? '—'}</Td>
                  <Td>{formatRelative(s.lastSeenAt)}</Td>
                  <Td className="text-text-secondary">{formatDateTime(s.createdAt)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Section>
      <Section title="Recent sign-in attempts">
        {logins.data?.items.length === 0 ? (
          <p className="text-sm text-text-secondary">No sign-in attempts recorded.</p>
        ) : (
          <Table caption="Sign-in attempts">
            <THead>
              <tr>
                <Th>When</Th>
                <Th>Result</Th>
                <Th>Device</Th>
                <Th>IP address</Th>
              </tr>
            </THead>
            <TBody>
              {logins.data?.items.map((l) => (
                <Tr key={l.id}>
                  <Td>{formatDateTime(l.occurredAt)}</Td>
                  <Td>
                    {l.success ? (
                      <StatusText tone="success">Signed in</StatusText>
                    ) : (
                      <StatusText tone="danger">
                        {l.reason?.replace(/_/g, ' ') ?? 'Failed'}
                      </StatusText>
                    )}
                  </Td>
                  <Td>{describeUserAgent(l.userAgent)}</Td>
                  <Td className="font-mono text-sm">{l.ip ?? '—'}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Section>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Sign out of every device?"
        description="All of this person's sessions end immediately. They can sign in again with their password."
        confirmLabel="Sign out everywhere"
        tone="danger"
        loading={revoke.isPending}
        error={revoke.error ? errorMessage(revoke.error) : null}
        onConfirm={async () => {
          const r = await revoke.mutateAsync();
          toast.success(`${r.revoked} session${r.revoked === 1 ? '' : 's'} ended`);
          setConfirm(false);
        }}
      />
    </>
  );
}

export function PersonDetailPage() {
  const { id = '' } = useParams();
  const person = usePerson(id);
  const permissions = usePermissions();
  const selfId = useAuth((s) => s.user?.id);
  const [editing, setEditing] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const update = useUpdatePerson(id);
  const deactivate = useDeactivatePerson(id);
  const reactivate = useReactivatePerson(id);
  const resend = useResendInvitation(id);

  if (person.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-6 h-48 w-full" />
      </div>
    );
  }
  if (person.isError) {
    const notFound = person.error instanceof ApiError && person.error.isNotFound;
    return (
      <>
        <PageHeader
          title={notFound ? 'Person not found' : 'Person'}
          breadcrumbs={[{ label: 'People', to: '/people' }]}
        />
        {notFound ? (
          <Notice tone="warning">
            This person does not exist or is outside the teams you can see.
          </Notice>
        ) : (
          <ErrorState message={errorMessage(person.error)} onRetry={() => person.refetch()} />
        )}
      </>
    );
  }

  const u = person.data;
  const isSelf = u.id === selfId;
  const canEdit = permissions.has('users.update');
  const canRoles = permissions.has('roles.assign') && !isSelf;
  const canDisable = permissions.has('users.disable') && !isSelf;
  const canInvite = permissions.has('users.create') && u.status === 'invited';
  const hasMenu = canDisable || canInvite;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'People', to: '/people' }, { label: u.displayName }]}
        title={
          <span className="flex items-center gap-3">
            <Avatar name={u.displayName} size={36} />
            {u.displayName}
          </span>
        }
        meta={
          <>
            <UserStatus status={u.status} />
            {u.jobTitle && <span>{u.jobTitle}</span>}
            {u.teams.length > 0 && <span>{u.teams.map((t) => t.name).join(', ')}</span>}
            {u.location && <span>{u.location.name}</span>}
          </>
        }
        actions={
          <>
            {canEdit && (
              <Button leading={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            {canRoles && (
              <Button
                leading={<ShieldCheck className="size-4" />}
                onClick={() => setRolesOpen(true)}
              >
                Roles
              </Button>
            )}
            {hasMenu && (
              <MenuRoot>
                <MenuTrigger asChild>
                  <IconButton label="More actions" variant="secondary">
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                </MenuTrigger>
                <MenuContent>
                  {canInvite && (
                    <MenuItem
                      onSelect={async () => {
                        try {
                          const r = await resend.mutateAsync();
                          if (r.activationUrl) {
                            await navigator.clipboard
                              .writeText(r.activationUrl)
                              .catch(() => undefined);
                            toast.success(
                              'New invitation created',
                              'The activation link was copied to your clipboard.',
                            );
                          } else toast.success('Invitation sent again');
                        } catch (err) {
                          toast.error('Invitation not sent', errorMessage(err));
                        }
                      }}
                    >
                      Resend invitation
                    </MenuItem>
                  )}
                  {canInvite && canDisable && <MenuSeparator />}
                  {canDisable &&
                    (u.status === 'deactivated' ? (
                      <MenuItem
                        onSelect={async () => {
                          try {
                            await reactivate.mutateAsync();
                            toast.success(`${u.firstName} can sign in again`);
                          } catch (err) {
                            toast.error('Could not reactivate', errorMessage(err));
                          }
                        }}
                      >
                        Reactivate account
                      </MenuItem>
                    ) : (
                      <MenuItem tone="danger" onSelect={() => setDeactivating(true)}>
                        Deactivate account
                      </MenuItem>
                    ))}
                </MenuContent>
              </MenuRoot>
            )}
          </>
        }
      />

      {u.status === 'deactivated' && (
        <Notice
          tone="warning"
          className="mb-6"
          title={`Deactivated ${formatDate(u.deactivatedAt)}`}
        >
          {u.deactivationReason}. Their training history and certificates are kept.
        </Notice>
      )}

      <TabsRoot defaultValue="overview">
        <TabsList
          className="mb-6"
          items={[
            { value: 'overview', label: 'Overview' },
            { value: 'access', label: 'Access' },
            ...(permissions.has('sessions.view') || isSelf
              ? [{ value: 'activity', label: 'Sign-in activity' }]
              : []),
          ]}
        />
        <TabsContent value="overview" className="max-w-[960px]">
          <Section title="Profile">
            <DescriptionList
              items={[
                {
                  label: 'Email',
                  value: (
                    <a href={`mailto:${u.email}`} className="text-information hover:underline">
                      {u.email}
                    </a>
                  ),
                },
                { label: 'Mobile phone', value: u.phone },
                {
                  label: 'Employee ID',
                  value: u.employeeId && <span className="font-mono">{u.employeeId}</span>,
                },
                { label: 'Start date', value: u.hiredAt && formatDate(u.hiredAt) },
                { label: 'Location', value: u.location?.name },
                { label: 'Department', value: u.department?.name },
              ]}
            />
          </Section>
          <Section title="Reporting">
            <DescriptionList
              items={[
                {
                  label: 'Teams',
                  value: u.teams.length ? u.teams.map((t) => t.name).join(', ') : null,
                },
                { label: 'Managers', value: people(u.managers) },
                { label: 'Trainers', value: people(u.trainers) },
                {
                  label: 'Manages teams',
                  value: u.managedTeams.length
                    ? u.managedTeams.map((t) => t.name).join(', ')
                    : null,
                },
                { label: 'Direct reports and trainees', value: people(u.directReports) },
              ]}
            />
          </Section>
          <Section title="Account">
            <DescriptionList
              items={[
                {
                  label: 'Activated',
                  value: u.activatedAt ? formatDate(u.activatedAt) : 'Not yet',
                },
                {
                  label: 'Last sign-in',
                  value: u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never',
                },
                { label: 'Created', value: formatDate(u.createdAt) },
              ]}
              columns={3}
            />
          </Section>
        </TabsContent>
        <TabsContent value="access">
          <Section
            title="Roles"
            description="Permissions come from roles. A role's data scope decides whose records its permissions cover."
          >
            <ul className="divide-y divide-divider rounded-lg border border-border bg-surface">
              {u.roles.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <span className="font-medium">{r.name}</span>
                  {permissions.has('roles.view') && (
                    <Link
                      to={`/admin/roles/${r.id}`}
                      className="text-sm text-information hover:underline"
                    >
                      View permissions
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        </TabsContent>
        <TabsContent value="activity">
          <ActivityTab userId={u.id} />
        </TabsContent>
      </TabsRoot>

      <DialogRoot
        open={editing}
        onOpenChange={(o) => {
          setEditing(o);
          setFormError(null);
        }}
      >
        {editing && (
          <SheetContent title={`Edit ${u.displayName}`}>
            <PersonForm
              mode="edit"
              defaultValues={fromDetail(u)}
              initialPeople={[...u.managers, ...u.trainers]}
              selfId={u.id}
              submitLabel="Save changes"
              formError={formError}
              onCancel={() => setEditing(false)}
              onSubmit={async (values, setError) => {
                setFormError(null);
                try {
                  await update.mutateAsync(toRequest(values));
                  toast.success('Changes saved');
                  setEditing(false);
                } catch (err) {
                  setFormError(applyServerErrors(err, setError, FIELDS));
                }
              }}
            />
          </SheetContent>
        )}
      </DialogRoot>

      <RolesDialog user={u} open={rolesOpen} onOpenChange={setRolesOpen} />

      <ConfirmDialog
        open={deactivating}
        onOpenChange={setDeactivating}
        title={`Deactivate ${u.displayName}?`}
        description="They are signed out everywhere and can no longer sign in. Training records and certificates are kept, and you can reactivate the account later."
        confirmLabel="Deactivate"
        tone="danger"
        reasonLabel="Reason"
        reasonRequired
        loading={deactivate.isPending}
        error={deactivate.error ? errorMessage(deactivate.error) : null}
        onConfirm={async (reason) => {
          await deactivate.mutateAsync(reason);
          toast.success(`${u.displayName} was deactivated`);
          setDeactivating(false);
        }}
      />
    </>
  );
}
