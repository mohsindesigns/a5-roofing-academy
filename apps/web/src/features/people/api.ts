import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageResult, identity } from '@a5/contracts';
import { api } from '@/lib/api/client';

export interface PeopleFilters {
  q?: string;
  status?: string;
  roleId?: string;
  teamId?: string;
  locationId?: string;
  sort?: string;
  page: number;
  pageSize: number;
}

export const peopleKeys = {
  all: ['people'] as const,
  list: (f: PeopleFilters) => [...peopleKeys.all, 'list', f] as const,
  detail: (id: string) => [...peopleKeys.all, 'detail', id] as const,
  sessions: (id: string) => [...peopleKeys.all, 'sessions', id] as const,
  logins: (id: string) => [...peopleKeys.all, 'logins', id] as const,
  options: (q: string) => [...peopleKeys.all, 'options', q] as const,
};

export function usePeople(filters: PeopleFilters) {
  return useQuery({
    queryKey: peopleKeys.list(filters),
    queryFn: ({ signal }) =>
      api.get<PageResult<identity.UserSummary>>('/users', { ...filters }, signal),
    placeholderData: keepPreviousData,
  });
}

/** Small lookup for pickers (managers, trainers, team members). */
export function usePeopleOptions(q: string, enabled = true) {
  return useQuery({
    queryKey: peopleKeys.options(q),
    queryFn: ({ signal }) =>
      api.get<PageResult<identity.UserSummary>>(
        '/users',
        { q: q || undefined, pageSize: 20, status: 'active,invited' },
        signal,
      ),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function usePerson(id: string) {
  return useQuery({
    queryKey: peopleKeys.detail(id),
    queryFn: () => api.get<identity.UserDetail>(`/users/${id}`),
  });
}

export function usePersonSessions(id: string, enabled: boolean) {
  return useQuery({
    queryKey: peopleKeys.sessions(id),
    queryFn: () => api.get<{ items: identity.SessionInfo[] }>(`/users/${id}/sessions`),
    enabled,
  });
}

export function usePersonLogins(id: string, enabled: boolean) {
  return useQuery({
    queryKey: peopleKeys.logins(id),
    queryFn: () => api.get<{ items: identity.LoginHistoryEntry[] }>(`/users/${id}/login-history`),
    enabled,
  });
}

function useUpdateCache() {
  const qc = useQueryClient();
  return (user: identity.UserDetail) => {
    qc.setQueryData(peopleKeys.detail(user.id), user);
    void qc.invalidateQueries({ queryKey: [...peopleKeys.all, 'list'] });
  };
}

export function useCreatePerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: identity.CreateUserRequest) =>
      api.post<{ user: identity.UserDetail; activationUrl: string | null }>('/users', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: peopleKeys.all }),
  });
}

export function useUpdatePerson(id: string) {
  const update = useUpdateCache();
  return useMutation({
    mutationFn: (body: identity.UpdateUserRequest) =>
      api.patch<identity.UserDetail>(`/users/${id}`, body),
    onSuccess: update,
  });
}

export function useSetPersonRoles(id: string) {
  const update = useUpdateCache();
  return useMutation({
    mutationFn: (roleIds: string[]) =>
      api.put<identity.UserDetail>(`/users/${id}/roles`, { roleIds }),
    onSuccess: update,
  });
}

export function useDeactivatePerson(id: string) {
  const update = useUpdateCache();
  return useMutation({
    mutationFn: (reason: string) =>
      api.post<identity.UserDetail>(`/users/${id}/deactivate`, { reason }),
    onSuccess: update,
  });
}

export function useReactivatePerson(id: string) {
  const update = useUpdateCache();
  return useMutation({
    mutationFn: () => api.post<identity.UserDetail>(`/users/${id}/reactivate`),
    onSuccess: update,
  });
}

export function useResendInvitation(id: string) {
  return useMutation({
    mutationFn: () =>
      api.post<{ user: identity.UserDetail; activationUrl: string | null }>(
        `/users/${id}/invitation`,
      ),
  });
}

export function useRevokePersonSessions(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ revoked: number }>(`/users/${id}/sessions`),
    onSuccess: () => qc.invalidateQueries({ queryKey: peopleKeys.sessions(id) }),
  });
}
