import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { identity } from '@a5/contracts';
import { api } from '@/lib/api/client';

export const orgKeys = {
  all: ['organization'] as const,
  structure: () => [...orgKeys.all, 'structure'] as const,
  locations: (archived: boolean) => [...orgKeys.all, 'locations', { archived }] as const,
  departments: (archived: boolean) => [...orgKeys.all, 'departments', { archived }] as const,
  teams: (filters: Record<string, unknown>) => [...orgKeys.all, 'teams', filters] as const,
  team: (id: string) => [...orgKeys.all, 'team', id] as const,
};

export function useOrgStructure() {
  return useQuery({
    queryKey: orgKeys.structure(),
    queryFn: () => api.get<identity.OrgStructure>('/organization/structure'),
    staleTime: 5 * 60_000,
  });
}

export function useLocations(includeArchived = false) {
  return useQuery({
    queryKey: orgKeys.locations(includeArchived),
    queryFn: () =>
      api.get<{ items: identity.Location[] }>('/locations', {
        includeArchived: includeArchived ? 'true' : undefined,
      }),
  });
}

export function useDepartments(includeArchived = false) {
  return useQuery({
    queryKey: orgKeys.departments(includeArchived),
    queryFn: () =>
      api.get<{ items: identity.Department[] }>('/departments', {
        includeArchived: includeArchived ? 'true' : undefined,
      }),
  });
}

export function useTeams(filters: { q?: string; includeArchived?: boolean } = {}) {
  return useQuery({
    queryKey: orgKeys.teams(filters),
    queryFn: () =>
      api.get<{ items: identity.TeamSummary[] }>('/teams', {
        q: filters.q,
        includeArchived: filters.includeArchived ? 'true' : undefined,
      }),
    placeholderData: keepPreviousData,
  });
}

export function useTeam(id: string) {
  return useQuery({
    queryKey: orgKeys.team(id),
    queryFn: () => api.get<identity.TeamDetail>(`/teams/${id}`),
  });
}

function useInvalidateOrg() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: orgKeys.all });
}

export function useSaveUnit(kind: 'locations' | 'departments') {
  const invalidate = useInvalidateOrg();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Record<string, unknown> }) =>
      id ? api.patch(`/${kind}/${id}`, body) : api.post(`/${kind}`, body),
    onSuccess: invalidate,
  });
}

export function useArchiveUnit(kind: 'locations' | 'departments' | 'teams') {
  const invalidate = useInvalidateOrg();
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api.post(`/${kind}/${id}/archive`, { archived }),
    onSuccess: invalidate,
  });
}

export function useSaveTeam() {
  const invalidate = useInvalidateOrg();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: identity.UpsertTeamRequest }) =>
      id
        ? api.patch<identity.TeamDetail>(`/teams/${id}`, body)
        : api.post<identity.TeamDetail>('/teams', body),
    onSuccess: invalidate,
  });
}

export function useSetTeamMembers(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memberIds: string[]) =>
      api.put<identity.TeamDetail>(`/teams/${id}/members`, { memberIds }),
    onSuccess: (team) => {
      qc.setQueryData(orgKeys.team(id), team);
      void qc.invalidateQueries({ queryKey: orgKeys.all });
      void qc.invalidateQueries({ queryKey: ['people'] });
    },
  });
}
