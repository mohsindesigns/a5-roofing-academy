// Stand-in for `@/features/auth/session` in tests: `vi.mock('@/features/auth/session', () => import('../test-session'))`,
// then call `grant(...)` to choose the permissions the signed-in person has.
import { PermissionSet, type PermissionKey } from '@a5/permissions';

let granted: PermissionKey[] = [];

export function grant(...keys: PermissionKey[]): void {
  granted = keys;
}

const current = () =>
  new PermissionSet(Object.fromEntries(granted.map((k) => [k, 'organization'])) as never);

export const usePermissions = () => current();
export const useCan = (...keys: PermissionKey[]) => current().hasAll(keys);
export const useMe = () => ({ data: undefined, isPending: false, isError: false });
export const useFeatureFlag = () => false;
