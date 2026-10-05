import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { ai } from '@a5/contracts';
import { api } from '@/lib/api/client';

export type ScenarioSummary = z.infer<typeof ai.scenarioSummarySchema>;
export type PromptVersionSummary = z.infer<typeof ai.promptVersionSummarySchema>;
export type RubricSummary = z.infer<typeof ai.rubricSummarySchema>;

type Page<T> = { items: T[]; page: number; pageSize: number; total: number; pageCount: number };

export interface ScenarioFilters {
  q?: string;
  status?: string;
  difficulty?: string;
  category?: string;
  page?: number;
  pageSize?: number;
}

export const scenarioKeys = {
  all: ['ai-scenarios'] as const,
  list: (f: ScenarioFilters) => [...scenarioKeys.all, 'list', f] as const,
  detail: (id: string) => [...scenarioKeys.all, 'detail', id] as const,
  versions: (id: string) => [...scenarioKeys.all, 'versions', id] as const,
  version: (id: string, versionId: string) =>
    [...scenarioKeys.all, 'version', id, versionId] as const,
  diff: (id: string, from: string, to: string) =>
    [...scenarioKeys.all, 'diff', id, from, to] as const,
  personas: (includeArchived: boolean) =>
    [...scenarioKeys.all, 'personas', includeArchived] as const,
  rubrics: (includeArchived: boolean) => [...scenarioKeys.all, 'rubrics', includeArchived] as const,
  rubric: (id: string) => [...scenarioKeys.all, 'rubric', id] as const,
};

// ------------------------------------------------------------------ scenarios

export function useScenarios(filters: ScenarioFilters) {
  return useQuery({
    queryKey: scenarioKeys.list(filters),
    queryFn: () =>
      api.get<Page<ScenarioSummary>>('/ai/scenarios', {
        q: filters.q,
        status: filters.status,
        difficulty: filters.difficulty,
        category: filters.category,
        page: filters.page ?? 1,
        pageSize: filters.pageSize ?? 25,
      }),
    placeholderData: keepPreviousData,
  });
}

export function useScenario(id: string | undefined) {
  return useQuery({
    queryKey: scenarioKeys.detail(id ?? ''),
    queryFn: () => api.get<ai.ScenarioDetail>(`/ai/scenarios/${id}`),
    enabled: Boolean(id),
  });
}

function useScenarioWrites(id?: string) {
  const qc = useQueryClient();
  return (scenario: ai.ScenarioDetail) => {
    qc.setQueryData(scenarioKeys.detail(scenario.id), scenario);
    void qc.invalidateQueries({ queryKey: [...scenarioKeys.all, 'list'] });
    void qc.invalidateQueries({ queryKey: scenarioKeys.versions(id ?? scenario.id) });
  };
}

export function useCreateScenario() {
  const done = useScenarioWrites();
  return useMutation({
    mutationFn: (body: ai.CreateScenarioRequest) =>
      api.post<ai.ScenarioDetail>('/ai/scenarios', body),
    onSuccess: done,
  });
}

export function useUpdateScenario(id: string) {
  const done = useScenarioWrites(id);
  return useMutation({
    mutationFn: (body: ai.UpdateScenarioRequest) =>
      api.patch<ai.ScenarioDetail>(`/ai/scenarios/${id}`, body),
    onSuccess: done,
  });
}

export function usePublishScenario(id: string) {
  const done = useScenarioWrites(id);
  return useMutation({
    mutationFn: () => api.post<ai.ScenarioDetail>(`/ai/scenarios/${id}/publish`),
    onSuccess: done,
  });
}

export function useArchiveScenario(id: string) {
  const done = useScenarioWrites(id);
  return useMutation({
    mutationFn: () => api.post<ai.ScenarioDetail>(`/ai/scenarios/${id}/archive`),
    onSuccess: done,
  });
}

export function useDuplicateScenario(id: string) {
  const done = useScenarioWrites();
  return useMutation({
    mutationFn: (title?: string) =>
      api.post<ai.ScenarioDetail>(`/ai/scenarios/${id}/duplicate`, title ? { title } : {}),
    onSuccess: done,
  });
}

// ------------------------------------------------------------------ prompt versions

export function usePromptVersions(scenarioId: string) {
  return useQuery({
    queryKey: scenarioKeys.versions(scenarioId),
    queryFn: () =>
      api.get<{ items: PromptVersionSummary[] }>(`/ai/scenarios/${scenarioId}/prompt-versions`),
  });
}

export function usePromptVersion(scenarioId: string, versionId: string | null) {
  return useQuery({
    queryKey: scenarioKeys.version(scenarioId, versionId ?? ''),
    queryFn: () =>
      api.get<ai.PromptVersionDetail>(`/ai/scenarios/${scenarioId}/prompt-versions/${versionId}`),
    enabled: Boolean(versionId),
    // Versions are immutable; only the "current" marker can change, and the list carries that.
    staleTime: Infinity,
  });
}

