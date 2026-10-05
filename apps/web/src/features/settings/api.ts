import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { identity } from '@a5/contracts';
import { api } from '@/lib/api/client';
import { sessionKeys } from '@/features/auth/session';

export const settingsKeys = {
  org: ['settings', 'organization'] as const,
  security: ['settings', 'security'] as const,
  flags: ['settings', 'flags'] as const,
};

export function useOrgSettings() {
  return useQuery({
    queryKey: settingsKeys.org,
    queryFn: () => api.get<identity.OrganizationSettings>('/settings/organization'),
  });
}

export function useSaveOrgSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: identity.OrganizationSettings) =>
      api.put<identity.OrganizationSettings>('/settings/organization', body),
    onSuccess: (data) => {
      qc.setQueryData(settingsKeys.org, data);
      void qc.invalidateQueries({ queryKey: sessionKeys.me });
    },
  });
}

export function useSecuritySettings() {
  return useQuery({
    queryKey: settingsKeys.security,
    queryFn: () => api.get<identity.SecuritySettings>('/settings/security'),
  });
}

export function useSaveSecuritySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: identity.SecuritySettings) =>
      api.put<identity.SecuritySettings>('/settings/security', body),
    onSuccess: (data) => qc.setQueryData(settingsKeys.security, data),
  });
}

export function useFeatureFlags() {
  return useQuery({
    queryKey: settingsKeys.flags,
    queryFn: () => api.get<{ items: identity.FeatureFlagEntry[] }>('/feature-flags'),
  });
}

export function useSetFeatureFlag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      api.put<{ items: identity.FeatureFlagEntry[] }>(`/feature-flags/${key}`, { enabled }),
    // Optimistic: flag toggles are idempotent and easy to roll back.
    onMutate: async ({ key, enabled }) => {
      await qc.cancelQueries({ queryKey: settingsKeys.flags });
      const previous = qc.getQueryData<{ items: identity.FeatureFlagEntry[] }>(settingsKeys.flags);
      if (previous)
        qc.setQueryData(settingsKeys.flags, {
          items: previous.items.map((f) => (f.key === key ? { ...f, enabled } : f)),
        });
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(settingsKeys.flags, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: settingsKeys.flags });
      void qc.invalidateQueries({ queryKey: sessionKeys.me });
    },
  });
}
