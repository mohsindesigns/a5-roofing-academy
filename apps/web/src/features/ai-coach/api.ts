import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ai } from '@a5/contracts';
import { api } from '@/lib/api/client';

type Page<T> = { items: T[]; page: number; pageSize: number; total: number; pageCount: number };

export interface PracticeFilters {
  q?: string;
  category?: string;
  difficulty?: string;
  page?: number;
  pageSize?: number;
}

export const coachKeys = {
  all: ['ai-coach'] as const,
  scenarios: (f: PracticeFilters) => [...coachKeys.all, 'scenarios', f] as const,
  scenarioOptions: () => [...coachKeys.all, 'scenario-options'] as const,
  brief: (id: string) => [...coachKeys.all, 'brief', id] as const,
  history: (page: number, status?: string) => [...coachKeys.all, 'history', page, status] as const,
  active: () => [...coachKeys.all, 'active'] as const,
  session: (id: string) => [...coachKeys.all, 'session', id] as const,
};

export function usePracticeScenarios(filters: PracticeFilters) {
  return useQuery({
    queryKey: coachKeys.scenarios(filters),
    queryFn: () =>
      api.get<Page<ai.PracticeScenario>>('/ai/practice/scenarios', {
        q: filters.q,
        category: filters.category,
        difficulty: filters.difficulty,
        page: filters.page ?? 1,
        pageSize: filters.pageSize ?? 12,
      }),
    placeholderData: keepPreviousData,
  });
}

/** All published scenarios (up to one API page) to build the category filter. */
export function useScenarioCategories() {
  return useQuery({
    queryKey: coachKeys.scenarioOptions(),
    queryFn: () =>
      api.get<Page<ai.PracticeScenario>>('/ai/practice/scenarios', { page: 1, pageSize: 100 }),
    staleTime: 5 * 60_000,
    select: (page) => [...new Set(page.items.map((s) => s.category))].sort(),
  });
}

export function usePracticeBrief(id: string | undefined) {
  return useQuery({
    queryKey: coachKeys.brief(id ?? ''),
    queryFn: () => api.get<ai.PracticeScenarioBrief>(`/ai/practice/scenarios/${id}`),
    enabled: Boolean(id),
  });
}

export function useMySessions(page: number, pageSize = 15) {
  return useQuery({
    queryKey: coachKeys.history(page),
    queryFn: () => api.get<Page<ai.SessionSummary>>('/ai/me/sessions', { page, pageSize }),
    placeholderData: keepPreviousData,
  });
}

/** The learner's open conversations, so they can pick up where they left off. */
export function useActiveSessions() {
  return useQuery({
    queryKey: coachKeys.active(),
    queryFn: () =>
      api.get<Page<ai.SessionSummary>>('/ai/me/sessions', {
        status: 'active',
        page: 1,
        pageSize: 5,
      }),
  });
}

export function useSession(
  id: string,
  options: { refetch?: (session: ai.Session | undefined) => number | false } = {},
) {
  return useQuery({
    queryKey: coachKeys.session(id),
    queryFn: ({ signal }) => api.get<ai.Session>(`/ai/sessions/${id}`, undefined, signal),
    // A conversation is live state: never serve a cached copy as if it were current.
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval: options.refetch ? (q) => options.refetch!(q.state.data) : false,
  });
}

export function useStartSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { scenarioId: string; lessonGrant?: string; test?: boolean }) =>
      input.test
        ? api.post<ai.Session>(`/ai/scenarios/${input.scenarioId}/test-sessions`)
        : api.post<ai.Session>('/ai/sessions', {
            scenarioId: input.scenarioId,
            lessonGrant: input.lessonGrant,
            modality: 'text',
          }),
    onSuccess: (session) => {
      qc.setQueryData(coachKeys.session(session.id), session);
      void qc.invalidateQueries({ queryKey: coachKeys.active() });
    },
  });
}

export function useEndSession(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ai.Session>(`/ai/sessions/${id}/end`),
    onSuccess: (session) => {
      qc.setQueryData(coachKeys.session(id), session);
      void qc.invalidateQueries({ queryKey: [...coachKeys.all, 'history'] });
      void qc.invalidateQueries({ queryKey: coachKeys.active() });
    },
  });
}

export function useRetryEvaluation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ai.Session>(`/ai/sessions/${id}/evaluation/retry`),
    onSuccess: (session) => qc.setQueryData(coachKeys.session(id), session),
  });
}

/** Scores and attempts on the scenario list change once a session is scored. */
export function useRefreshPracticeStats() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [...coachKeys.all, 'scenarios'] });
    void qc.invalidateQueries({ queryKey: [...coachKeys.all, 'history'] });
  };
}
