import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageResult, assessment } from '@a5/contracts';
import { api } from '@/lib/api/client';

type Id = string;

export interface ListFilters {
  [key: string]: string | number | boolean | undefined;
}

export const assessmentKeys = {
  all: ['assessments'] as const,
  // learner
  intro: (assessmentId: Id) => [...assessmentKeys.all, 'intro', assessmentId] as const,
  attempt: (attemptId: Id) => [...assessmentKeys.all, 'attempt', attemptId] as const,
  result: (attemptId: Id) => [...assessmentKeys.all, 'result', attemptId] as const,
  // content management
  list: (f: ListFilters) => [...assessmentKeys.all, 'list', f] as const,
  detail: (id: Id) => [...assessmentKeys.all, 'detail', id] as const,
  validation: (id: Id) => [...assessmentKeys.all, 'validation', id] as const,
  stats: (id: Id) => [...assessmentKeys.all, 'stats', id] as const,
  banks: (includeArchived: boolean) => [...assessmentKeys.all, 'banks', includeArchived] as const,
  bank: (id: Id) => [...assessmentKeys.all, 'bank', id] as const,
  questions: (f: ListFilters) => [...assessmentKeys.all, 'questions', f] as const,
  question: (id: Id) => [...assessmentKeys.all, 'question', id] as const,
  versions: (id: Id) => [...assessmentKeys.all, 'versions', id] as const,
  preview: (id: Id, versionId?: Id) =>
    [...assessmentKeys.all, 'preview', id, versionId ?? ''] as const,
  attempts: (f: ListFilters) => [...assessmentKeys.all, 'attempts', f] as const,
  reviewAttempt: (id: Id) => [...assessmentKeys.all, 'review', id] as const,
};

// ------------------------------------------------------------------ learner

export function fetchIntro(assessmentId: Id, grant: string, signal?: AbortSignal) {
  return api.get<assessment.AssessmentIntro>(
    `/assessments/${assessmentId}/intro`,
    { grant },
    signal,
  );
}

/** Intro and rules for an assessment opened from a lesson. The lesson grant authorizes it. */
export function useAssessmentIntro(assessmentId: Id | undefined, grant: string | undefined) {
  return useQuery({
    queryKey: assessmentKeys.intro(assessmentId ?? ''),
    queryFn: ({ signal }) => fetchIntro(assessmentId!, grant!, signal),
    enabled: Boolean(assessmentId && grant),
    staleTime: 0,
  });
}

/**
 * An attempt as the learner sees it. While it is open the local answers are the source of truth,
 * so the query never refetches by itself; it is refreshed explicitly when the attempt closes.
 */
export function useAttempt(attemptId: Id | undefined) {
  return useQuery({
    queryKey: assessmentKeys.attempt(attemptId ?? ''),
    queryFn: ({ signal }) =>
      api.get<assessment.LearnerAttempt>(`/attempts/${attemptId}`, undefined, signal),
    enabled: Boolean(attemptId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useAttemptResult(attemptId: Id | undefined, enabled: boolean) {
  return useQuery({
    queryKey: assessmentKeys.result(attemptId ?? ''),
    queryFn: ({ signal }) =>
      api.get<assessment.AttemptResult>(`/attempts/${attemptId}/result`, undefined, signal),
    enabled: Boolean(attemptId) && enabled,
    // A result can still change while a trainer grades open answers.
    staleTime: 15_000,
  });
}

export function useStartAttempt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (grant: string) => api.post<assessment.LearnerAttempt>('/attempts', { grant }),
    onSuccess: (attempt) => {
      qc.setQueryData(assessmentKeys.attempt(attempt.id), attempt);
      void qc.invalidateQueries({ queryKey: assessmentKeys.intro(attempt.assessmentId) });
    },
  });
}

export function saveAnswer(
  attemptId: Id,
  attemptQuestionId: Id,
  body: assessment.SaveAnswerRequest,
): Promise<{
  attemptQuestionId: string;
  answered: boolean;
  savedAt: string | null;
  applied: boolean;
  answeredCount: number;
  timeRemainingSeconds: number | null;
}> {
  return api.put(`/attempts/${attemptId}/answers/${attemptQuestionId}`, body);
}

export function useSubmitAttempt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (attemptId: Id) =>
      api.post<assessment.AttemptResult>(`/attempts/${attemptId}/submit`),
    onSuccess: (result) => {
      qc.setQueryData(assessmentKeys.result(result.attemptId), result);
      qc.setQueryData<assessment.LearnerAttempt>(assessmentKeys.attempt(result.attemptId), (old) =>
        old ? { ...old, status: result.status, autoSubmitted: result.autoSubmitted } : old,
      );
      void qc.invalidateQueries({ queryKey: assessmentKeys.intro(result.assessmentId) });
    },
  });
}

