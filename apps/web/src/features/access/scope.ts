import { SYSTEM_ROLE_KEYS, type DataScope } from '@a5/permissions';

export const SCOPE_LABELS: Record<DataScope, { label: string; description: string }> = {
  own: { label: 'Own records', description: 'Only their own training, scores and certificates.' },
  managed: {
    label: 'Managed teams',
    description: 'People in teams they manage, plus direct reports and assigned trainees.',
  },
  organization: { label: 'Whole organization', description: 'Everyone in A5 Roofing.' },
  platform: { label: 'All organizations', description: 'Every organization on the platform.' },
};

/** Built-in roles in seniority order, then custom roles alphabetically. */
export function byHierarchy<T extends { key: string; name: string; isSystem: boolean }>(
  roles: readonly T[],
): T[] {
  const rank = (r: T) => {
    const i = (SYSTEM_ROLE_KEYS as readonly string[]).indexOf(r.key);
    return r.isSystem && i >= 0 ? i : 100;
  };
  return [...roles].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
