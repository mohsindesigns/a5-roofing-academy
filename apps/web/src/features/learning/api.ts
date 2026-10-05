import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { learning, media } from '@a5/contracts';
import { api } from '@/lib/api/client';

export const learningKeys = {
  all: ['learning'] as const,
  enrollments: () => [...learningKeys.all, 'enrollments'] as const,
  continue: () => [...learningKeys.all, 'continue'] as const,
  catalog: () => [...learningKeys.all, 'catalog'] as const,
  outline: (programId: string) => [...learningKeys.all, 'outline', programId] as const,
  lesson: (lessonId: string) => [...learningKeys.all, 'lesson', lessonId] as const,
  playback: (grant: string) => [...learningKeys.all, 'playback', grant] as const,
};

export function useMyEnrollments() {
  return useQuery({
    queryKey: learningKeys.enrollments(),
    queryFn: () => api.get<{ items: learning.MyEnrollment[] }>('/learning/me/enrollments'),
  });
}

export function useContinueLearning() {
  return useQuery({
    queryKey: learningKeys.continue(),
    queryFn: () => api.get<learning.ContinueLearning>('/learning/me/continue'),
  });
}

export function useCatalog(enabled = true) {
  return useQuery({
    queryKey: learningKeys.catalog(),
    queryFn: () => api.get<{ items: learning.CatalogItem[] }>('/learning/me/catalog'),
    enabled,
  });
}

export function useOutline(programId: string) {
  return useQuery({
    queryKey: learningKeys.outline(programId),
    queryFn: () => api.get<learning.Outline>(`/learning/me/programs/${programId}/outline`),
  });
}

export function useLesson(lessonId: string) {
  return useQuery({
    queryKey: learningKeys.lesson(lessonId),
    queryFn: () => api.get<learning.LessonDetail>(`/learning/me/lessons/${lessonId}`),
  });
}

/** Playback descriptor for a lesson's video/document. Kept stable so the player is not rebuilt. */
export function usePlayback(grant: string | undefined) {
  return useQuery({
    queryKey: learningKeys.playback(grant ?? ''),
    queryFn: () => api.post<media.PlaybackDescriptor>('/media/playback', { grant }),
    enabled: Boolean(grant),
    staleTime: 20 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** Refresh everything that depends on learner progress after a state change. */
export function useInvalidateProgress() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: learningKeys.all });
    void qc.invalidateQueries({ queryKey: ['notifications', 'unread'] });
  };
}

export function useEnrollSelf() {
  const invalidate = useInvalidateProgress();
  return useMutation({
    mutationFn: (programId: string) => api.post(`/learning/me/programs/${programId}/enroll`),
    onSuccess: invalidate,
  });
}

export function useStartLesson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (lessonId: string) => api.post(`/learning/me/lessons/${lessonId}/start`),
    onSuccess: (_d, lessonId) =>
      void qc.invalidateQueries({ queryKey: learningKeys.lesson(lessonId) }),
  });
}

export function useCompleteLesson() {
  const invalidate = useInvalidateProgress();
  return useMutation({
    mutationFn: (lessonId: string) =>
      api.post<learning.CompleteLessonResult>(`/learning/me/lessons/${lessonId}/complete`),
    onSuccess: invalidate,
  });
}

export function useAcknowledge(lessonId: string) {
  const invalidate = useInvalidateProgress();
  return useMutation({
    mutationFn: (typedName: string) =>
      api.post(`/learning/me/lessons/${lessonId}/acknowledge`, { typedName }),
    onSuccess: invalidate,
  });
}

export function useSubmitAssignment(lessonId: string) {
  const invalidate = useInvalidateProgress();
  return useMutation({
    mutationFn: (body: string) =>
      api.post<{ submission: learning.Submission; approval: learning.LearnerApproval }>(
        `/learning/me/lessons/${lessonId}/submission`,
        { body },
      ),
    onSuccess: invalidate,
  });
}

export function useRequestApproval(lessonId: string) {
  const invalidate = useInvalidateProgress();
  return useMutation({
    mutationFn: (note: string | null) =>
      api.post(`/learning/me/lessons/${lessonId}/approval-request`, { note }),
    onSuccess: invalidate,
  });
}

export function useNotes(lessonId: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: learningKeys.lesson(lessonId) });
  return {
    add: useMutation({
      mutationFn: (v: { body: string; videoTimestampSeconds?: number | null }) =>
        api.post(`/learning/me/lessons/${lessonId}/notes`, v),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (noteId: string) => api.delete(`/learning/me/notes/${noteId}`),
      onSuccess: refresh,
    }),
  };
}