// ------------------------------------------------------------------ assessments (content)

export function useAssessments(filters: ListFilters) {
  return useQuery({
    queryKey: assessmentKeys.list(filters),
    queryFn: ({ signal }) =>
      api.get<PageResult<assessment.AssessmentSummary>>('/assessments', filters, signal),
    placeholderData: keepPreviousData,
  });
}

export function useAssessment(id: Id) {
  return useQuery({
    queryKey: assessmentKeys.detail(id),
    queryFn: ({ signal }) =>
      api.get<assessment.AssessmentDetail>(`/assessments/${id}`, undefined, signal),
  });
}

export function useAssessmentValidation(id: Id, enabled = true) {
  return useQuery({
    queryKey: assessmentKeys.validation(id),
    queryFn: ({ signal }) =>
      api.get<assessment.AssessmentValidation>(`/assessments/${id}/validation`, undefined, signal),
    enabled,
  });
}

export function useAssessmentStats(id: Id, enabled = true) {
  return useQuery({
    queryKey: assessmentKeys.stats(id),
    queryFn: ({ signal }) =>
      api.get<assessment.AssessmentStats>(`/assessments/${id}/stats`, undefined, signal),
    enabled,
  });
}

/** Writes return the full detail, so the cache is updated in place and lists are refreshed. */
function useDetailWriter(id: Id) {
  const qc = useQueryClient();
  return (detail: assessment.AssessmentDetail) => {
    qc.setQueryData(assessmentKeys.detail(id), detail);
    void qc.invalidateQueries({ queryKey: assessmentKeys.validation(id) });
    void qc.invalidateQueries({ queryKey: [...assessmentKeys.all, 'list'] });
  };
}

export function useCreateAssessment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: assessment.CreateAssessmentRequest) =>
      api.post<assessment.AssessmentDetail>('/assessments', body),
    onSuccess: (detail) => {
      qc.setQueryData(assessmentKeys.detail(detail.id), detail);
      void qc.invalidateQueries({ queryKey: [...assessmentKeys.all, 'list'] });
    },
  });
}

export function useUpdateAssessment(id: Id) {
  const write = useDetailWriter(id);
  return useMutation({
    mutationFn: (body: assessment.UpdateAssessmentRequest) =>
      api.patch<assessment.AssessmentDetail>(`/assessments/${id}`, body),
    onSuccess: write,
  });
}

export function usePublishAssessment(id: Id) {
  const write = useDetailWriter(id);
  return useMutation({
    mutationFn: () => api.post<assessment.AssessmentDetail>(`/assessments/${id}/publish`),
    onSuccess: write,
  });
}

export function useArchiveAssessment(id: Id) {
  const write = useDetailWriter(id);
  return useMutation({
    mutationFn: () => api.post<assessment.AssessmentDetail>(`/assessments/${id}/archive`),
    onSuccess: write,
  });
}

export function useDuplicateAssessment(id: Id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title?: string) =>
      api.post<assessment.AssessmentDetail>(`/assessments/${id}/duplicate`, { title }),
    onSuccess: (detail) => {
      qc.setQueryData(assessmentKeys.detail(detail.id), detail);
      void qc.invalidateQueries({ queryKey: [...assessmentKeys.all, 'list'] });
    },
  });
}

export function useDeleteAssessment(id: Id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`/assessments/${id}`),
    onSuccess: () => {
      qc.removeQueries({ queryKey: assessmentKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: [...assessmentKeys.all, 'list'] });
    },
  });
}

export function usePreviewAssessment(id: Id) {
  return useMutation({
    mutationFn: () => api.post<assessment.AssessmentPreview>(`/assessments/${id}/preview`),
  });
}

