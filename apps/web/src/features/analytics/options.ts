import { useQuery } from '@tanstack/react-query';
import type { PageResult, certification, learning } from '@a5/contracts';
import { api } from '@/lib/api/client';
import { usePermissions } from '@/features/auth/session';

/**
 * Lookup lists for filters and pickers. Each hook is gated on the permission the endpoint needs,
 * so a role without it never issues a request that is certain to fail.
 */
export function useProgramOptions(status: 'published' | 'active' = 'published') {
  const enabled = usePermissions().has('programs.view');
  return useQuery({
    queryKey: ['options', 'programs', status],
    queryFn: ({ signal }) =>
      api.get<PageResult<learning.ProgramSummary>>(
        '/programs',
        {
          status: status === 'published' ? 'published' : 'draft,published',
          pageSize: 100,
          sort: 'title',
        },
        signal,
      ),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useCertificationOptions(enabled = true) {
  const allowed = usePermissions().has('certifications.view');
  return useQuery({
    queryKey: ['options', 'certifications'],
    queryFn: ({ signal }) =>
      api.get<PageResult<certification.CertificationSummary>>(
        '/certifications',
        { status: 'active', pageSize: 100 },
        signal,
      ),
    enabled: enabled && allowed,
    staleTime: 5 * 60_000,
  });
}
