import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { identity } from '@a5/contracts';
import type { PermissionKey } from '@a5/permissions';
import { api } from '@/lib/api/client';
import { sessionKeys } from '@/features/auth/session';

export const accessKeys = {
  all: ['access'] as const,
  roles: (archived: boolean) => [...accessKeys.all, 'roles', { archived }] as const,
  role: (id: string) => [...accessKeys.all, 'role', id] as const,
  matrix: () => [...accessKeys.all, 'matrix'] as const,
};

export function useRoles(includeArchived = false) {
  return useQuery({
    queryKey: accessKeys.roles(includeArchived),
    queryFn: () =>
      api.get<{ items: identity.RoleSummary[] }>('/roles', {
        includeArchived: includeArchived ? 'true' : undefined,
      }),
  });
}

export function useRole(id: string) {
  return useQuery({
    queryKey: accessKeys.role(id),
    queryFn: () => api.get<identity.RoleDetail>(`/roles/${id}`),
  });
}

export function usePermissionMatrix() {
  return useQuery({
    queryKey: accessKeys.matrix(),
    queryFn: () => api.get<identity.PermissionMatrix>('/permissions/matrix'),
  });
}

function useInvalidateAccess() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: accessKeys.all });
    // The current user's own permissions may have changed.
    void qc.invalidateQueries({ queryKey: sessionKeys.me });
  };
}

export function useCreateRole() {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: (body: identity.CreateRoleRequest) => api.post<identity.RoleDetail>('/roles', body),
    onSuccess: invalidate,
  });
}

export function useUpdateRole(id: string) {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: (body: { name?: string; description?: string | null; dataScope?: string }) =>
      api.patch<identity.RoleDetail>(`/roles/${id}`, body),
    onSuccess: invalidate,
  });
}

export function useSetRolePermissions(id: string) {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: (permissions: PermissionKey[]) =>
      api.put<identity.RoleDetail>(`/roles/${id}/permissions`, { permissions }),
    onSuccess: invalidate,
  });
}

export function useResetRole(id: string) {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: () => api.post<identity.RoleDetail>(`/roles/${id}/reset`),
    onSuccess: invalidate,
  });
}

export function useArchiveRole(id: string) {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: () => api.post<identity.RoleDetail>(`/roles/${id}/archive`),
    onSuccess: invalidate,
  });
}

export function useSaveMatrix() {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: (body: {
      changes: Array<{ roleId: string; permissions: PermissionKey[] }>;
      reason?: string;
    }) => api.put<identity.PermissionMatrix>('/permissions/matrix', body),
    onSuccess: invalidate,
  });
}
