import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { audit } from '@a5/contracts';
import { api } from '@/lib/api/client';
import { apiDownload, saveBlob } from '@/lib/api/download';

/** URL state of the audit log filters. Dates are calendar days in UTC, as the API reads them. */
export const AUDIT_DEFAULTS = {
  from: '',
  to: '',
  q: '',
  action: '',
  actorType: '',
  resourceType: '',
  resourceId: '',
  service: '',
  /** Entry open in the detail drawer. */
  entry: '',
};
export type AuditFilterState = typeof AUDIT_DEFAULTS;

export const auditKeys = {
  all: ['audit'] as const,
  list: (f: Record<string, unknown>) => [...auditKeys.all, 'list', f] as const,
  entry: (id: string) => [...auditKeys.all, 'entry', id] as const,
  history: (type: string, id: string) => [...auditKeys.all, 'history', type, id] as const,
  facets: (from: string, to: string) => [...auditKeys.all, 'facets', from, to] as const,
};

/** Query for the list and export endpoints: only the filters that are set. */
export function toAuditQuery(state: AuditFilterState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    'from',
    'to',
    'q',
    'action',
    'actorType',
    'resourceType',
    'resourceId',
    'service',
  ] as const) {
    const value = state[key].trim();
    if (value) out[key] = value;
  }
  return out;
}

/** Number of filters in effect, used for the empty-state wording. */
export function auditFilterCount(state: AuditFilterState): number {
  return Object.keys(toAuditQuery(state)).length;
}

export function auditRangeError(state: Pick<AuditFilterState, 'from' | 'to'>): string | null {
  if (state.from && state.to && state.from > state.to) {
    return 'The end date must be on or after the start date.';
  }
  return null;
}

/** Entries newest first, loaded a page at a time with the API's keyset cursor. */
export function useAuditLogs(state: AuditFilterState, enabled = true) {
  const query = toAuditQuery(state);
  return useInfiniteQuery({
    queryKey: auditKeys.list(query),
    queryFn: ({ pageParam, signal }) =>
      api.get<audit.AuditLogPage>(
        '/audit/logs',
        { ...query, limit: 50, cursor: pageParam },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useAuditEntry(id: string | null) {
  return useQuery({
    queryKey: auditKeys.entry(id ?? ''),
    queryFn: ({ signal }) => api.get<audit.AuditLog>(`/audit/logs/${id}`, undefined, signal),
    enabled: Boolean(id),
    // Entries are immutable: once loaded they never go stale.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useResourceHistory(resourceType: string | null, resourceId: string | null) {
  return useQuery({
    queryKey: auditKeys.history(resourceType ?? '', resourceId ?? ''),
    queryFn: ({ signal }) =>
      api.get<audit.AuditLogPage>(
        `/audit/resources/${encodeURIComponent(resourceType!)}/${encodeURIComponent(resourceId!)}/history`,
        { limit: 12 },
        signal,
      ),
    enabled: Boolean(resourceType && resourceId),
  });
}

/** Distinct actions, resource types and services for the filter lists. */
export function useAuditFacets(from: string, to: string) {
  return useQuery({
    queryKey: auditKeys.facets(from, to),
    queryFn: ({ signal }) =>
      api.get<audit.AuditFacets>(
        '/audit/facets',
        { from: from || undefined, to: to || undefined },
        signal,
      ),
    staleTime: 5 * 60_000,
    // A range the API refuses (over a year) only costs the suggestion lists.
    retry: false,
  });
}

/** Download the filtered trail as CSV. The API records the export itself in the audit log. */
export async function exportAuditCsv(state: AuditFilterState): Promise<string> {
  const { blob, fileName } = await apiDownload(
    '/audit/export',
    toAuditQuery(state),
    'audit-log.csv',
  );
  saveBlob(blob, fileName);
  return fileName;
}
