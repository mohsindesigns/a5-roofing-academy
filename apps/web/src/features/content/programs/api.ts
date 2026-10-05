import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageResult, assessment, ai, learning } from '@a5/contracts';
import { api } from '@/lib/api/client';
import { usePermissions } from '@/features/auth/session';
import type { MovePlan } from './tree';

export const programKeys = {
  all: ['programs'] as const,
  list: (q: Record<string, unknown>) => [...programKeys.all, 'list', q] as const,
  detail: (id: string) => [...programKeys.all, 'detail', id] as const,
  versions: (id: string) => [...programKeys.all, 'versions', id] as const,
  enrollments: (id: string, q: Record<string, unknown>) =>
    [...programKeys.all, 'enrollments', id, q] as const,
  assessments: () => ['options', 'assessments'] as const,
  scenarios: () => ['options', 'scenarios'] as const,
};

export interface ProgramListQuery {
  q?: string;
  status?: string;
  sort?: string;
  page: number;
  pageSize: number;
}

export function useProgramList(query: ProgramListQuery) {
  return useQuery({
    queryKey: programKeys.list({ ...query }),
    queryFn: ({ signal }) =>
      api.get<PageResult<learning.ProgramSummary>>('/programs', { ...query }, signal),
    placeholderData: keepPreviousData,
  });
}

export function useProgramDetail(id: string) {
  return useQuery({
    queryKey: programKeys.detail(id),
    queryFn: ({ signal }) => api.get<learning.ProgramDetail>(`/programs/${id}`, undefined, signal),
  });
}

export function useProgramVersions(id: string) {
  return useQuery({
    queryKey: programKeys.versions(id),
    queryFn: ({ signal }) =>
      api.get<{ items: learning.ProgramVersion[] }>(`/programs/${id}/versions`, undefined, signal),
  });
}

/** Writes that return the refreshed builder view update the cache directly. */
function useStore(id: string) {
  const qc = useQueryClient();
  return (detail: learning.ProgramDetail) => {
    qc.setQueryData(programKeys.detail(id), detail);
    void qc.invalidateQueries({ queryKey: [...programKeys.all, 'list'] });
  };
}

export function useCreateProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: learning.CreateProgramRequest) =>
      api.post<learning.ProgramDetail>('/programs', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: programKeys.all }),
  });
}

export function useUpdateProgram(id: string) {
  const store = useStore(id);
  return useMutation({
    mutationFn: (body: learning.UpdateProgramRequest) =>
      api.patch<learning.ProgramDetail>(`/programs/${id}`, body),
    onSuccess: store,
  });
}

export function useProgramAction(id: string) {
  const store = useStore(id);
  return useMutation({
    mutationFn: (action: 'archive' | 'restore') =>
      api.post<learning.ProgramDetail>(`/programs/${id}/${action}`),
    onSuccess: store,
  });
}

export function useDuplicateProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title?: string }) =>
      api.post<learning.ProgramDetail>(`/programs/${id}/duplicate`, title ? { title } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: programKeys.all }),
  });
}

export function usePublishProgram(id: string) {
  const qc = useQueryClient();
  const store = useStore(id);
  return useMutation({
    mutationFn: (changeNote: string) =>
      api.post<{ version: learning.ProgramVersion; program: learning.ProgramDetail }>(
        `/programs/${id}/publish`,
        { changeNote },
      ),
    onSuccess: (r) => {
      store(r.program);
      void qc.invalidateQueries({ queryKey: programKeys.versions(id) });
      // Learners' outlines depend on the published version.
      void qc.invalidateQueries({ queryKey: ['learning'] });
    },
  });
}

export function useSetAudiences(id: string) {
  const store = useStore(id);
  return useMutation({
    mutationFn: (audiences: learning.Audience[]) =>
      api.put<learning.ProgramDetail>(`/programs/${id}/audiences`, { audiences }),
    onSuccess: store,
  });
}

export function useSetPrerequisites(id: string) {
  const store = useStore(id);
  return useMutation({
    mutationFn: (programIds: string[]) =>
      api.put<learning.ProgramDetail>(`/programs/${id}/prerequisites`, { programIds }),
    onSuccess: store,
  });
}

// ------------------------------------------------------------------ structure

type NodeBody = { title: string; summary?: string | null; unlockRule?: unknown };

