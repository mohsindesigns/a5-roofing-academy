import { useQuery } from '@tanstack/react-query';
import type { identity, FeatureFlagKey } from '@a5/contracts';
import { PermissionSet, type PermissionKey } from '@a5/permissions';
import { api } from '@/lib/api/client';
import { useAuth } from '@/lib/auth-store';

export const sessionKeys = {
  me: ['session', 'me'] as const,
};

/** Current user's profile, effective permissions and feature flags. */
export function useMe() {
  const status = useAuth((s) => s.status);
  return useQuery({
    queryKey: sessionKeys.me,
    queryFn: () => api.get<identity.MeResponse>('/auth/me'),
    enabled: status === 'authenticated',
    staleTime: 60_000,
  });
}

/** UI-only permission checks. The API enforces every permission independently. */
export function usePermissions(): PermissionSet {
  const { data } = useMe();
  return data ? new PermissionSet(data.permissions) : PermissionSet.empty();
}

export function useCan(...keys: PermissionKey[]): boolean {
  return usePermissions().hasAll(keys);
}

export function useFeatureFlag(key: FeatureFlagKey): boolean {
  return useMe().data?.featureFlags[key] ?? false;
}
