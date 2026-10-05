import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Copy, MoreHorizontal, Pencil, RotateCcw } from 'lucide-react';
import { permissionsByModule, type PermissionKey } from '@a5/permissions';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  ErrorState,
  IconButton,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
  Notice,
  PageHeader,
  Skeleton,
  Tag,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { UnsavedBar } from '@/app/shell/unsaved-bar';
import { usePermissions } from '@/features/auth/session';
import { errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { useArchiveRole, useResetRole, useRole, useRoles, useSetRolePermissions } from './api';
import { CreateRoleDialog, EditRoleDialog } from './role-dialogs';
import { SCOPE_LABELS } from './scope';

const MODULES = permissionsByModule();

function RoleDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const role = useRole(id);
  const roles = useRoles();
  const mine = usePermissions();
  const save = useSetRolePermissions(id);
  const reset = useResetRole(id);
  const archive = useArchiveRole(id);
  const [selected, setSelected] = useState<Set<PermissionKey>>(new Set());
  const [editing, setEditing] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (role.data) setSelected(new Set(role.data.permissions));
  }, [role.data]);

  const original = useMemo(() => new Set(role.data?.permissions ?? []), [role.data]);
  const changes = useMemo(() => {
    let n = 0;
    for (const p of selected) if (!original.has(p)) n++;
    for (const p of original) if (!selected.has(p)) n++;
    return n;
  }, [selected, original]);

  if (role.isPending) return <Skeleton className="h-64 w-full" />;
  if (role.isError)
    return <ErrorState message={errorMessage(role.error)} onRetry={() => role.refetch()} />;
  const r = role.data;
  const canEditPermissions = mine.has('permissions.manage') && !r.locked && !r.archived;
  // Only permissions the editor holds can be changed (server enforces the same rule).
  const editable = (key: PermissionKey) => canEditPermissions && mine.has(key);

  const toggle = (key: PermissionKey, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <div className={cn(changes > 0 && 'pb-20')}>
      <PageHeader
        breadcrumbs={[{ label: 'Roles & permissions', to: '/admin/roles' }, { label: r.name }]}
        title={r.name}
        description={r.description}
        meta={
          <>
            <span>
              Data scope:{' '}
              <strong className="font-medium text-text-primary">
                {SCOPE_LABELS[r.dataScope].label}
              </strong>
            </span>
            <span className="tabular">{r.userCount} people</span>
            {r.locked ? (
              <Tag>Protected</Tag>
            ) : r.isSystem ? (
              <Tag>Built-in</Tag>
            ) : (
              <Tag tone="accent">Custom</Tag>
            )}
            {r.modifiedFromDefault && <Tag tone="warning">Modified from default</Tag>}
            {r.archived && <Tag tone="danger">Archived</Tag>}
          </>
        }
        actions={
          <>
            {mine.has('roles.update') && !r.locked && !r.archived && (
              <Button leading={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <MenuRoot>
              <MenuTrigger asChild>
                <IconButton label="More actions" variant="secondary">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              </MenuTrigger>
              <MenuContent>
                {mine.has('roles.create') && (
                  <MenuItem icon={<Copy />} onSelect={() => setCloning(true)}>
                    Clone role
                  </MenuItem>
                )}
                {mine.has('permissions.manage') && r.isSystem && !r.locked && (
                  <MenuItem
                    icon={<RotateCcw />}
                    disabled={!r.modifiedFromDefault}
                    onSelect={() => setConfirmReset(true)}
                  >
                    Reset to default
                  </MenuItem>
                )}
                {mine.has('roles.update') && !r.isSystem && !r.archived && (
                  <MenuItem tone="danger" onSelect={() => setConfirmArchive(true)}>
                    Archive role
                  </MenuItem>
                )}
              </MenuContent>
            </MenuRoot>
          </>
        }
      />

      {r.locked && (
        <Notice className="mb-6" title="This role is protected">
          The super administrator role always has every permission and cannot be edited.
        </Notice>
      )}
      {!r.locked && !mine.has('permissions.manage') && (
        <Notice className="mb-6">
          You can view this role. Changing its permissions requires the “Manage permissions”
          permission.
        </Notice>
      )}

      <div className="grid gap-6">
        {MODULES.map(({ module, permissions }) => {
          const keys = permissions.map((p) => p.key as PermissionKey);
          const on = keys.filter((k) => selected.has(k)).length;
          const allEditable = keys.every(editable);
          return (
            <section
              key={module.key}
              aria-labelledby={`m-${module.key}`}
              className="overflow-hidden rounded-lg border border-border bg-surface"
            >
              <header className="flex items-center gap-3 border-b border-border bg-surface-sunken/60 px-4 py-2.5">
                <Checkbox
                  aria-label={`All ${module.label} permissions`}
                  disabled={!allEditable}
                  checked={on === keys.length ? true : on === 0 ? false : 'indeterminate'}
                  onCheckedChange={(c) => keys.forEach((k) => toggle(k, c === true))}
                />
                <h2 id={`m-${module.key}`} className="flex-1 text-sm font-semibold">
                  {module.label}
                </h2>
                <span className="tabular text-xs text-text-tertiary">
                  {on} of {keys.length}
                </span>
              </header>
              <ul className="divide-y divide-divider">
                {permissions.map((p) => {
                  const key = p.key as PermissionKey;
                  const checked = selected.has(key);
                  const changed = checked !== original.has(key);
                  return (
                    <li key={key}>
                      <label
                        className={cn(
                          'flex items-start gap-3 px-4 py-2.5',
                          editable(key)
                            ? 'cursor-pointer hover:bg-surface-hover'
                            : 'cursor-default',
                        )}
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={checked}
                          disabled={!editable(key)}
                          onCheckedChange={(c) => toggle(key, c === true)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-x-2">
                            <span className="font-medium">{p.label}</span>
                            <code className="font-mono text-xs text-text-tertiary">{key}</code>
                            {p.scoped && <Tag>Scoped</Tag>}
                            {changed && <Tag tone="accent">{checked ? 'Adding' : 'Removing'}</Tag>}
                          </span>
                          <span className="block text-sm text-text-secondary">{p.description}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      {changes > 0 && (
        <UnsavedBar
          actions={
            <>
              <Button onClick={() => setSelected(new Set(original))} disabled={save.isPending}>
                Discard
              </Button>
              <Button
                variant="primary"
                loading={save.isPending}
                onClick={async () => {
                  setSaveError(null);
                  try {
                    await save.mutateAsync([...selected]);
                    toast.success('Permissions saved');
                  } catch (err) {
                    setSaveError(errorMessage(err));
                  }
                }}
              >
                Save permissions
              </Button>
            </>
          }
        >
          <p>
            <strong className="font-semibold">{changes}</strong> unsaved{' '}
            {changes === 1 ? 'change' : 'changes'} · applies to {r.userCount} people on their next
            request
            {saveError && <span className="mt-1 block text-danger">{saveError}</span>}
          </p>
        </UnsavedBar>
      )}

      <EditRoleDialog role={r} open={editing} onOpenChange={setEditing} />
      {roles.data && (
        <CreateRoleDialog
          open={cloning}
          onOpenChange={setCloning}
          roles={roles.data.items}
          cloneFrom={r.id}
        />
      )}
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={`Reset ${r.name} to its defaults?`}
        description="Permissions and data scope return to the shipped defaults. Custom changes to this role are lost."
        confirmLabel="Reset role"
        loading={reset.isPending}
        error={reset.error ? errorMessage(reset.error) : null}
        onConfirm={async () => {
          await reset.mutateAsync();
          toast.success(`${r.name} reset to defaults`);
          setConfirmReset(false);
        }}
      />
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`Archive ${r.name}?`}
        description="Archived roles cannot be assigned. Roles that are still assigned to people cannot be archived."
        confirmLabel="Archive"
        tone="danger"
        loading={archive.isPending}
        error={archive.error ? errorMessage(archive.error) : null}
        onConfirm={async () => {
          await archive.mutateAsync();
          toast.success(`${r.name} archived`);
          navigate('/admin/roles');
        }}
      />
    </div>
  );
}

export function RoleDetailPage() {
  return (
    <RequirePermission all={['roles.view']}>
      <RoleDetail />
    </RequirePermission>
  );
}