export function useStructure(programId: string) {
  const store = useStore(programId);
  const base = `/programs/${programId}`;
  const post = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api.post<learning.ProgramDetail>(`${base}${path}`, body),
    onSuccess: store,
  });
  const patch = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) =>
      api.patch<learning.ProgramDetail>(`${base}${path}`, body),
    onSuccess: store,
  });
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (path: string) => api.delete<learning.DeleteResult>(`${base}${path}`),
    // The delete response is only an outcome; reload the working copy.
    onSuccess: () => qc.invalidateQueries({ queryKey: programKeys.detail(programId) }),
  });
  return {
    createPhase: (body: NodeBody) => post.mutateAsync({ path: '/phases', body }),
    updatePhase: (id: string, body: Partial<NodeBody>) =>
      patch.mutateAsync({ path: `/phases/${id}`, body }),
    createModule: (phaseId: string, body: NodeBody) =>
      post.mutateAsync({ path: '/modules', body: { phaseId, ...body } }),
    updateModule: (id: string, body: Partial<NodeBody>) =>
      patch.mutateAsync({ path: `/modules/${id}`, body }),
    setArchived: (kind: 'phases' | 'modules', id: string, archived: boolean) =>
      post.mutateAsync({ path: `/${kind}/${id}/${archived ? 'archive' : 'restore'}` }),
    remove: (kind: 'phases' | 'modules', id: string) => remove.mutateAsync(`/${kind}/${id}`),
    pending: post.isPending || patch.isPending || remove.isPending,
  };
}

/** Perform a move produced by the tree helpers. */
export function useMove(programId: string) {
  const store = useStore(programId);
  return useMutation({
    mutationFn: (plan: MovePlan) => {
      if (plan.kind === 'phase') {
        return api.post<learning.ProgramDetail>(
          `/programs/${programId}/phases/${plan.phaseId}/move`,
          { position: plan.position },
        );
      }
      if (plan.kind === 'module') {
        return api.post<learning.ProgramDetail>(
          `/programs/${programId}/modules/${plan.moduleId}/move`,
          { phaseId: plan.phaseId, position: plan.position },
        );
      }
      return api.post<learning.ProgramDetail>(`/lessons/${plan.lessonId}/move`, {
        moduleId: plan.moduleId,
        position: plan.position,
      });
    },
    onSuccess: store,
  });
}

// ------------------------------------------------------------------ lessons

export function useLessonActions(programId: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: programKeys.detail(programId) });
  const create = useMutation({
    mutationFn: (body: learning.CreateLessonRequest) =>
      api.post<learning.AdminLesson>('/lessons', body),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: learning.UpdateLessonRequest }) =>
      api.patch<learning.AdminLesson>(`/lessons/${id}`, body),
    onSuccess: refresh,
  });
  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api.post<learning.AdminLesson>(`/lessons/${id}/${archived ? 'archive' : 'restore'}`),
    onSuccess: refresh,
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => api.post<learning.AdminLesson>(`/lessons/${id}/duplicate`),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<learning.DeleteResult>(`/lessons/${id}`),
    onSuccess: refresh,
  });
  return { create, update, archive, duplicate, remove };
}

export function useLessonResources(lessonId: string | null) {
  const qc = useQueryClient();
  const key = ['lesson-resources', lessonId] as const;
  const list = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api.get<{ items: learning.LessonResource[] }>(
        `/lessons/${lessonId}/resources`,
        undefined,
        signal,
      ),
    enabled: Boolean(lessonId),
  });
  const set = (data: { items: learning.LessonResource[] }) => qc.setQueryData(key, data);
  const add = useMutation({
    mutationFn: (body: {
      title: string;
      kind: 'link' | 'media';
      url?: string | null;
      mediaAssetId?: string | null;
      description?: string | null;
    }) => api.post<{ items: learning.LessonResource[] }>(`/lessons/${lessonId}/resources`, body),
    onSuccess: set,
  });
  const remove = useMutation({
    mutationFn: (resourceId: string) =>
      api.delete<{ items: learning.LessonResource[] }>(
        `/lessons/${lessonId}/resources/${resourceId}`,
      ),
    onSuccess: set,
  });
  return { list, add, remove };
}

// ------------------------------------------------------------------ pickers

export function useAssessmentOptions() {
  const allowed = usePermissions().has('assessments.view');
  return useQuery({
    queryKey: programKeys.assessments(),
    queryFn: ({ signal }) =>
      api.get<PageResult<assessment.AssessmentSummary>>(
        '/assessments',
        { status: 'published', pageSize: 100, sort: 'title' },
        signal,
      ),
    enabled: allowed,
    staleTime: 5 * 60_000,
  });
}

export type ScenarioOption = Pick<
  ai.ScenarioDetail,
  'id' | 'title' | 'category' | 'difficulty' | 'passingScore'
>;

export function useScenarioOptions() {
  const allowed = usePermissions().has('ai_scenarios.view');
  return useQuery({
    queryKey: programKeys.scenarios(),
    queryFn: ({ signal }) =>
      api.get<PageResult<ScenarioOption>>(
        '/ai/scenarios',
        { status: 'published', pageSize: 100 },
        signal,
      ),
    enabled: allowed,
    staleTime: 5 * 60_000,
  });
}

export function useProgramEnrollments(programId: string, page: number, enabled: boolean) {
  const query = { programId, page, pageSize: 10, status: 'active,completed' };
  return useQuery({
    queryKey: programKeys.enrollments(programId, query),
    queryFn: ({ signal }) =>
      api.get<PageResult<learning.EnrollmentSummary>>('/enrollments', { ...query }, signal),
    enabled,
    placeholderData: keepPreviousData,
  });
}
