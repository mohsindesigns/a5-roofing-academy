import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import type { identity } from '@a5/contracts';
import { getPermission, type PermissionKey } from '@a5/permissions';
import {
  Button,
  Checkbox,
  ErrorState,
  Input,
  Notice,
  PageHeader,
  Tag,
  TableSkeleton,
  Tooltip,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { UnsavedBar } from '@/app/shell/unsaved-bar';
import { usePermissions } from '@/features/auth/session';
import { errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { usePermissionMatrix, useSaveMatrix } from './api';
import { CreateRoleDialog } from './role-dialogs';
import { SCOPE_LABELS, byHierarchy } from './scope';

type Grants = Record<string, Set<PermissionKey>>;

function toGrants(matrix: identity.PermissionMatrix): Grants {
  return Object.fromEntries(matrix.roles.map((r) => [r.id, new Set(r.permissions)]));
}

function Matrix() {
  const matrix = usePermissionMatrix();
  const save = useSaveMatrix();
  const mine = usePermissions();
  const [grants, setGrants] = useState<Grants>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (matrix.data) setGrants(toGrants(matrix.data));
  }, [matrix.data]);

  const original = useMemo(() => (matrix.data ? toGrants(matrix.data) : {}), [matrix.data]);
  const changedRoles = useMemo(() => {
    if (!matrix.data) return [];
    return matrix.data.roles.filter((r) => {
      const a = original[r.id];
      const b = grants[r.id];
      if (!a || !b) return false;
      if (a.size !== b.size) return true;
      for (const p of a) if (!b.has(p)) return true;
      return false;
    });
  }, [grants, original, matrix.data]);

  if (matrix.isPending) return <TableSkeleton rows={12} columns={8} />;
  if (matrix.isError)
    return <ErrorState message={errorMessage(matrix.error)} onRetry={() => matrix.refetch()} />;

  const { catalog } = matrix.data;
  const roles = byHierarchy(matrix.data.roles);
  const canManage = mine.has('permissions.manage');
  const editable = (role: identity.RoleDetail, key: PermissionKey) =>
    canManage && !role.locked && mine.has(key);
  const term = filter.trim().toLowerCase();

  const set = (roleId: string, keys: PermissionKey[], on: boolean) =>
    setGrants((g) => {
      const next = new Set(g[roleId]);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return { ...g, [roleId]: next };
    });

  const changeCount = changedRoles.reduce((n, r) => {
    const a = original[r.id]!;
    const b = grants[r.id]!;
    let c = 0;
    for (const p of a) if (!b.has(p)) c++;
    for (const p of b) if (!a.has(p)) c++;
    return n + c;
  }, 0);

  return (
    <div className={cn(changeCount > 0 && 'pb-20')}>
      <PageHeader
        breadcrumbs={[
          { label: 'Roles & permissions', to: '/admin/roles' },
          { label: 'Permission matrix' },
        ]}
        title="Permission matrix"
        description="Every permission for every role. Scoped permissions follow the role's data scope shown under its name."
        actions={
          mine.has('roles.create') && (
            <Button
              variant="primary"
              leading={<Plus className="size-4" />}
              onClick={() => setCreating(true)}
            >
              Custom role
            </Button>
          )
        }
      />
      {!canManage && (
        <Notice className="mb-4">
          You can view the matrix. Editing requires the “Manage permissions” permission.
        </Notice>
      )}
      <div className="mb-3 max-w-sm">
        <Input
          type="search"
          aria-label="Filter permissions"
          placeholder="Filter permissions"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div
        className="overflow-auto rounded-lg border border-border bg-surface"
        style={{ maxHeight: 'calc(100dvh - 260px)' }}
      >
        <table className="w-max min-w-full border-separate border-spacing-0 text-left">
          <caption className="sr-only">Permissions by role</caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky top-0 left-0 z-30 min-w-[300px] border-r border-b border-border bg-surface px-4 py-2 text-xs font-medium text-text-secondary"
              >
                Permission
              </th>
              {roles.map((r) => (
                <th
                  key={r.id}
                  scope="col"
                  className="sticky top-0 z-20 w-[118px] border-b border-border bg-surface px-2 py-2 text-center align-bottom"
                >
                  <Link
                    to={`/admin/roles/${r.id}`}
                    className="block text-sm leading-tight font-semibold hover:underline"
                  >
                    {r.name}
                  </Link>
                  <span className="mt-0.5 block text-2xs font-normal text-text-tertiary">
                    {SCOPE_LABELS[r.dataScope].label}
                  </span>
                  {changedRoles.some((c) => c.id === r.id) && (
                    <Tag tone="accent" className="mt-1">
                      Edited
                    </Tag>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {catalog.modules.map((module) => {
              const perms = module.permissions.filter(
                (p) =>
                  !term ||
                  p.label.toLowerCase().includes(term) ||
                  p.key.includes(term) ||
                  p.description.toLowerCase().includes(term),
              );
              if (perms.length === 0) return null;
              const open = !collapsed.has(module.key) || Boolean(term);
              const keys = perms.map((p) => p.key);
              return (
                <Fragment key={module.key}>
                  <tr>
                    <th
                      scope="rowgroup"
                      className="sticky left-0 z-10 border-r border-b border-border bg-surface-sunken px-2 py-1.5"
                    >
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() =>
                          setCollapsed((c) => {
                            const n = new Set(c);
                            if (n.has(module.key)) n.delete(module.key);
                            else n.add(module.key);
                            return n;
                          })
                        }
                        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-sm font-semibold"
                      >
                        {open ? (
                          <ChevronDown className="size-4" />
                        ) : (
                          <ChevronRight className="size-4" />
                        )}
                        {module.label}
                        <span className="font-normal text-text-tertiary">({perms.length})</span>
                      </button>
                    </th>
                    {roles.map((r) => {
                      const g = grants[r.id] ?? new Set();
                      const on = keys.filter((k) => g.has(k)).length;
                      const canAll = keys.every((k) => editable(r, k));
                      return (
                        <td
                          key={r.id}
                          className="border-b border-border bg-surface-sunken px-2 text-center"
                        >
                          <Tooltip content={`Select all ${module.label} for ${r.name}`}>
                            <span className="inline-flex">
                              <Checkbox
                                aria-label={`All ${module.label} permissions for ${r.name}`}
                                disabled={!canAll}
                                checked={
                                  on === keys.length ? true : on === 0 ? false : 'indeterminate'
                                }
                                onCheckedChange={(c) => set(r.id, keys, c === true)}
                              />
                            </span>
                          </Tooltip>
                        </td>
                      );
                    })}
                  </tr>
                  {open &&
                    perms.map((p) => (
                      <tr key={p.key} className="group">
                        <th
                          scope="row"
                          className="sticky left-0 z-10 border-r border-b border-divider bg-surface px-4 py-2 font-normal group-hover:bg-surface-hover"
                        >
                          <span className="block text-base">{p.label}</span>
                          <span className="block text-xs text-text-tertiary">
                            <code className="font-mono">{p.key}</code>
                            {getPermission(p.key).scoped && ' · scoped'}
                            {p.platform && ' · platform'}
                          </span>
                        </th>
                        {roles.map((r) => {
                          const checked = grants[r.id]?.has(p.key) ?? false;
                          const changed = checked !== (original[r.id]?.has(p.key) ?? false);
                          return (
                            <td
                              key={r.id}
                              className={cn(
                                'border-b border-divider px-2 text-center group-hover:bg-surface-hover',
                                changed && 'bg-brand-secondary-soft',
                              )}
                            >
                              <Checkbox
                                aria-label={`${p.label} for ${r.name}`}
                                checked={checked}
                                disabled={!editable(r, p.key)}
                                onCheckedChange={(c) => set(r.id, [p.key], c === true)}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {changeCount > 0 && (
        <UnsavedBar
          actions={
            <>
              <Button onClick={() => setGrants(toGrants(matrix.data))} disabled={save.isPending}>
                Discard
              </Button>
              <Button
                variant="primary"
                loading={save.isPending}
                onClick={async () => {
                  setError(null);
                  try {
                    await save.mutateAsync({
                      changes: changedRoles.map((r) => ({
                        roleId: r.id,
                        permissions: [...(grants[r.id] ?? [])],
                      })),
                    });
                    toast.success(
                      'Permissions saved',
                      'Changes apply to each person on their next request.',
                    );
                  } catch (err) {
                    setError(errorMessage(err));
                  }
                }}
              >
                Save all changes
              </Button>
            </>
          }
        >
          <p>
            <strong className="font-semibold">{changeCount}</strong> unsaved{' '}
            {changeCount === 1 ? 'change' : 'changes'} across{' '}
            {changedRoles.map((r) => r.name).join(', ')}
            {error && <span className="mt-1 block text-danger">{error}</span>}
          </p>
        </UnsavedBar>
      )}
      <CreateRoleDialog open={creating} onOpenChange={setCreating} roles={roles} />
    </div>
  );
}

export function PermissionMatrixPage() {
  return (
    <RequirePermission all={['roles.view']}>
      <Matrix />
    </RequirePermission>
  );
}