export function usePromptVersionDiff(scenarioId: string, from: string | null, to: string | null) {
  return useQuery({
    queryKey: scenarioKeys.diff(scenarioId, from ?? '', to ?? ''),
    queryFn: () =>
      api.get<ai.PromptVersionDiff>(`/ai/scenarios/${scenarioId}/prompt-versions/diff`, {
        from,
        to,
      }),
    enabled: Boolean(from && to && from !== to),
    // Versions are immutable, so a comparison never goes stale.
    staleTime: Infinity,
  });
}

// ------------------------------------------------------------------ personas

export function usePersonas(includeArchived = false) {
  return useQuery({
    queryKey: scenarioKeys.personas(includeArchived),
    queryFn: () =>
      api.get<Page<ai.Persona>>('/ai/personas', {
        includeArchived: includeArchived ? 'true' : undefined,
        pageSize: 100,
      }),
  });
}

function usePersonaWrites() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [...scenarioKeys.all, 'personas'] });
    // Persona edits publish new prompt versions of the scenarios that use them.
    void qc.invalidateQueries({ queryKey: [...scenarioKeys.all, 'versions'] });
    void qc.invalidateQueries({ queryKey: [...scenarioKeys.all, 'detail'] });
  };
}

export function useCreatePersona() {
  const done = usePersonaWrites();
  return useMutation({
    mutationFn: (body: ai.CreatePersonaRequest) => api.post<ai.Persona>('/ai/personas', body),
    onSuccess: done,
  });
}

export function useUpdatePersona(id: string) {
  const done = usePersonaWrites();
  return useMutation({
    mutationFn: (body: ai.UpdatePersonaRequest) =>
      api.patch<ai.Persona>(`/ai/personas/${id}`, body),
    onSuccess: done,
  });
}

export function useArchivePersona(id: string) {
  const done = usePersonaWrites();
  return useMutation({
    mutationFn: () => api.post<ai.Persona>(`/ai/personas/${id}/archive`),
    onSuccess: done,
  });
}

// ------------------------------------------------------------------ rubrics

export function useRubrics(includeArchived = false) {
  return useQuery({
    queryKey: scenarioKeys.rubrics(includeArchived),
    queryFn: () =>
      api.get<Page<RubricSummary>>('/ai/rubrics', {
        includeArchived: includeArchived ? 'true' : undefined,
        pageSize: 100,
      }),
  });
}

export function useRubric(id: string) {
  return useQuery({
    queryKey: scenarioKeys.rubric(id),
    queryFn: () => api.get<ai.RubricDetail>(`/ai/rubrics/${id}`),
  });
}

function useRubricWrites() {
  const qc = useQueryClient();
  return (rubric: ai.RubricDetail) => {
    qc.setQueryData(scenarioKeys.rubric(rubric.id), rubric);
    void qc.invalidateQueries({ queryKey: [...scenarioKeys.all, 'rubrics'] });
    // A new rubric version creates new prompt versions for every live scenario that uses it.
    void qc.invalidateQueries({ queryKey: [...scenarioKeys.all, 'versions'] });
    void qc.invalidateQueries({ queryKey: [...scenarioKeys.all, 'detail'] });
  };
}

export function useCreateRubric() {
  const done = useRubricWrites();
  return useMutation({
    mutationFn: (body: ai.CreateRubricRequest) => api.post<ai.RubricDetail>('/ai/rubrics', body),
    onSuccess: done,
  });
}

export function useUpdateRubric(id: string) {
  const done = useRubricWrites();
  return useMutation({
    mutationFn: (body: { title?: string; description?: string | null }) =>
      api.patch<ai.RubricDetail>(`/ai/rubrics/${id}`, body),
    onSuccess: done,
  });
}

export function usePublishRubricVersion(id: string) {
  const done = useRubricWrites();
  return useMutation({
    mutationFn: (body: ai.CreateRubricVersionRequest) =>
      api.post<ai.RubricDetail>(`/ai/rubrics/${id}/versions`, body),
    onSuccess: done,
  });
}

export function useArchiveRubric(id: string) {
  const done = useRubricWrites();
  return useMutation({
    mutationFn: () => api.post<ai.RubricDetail>(`/ai/rubrics/${id}/archive`),
    onSuccess: done,
  });
}

export function useRubricVersion(rubricId: string, versionId: string | null) {
  return useQuery({
    queryKey: [...scenarioKeys.rubric(rubricId), 'version', versionId],
    queryFn: () => api.get<ai.RubricVersion>(`/ai/rubrics/${rubricId}/versions/${versionId}`),
    enabled: Boolean(versionId),
    staleTime: Infinity,
  });
}
