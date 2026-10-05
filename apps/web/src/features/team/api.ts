import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageResult, learning } from '@a5/contracts';
import { api } from '@/lib/api/client';
import { analyticsKeys } from '@/features/analytics/api';

export const teamKeys = {
  all: ['team'] as const,
  progress: (q: Record<string, unknown>) => [...teamKeys.all, 'progress', q] as const,
  learner: (userId: string) => [...teamKeys.all, 'learner', userId] as const,
  enrollment: (id: string) => [...teamKeys.all, 'enrollment', id] as const,
};

export interface TeamProgressParams {
  q?: string;
  programId?: string;
  teamId?: string;
  status?: string;
  attention?: boolean;
  sort?: string;
  page: number;
  pageSize: number;
}

/** Enrollments in the caller's scope with attention flags computed by the API. */
export function useTeamProgress(params: TeamProgressParams) {
  return useQuery({
    queryKey: teamKeys.progress({ ...params }),
    queryFn: ({ signal }) =>
      api.get<PageResult<learning.TeamProgressRow>>(
        '/progress/team',
        { ...params, attention: params.attention ? 'true' : undefined },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useLearnerProgress(userId: string | null) {
  return useQuery({
    queryKey: teamKeys.learner(userId ?? ''),
    queryFn: ({ signal }) =>
      api.get<learning.LearnerProgress>(`/progress/learners/${userId}`, undefined, signal),
    enabled: Boolean(userId),
  });
}

export function useEnrollmentDetail(id: string | null) {
  return useQuery({
    queryKey: teamKeys.enrollment(id ?? ''),
    queryFn: ({ signal }) =>
      api.get<learning.EnrollmentDetail>(`/enrollments/${id}`, undefined, signal),
    enabled: Boolean(id),
  });
}

/** Everything that shows enrollment state is stale after an assignment change. */
function useInvalidateTeam() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: teamKeys.all }),
      qc.invalidateQueries({ queryKey: analyticsKeys.all }),
      qc.invalidateQueries({ queryKey: ['programs'] }),
    ]);
}

export function useEnroll() {
  const invalidate = useInvalidateTeam();
  return useMutation({
    mutationFn: (body: { programId: string; userIds: string[]; dueAt?: string | null }) =>
      api.post<learning.BulkEnrollResult>('/enrollments', body),
    onSuccess: invalidate,
  });
}

export function useSetDueDate(enrollmentId: string) {
  const invalidate = useInvalidateTeam();
  return useMutation({
    mutationFn: (dueAt: string | null) =>
      api.put<learning.EnrollmentDetail>(`/enrollments/${enrollmentId}/due-date`, { dueAt }),
    onSuccess: invalidate,
  });
}

export function useWithdraw(enrollmentId: string) {
  const invalidate = useInvalidateTeam();
  return useMutation({
    mutationFn: (reason: string) =>
      api.post<learning.EnrollmentDetail>(`/enrollments/${enrollmentId}/withdraw`, { reason }),
    onSuccess: invalidate,
  });
}

/** End of the chosen calendar day in the viewer's time zone, as an ISO instant. */
export function endOfDayIso(date: string): string {
  return new Date(`${date}T23:59:59`).toISOString();
}
