import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageResult, analytics } from '@a5/contracts';
import { api } from '@/lib/api/client';

export const analyticsKeys = {
  all: ['analytics'] as const,
  team: (f: analytics.AnalyticsFilters) => [...analyticsKeys.all, 'team', f] as const,
  company: (f: analytics.AnalyticsFilters) => [...analyticsKeys.all, 'company', f] as const,
  learner: (userId: string) => [...analyticsKeys.all, 'learner', userId] as const,
  reportList: () => [...analyticsKeys.all, 'report-list'] as const,
  report: (key: string, q: Record<string, unknown>) =>
    [...analyticsKeys.all, 'report', key, q] as const,
  exports: (page: number) => [...analyticsKeys.all, 'exports', page] as const,
};

/** Dashboard for the people the caller can see (every data scope may call this). */
export function useTeamDashboard(filters: analytics.AnalyticsFilters, enabled = true) {
  return useQuery({
    queryKey: analyticsKeys.team(filters),
    queryFn: ({ signal }) =>
      api.get<analytics.TeamDashboard>('/analytics/dashboards/team', { ...filters }, signal),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** Organization-wide dashboard. The API answers 403 below organization scope. */
export function useCompanyDashboard(filters: analytics.AnalyticsFilters, enabled = true) {
  return useQuery({
    queryKey: analyticsKeys.company(filters),
    queryFn: ({ signal }) =>
      api.get<analytics.CompanyDashboard>('/analytics/dashboards/company', { ...filters }, signal),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function useLearnerSummary(userId: string | null) {
  return useQuery({
    queryKey: analyticsKeys.learner(userId ?? ''),
    queryFn: ({ signal }) =>
      api.get<analytics.LearnerSummary>(`/analytics/learners/${userId}/summary`, undefined, signal),
    enabled: Boolean(userId),
  });
}

export function useReportList() {
  return useQuery({
    queryKey: analyticsKeys.reportList(),
    queryFn: () => api.get<{ items: analytics.ReportDefinitionDto[] }>('/reports'),
    staleTime: 10 * 60_000,
  });
}

export interface ReportRunQuery extends analytics.AnalyticsFilters {
  page: number;
  pageSize: number;
  q?: string;
  sort?: string;
}

export function useReportPage(key: analytics.ReportKey | null, query: ReportRunQuery) {
  return useQuery({
    queryKey: analyticsKeys.report(key ?? '', { ...query }),
    queryFn: ({ signal }) => api.get<analytics.ReportPage>(`/reports/${key}`, { ...query }, signal),
    enabled: key !== null,
    placeholderData: keepPreviousData,
  });
}

const ACTIVE_EXPORT = new Set<analytics.ExportJob['status']>(['queued', 'running']);

/** Export jobs of the signed-in user, polled while any job is still being prepared. */
export function useExports(page: number, enabled = true) {
  return useQuery({
    queryKey: analyticsKeys.exports(page),
    queryFn: ({ signal }) =>
      api.get<PageResult<analytics.ExportJob>>('/reports/exports', { page, pageSize: 10 }, signal),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      query.state.data?.items.some((j) => ACTIVE_EXPORT.has(j.status)) ? 3_000 : false,
  });
}

export function useCreateExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: analytics.CreateExportRequest) =>
      api.post<analytics.ExportJob>('/reports/exports', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...analyticsKeys.all, 'exports'] }),
  });
}

export function useExportDownload() {
  return useMutation({
    mutationFn: (id: string) =>
      api.get<analytics.ExportDownload>(`/reports/exports/${id}/download`),
  });
}

/** Hand the browser a signed file URL. The response carries `Content-Disposition: attachment`. */
export function startDownload(url: string, fileName: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}