export function useReplaceItems(id: Id) {
  const write = useDetailWriter(id);
  return useMutation({
    mutationFn: (items: assessment.ReplaceAssessmentItemsRequest['items']) =>
      api.put<assessment.AssessmentDetail>(`/assessments/${id}/items`, { items }),
    onSuccess: write,
  });
}

export function useAddItem(id: Id) {
  const write = useDetailWriter(id);
  return useMutation({
    mutationFn: (item: assessment.AddAssessmentItemRequest) =>
      api.post<assessment.AssessmentDetail>(`/assessments/${id}/items`, item),
    onSuccess: write,
  });
}

export function useUpdateItem(id: Id) {
  const write = useDetailWriter(id);
  return useMutation({
    mutationFn: (v: { itemId: Id; body: assessment.UpdateAssessmentItemRequest }) =>
      api.put<assessment.AssessmentDetail>(`/assessments/${id}/items/${v.itemId}`, v.body),
    onSuccess: write,
  });
}

export function useDeleteItem(id: Id) {
  const write = useDetailWriter(id);
  return useMutation({
    mutationFn: (itemId: Id) =>
      api.delete<assessment.AssessmentDetail>(`/assessments/${id}/items/${itemId}`),
    onSuccess: write,
  });
}

// ------------------------------------------------------------------ question banks

export function useBanks(includeArchived = false, enabled = true) {
  return useQuery({
    queryKey: assessmentKeys.banks(includeArchived),
    queryFn: ({ signal }) =>
      api.get<PageResult<assessment.QuestionBankSummary>>(
        '/question-banks',
        { includeArchived: includeArchived ? 'true' : undefined, pageSize: 100 },
        signal,
      ),
    enabled,
    staleTime: 60_000,
  });
}

export function useBank(id: Id | undefined) {
  return useQuery({
    queryKey: assessmentKeys.bank(id ?? ''),
    queryFn: ({ signal }) =>
      api.get<assessment.QuestionBankDetail>(`/question-banks/${id}`, undefined, signal),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

/** Banks, categories and competencies are small and shared by several screens: refresh them together. */
function useBankInvalidator() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [...assessmentKeys.all, 'banks'] });
    void qc.invalidateQueries({ queryKey: [...assessmentKeys.all, 'bank'] });
    void qc.invalidateQueries({ queryKey: [...assessmentKeys.all, 'questions'] });
  };
}

export function useCreateBank() {
  const invalidate = useBankInvalidator();
  return useMutation({
    mutationFn: (body: assessment.CreateQuestionBankRequest) =>
      api.post<assessment.QuestionBankDetail>('/question-banks', body),
    onSuccess: invalidate,
  });
}

export function useUpdateBank(id: Id) {
  const invalidate = useBankInvalidator();
  return useMutation({
    mutationFn: (body: Partial<assessment.CreateQuestionBankRequest>) =>
      api.patch<assessment.QuestionBankDetail>(`/question-banks/${id}`, body),
    onSuccess: invalidate,
  });
}

export function useBankArchive(id: Id) {
  const invalidate = useBankInvalidator();
  return useMutation({
    mutationFn: (archive: boolean) =>
      api.post<assessment.QuestionBankDetail>(
        `/question-banks/${id}/${archive ? 'archive' : 'restore'}`,
      ),
    onSuccess: invalidate,
  });
}

export function useDeleteBank(id: Id) {
  const invalidate = useBankInvalidator();
  return useMutation({
    mutationFn: () => api.delete(`/question-banks/${id}`),
    onSuccess: invalidate,
  });
}

export type TaxonomyKind = 'categories' | 'competencies';

export function useSaveTaxonomy(bankId: Id, kind: TaxonomyKind) {
  const invalidate = useBankInvalidator();
  return useMutation({
    mutationFn: (v: {
      id?: Id;
      body: { name?: string; description?: string | null; position?: number };
    }) =>
      v.id
        ? api.patch<assessment.QuestionCategory | assessment.Competency>(
            `/question-banks/${bankId}/${kind}/${v.id}`,
            v.body,
          )
        : api.post<assessment.QuestionCategory | assessment.Competency>(
            `/question-banks/${bankId}/${kind}`,
            v.body,
          ),
    onSuccess: invalidate,
  });
}

