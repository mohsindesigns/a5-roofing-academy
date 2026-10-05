import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Grid3x3, Plus } from 'lucide-react';
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Table,
  TableSkeleton,
  TBody,
  Tag,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { usePermissions } from '@/features/auth/session';
import { errorMessage } from '@/lib/api/errors';
import { useRoles } from './api';
import { CreateRoleDialog } from './role-dialogs';
import { SCOPE_LABELS, byHierarchy } from './scope';

function Roles() {
  const roles = useRoles();
  const navigate = useNavigate();
  const p = usePermissions();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title="Roles & permissions"
        description="Roles bundle permissions with a data scope. People can hold several roles; the widest scope wins."
        actions={
          <>
            <Button asChild leading={<Grid3x3 className="size-4" />}>
              <Link to="/admin/permissions">Permission matrix</Link>
            </Button>
            {p.has('roles.create') && (
              <Button
                variant="primary"
                leading={<Plus className="size-4" />}
                onClick={() => setCreating(true)}
              >
                New role
              </Button>
            )}
          </>
        }
      />
      {roles.isPending ? (
        <TableSkeleton columns={4} rows={7} />
      ) : roles.isError ? (
        <ErrorState message={errorMessage(roles.error)} onRetry={() => roles.refetch()} />
      ) : roles.data.items.length === 0 ? (
        <EmptyState title="No roles" />
      ) : (
        <Table caption="Roles">
          <THead>
            <tr>
              <Th>Role</Th>
              <Th className="hidden md:table-cell">Data scope</Th>
              <Th className="text-right">People</Th>
              <Th className="hidden text-right sm:table-cell">Permissions</Th>
            </tr>
          </THead>
          <TBody>
            {byHierarchy(roles.data.items).map((r) => (
              <Tr key={r.id} onClick={() => navigate(`/admin/roles/${r.id}`)}>
                <Td>
                  <Link
                    to={`/admin/roles/${r.id}`}
                    className="font-medium"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {r.name}
                  </Link>
                  <span className="ml-2 inline-flex gap-1 align-middle">
                    {r.locked ? (
                      <Tag>Protected</Tag>
                    ) : r.isSystem ? (
                      <Tag>Built-in</Tag>
                    ) : (
                      <Tag tone="accent">Custom</Tag>
                    )}
                    {r.modifiedFromDefault && <Tag tone="warning">Modified</Tag>}
                  </span>
                  {r.description && (
                    <p className="mt-0.5 line-clamp-1 max-w-[60ch] text-sm text-text-secondary">
                      {r.description}
                    </p>
                  )}
                </Td>
                <Td className="hidden text-text-secondary md:table-cell">
                  {SCOPE_LABELS[r.dataScope].label}
                </Td>
                <Td className="tabular text-right">{r.userCount}</Td>
                <Td className="tabular hidden text-right text-text-secondary sm:table-cell">
                  {r.permissionCount}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      {roles.data && (
        <CreateRoleDialog open={creating} onOpenChange={setCreating} roles={roles.data.items} />
      )}
    </>
  );
}

export function RolesPage() {
  return (
    <RequirePermission all={['roles.view']}>
      <Roles />
    </RequirePermission>
  );
}