export function useDeleteTaxonomy(bankId: Id, kind: TaxonomyKind) {
  const invalidate = useBankInvalidator();
  return useMutation({
    mutationFn: (id: Id) => api.delete(`/question-banks/${bankId}/${kind}/${id}`),
    onSuccess: invalidate,
  });
}

// ------------------------------------------------------------------ questions

export function useQuestions(filters: ListFilters) {
  return useQuery({
    queryKey: assessmentKeys.questions(filters),
    queryFn: ({ signal }) =>
      api.get<PageResult<assessment.QuestionSummary>>('/questions', filters, signal),
    placeholderData: keepPreviousData,
  });
}

export function useQuestion(id: Id | undefined) {
  return useQuery({
    queryKey: assessmentKeys.question(id ?? ''),
    queryFn: ({ signal }) =>
      api.get<assessment.QuestionDetail>(`/questions/${id}`, undefined, signal),
    enabled: Boolean(id),
  });
}

export function useQuestionVersions(id: Id | undefined, enabled = true) {
  return useQuery({
    queryKey: assessmentKeys.versions(id ?? ''),
    queryFn: ({ signal }) =>
      api.get<{ items: assessment.QuestionVersion[] }>(
        `/questions/${id}/versions`,
        undefined,
        signal,
      ),
    enabled: Boolean(id) && enabled,
  });
}

export function useQuestionPreview(id: Id | undefined, versionId?: Id, enabled = true) {
  return useQuery({
    queryKey: assessmentKeys.preview(id ?? '', versionId),
    queryFn: ({ signal }) =>
      api.get<assessment.QuestionPreview>(`/questions/${id}/preview`, { versionId }, signal),
    enabled: Boolean(id) && enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useCheckAnswer(id: Id) {
  return useMutation({
    mutationFn: (body: { response: assessment.AnswerResponse; versionId?: Id }) =>
      api.post<{
        outcome: assessment.QuestionOutcome;
        awardedPoints: number | null;
        points: number;
        correctAnswer: assessment.CorrectAnswer;
        explanation: string | null;
      }>(`/questions/${id}/preview/check`, body),
  });
}

function useQuestionWriter() {
  const qc = useQueryClient();
  return (detail: assessment.QuestionDetail) => {
    qc.setQueryData(assessmentKeys.question(detail.id), detail);
    void qc.invalidateQueries({ queryKey: assessmentKeys.versions(detail.id) });
    void qc.invalidateQueries({ queryKey: [...assessmentKeys.all, 'preview', detail.id] });
    void qc.invalidateQueries({ queryKey: [...assessmentKeys.all, 'questions'] });
    void qc.invalidateQueries({ queryKey: [...assessmentKeys.all, 'bank'] });
  };
}

export function useCreateQuestion() {
  const write = useQuestionWriter();
  return useMutation({
    mutationFn: (body: assessment.CreateQuestionRequest) =>
      api.post<assessment.QuestionDetail>('/questions', body),
    onSuccess: write,
  });
}

export function useUpdateQuestion(id: Id) {
  const write = useQuestionWriter();
  return useMutation({
    mutationFn: (body: assessment.UpdateQuestionRequest) =>
      api.put<assessment.QuestionDetail>(`/questions/${id}`, body),
    onSuccess: write,
  });
}

export function useQuestionArchive(id: Id) {
  const write = useQuestionWriter();
  return useMutation({
    mutationFn: (archive: boolean) =>
      api.post<assessment.QuestionDetail>(`/questions/${id}/${archive ? 'archive' : 'restore'}`),
    onSuccess: write,
  });
}

// ------------------------------------------------------------------ attempt review

export function useReviewAttempts(filters: ListFilters) {
  return useQuery({
    queryKey: assessmentKeys.attempts(filters),
    queryFn: ({ signal }) =>
      api.get<PageResult<assessment.ReviewAttemptSummary>>('/attempts', filters, signal),
    placeholderData: keepPreviousData,
  });
}

export function useReviewAttempt(id: Id | undefined) {
  return useQuery({
    queryKey: assessmentKeys.reviewAttempt(id ?? ''),
    queryFn: ({ signal }) =>
      api.get<assessment.ReviewAttemptDetail>(`/attempts/${id}/review`, undefined, signal),
    enabled: Boolean(id),
  });
}
