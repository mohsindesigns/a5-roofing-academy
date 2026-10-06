import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { z } from 'zod';
import type { PageResult, assessment, learning, ai, certification as c } from '@a5/contracts';
import { api, buildUrl } from '@/lib/api/client';
import { ApiError, NETWORK_ERROR_MESSAGE } from '@/lib/api/errors';
import type {
  Approval,
  Candidate,
  CertificateDetail,
  CertificateEvent,
  CertificateSummary,
  CertificationAsset,
  CertificationDetail,
  CertificationSettings,
  CertificationSummary,
  Dashboard,
  DownloadLink,
  ImageVersion,
  MyCertifications,
  OwnCertificate,
  Progress,
  PublicVerification,
  RenewalItem,
  ReissueReason,
  RevocationItem,
  Signatory,
  Stamp,
  StarterKey,
  TeamStatusRow,
  TemplateDesignInput,
  TemplateDetail,
  TemplatePreview,
  TemplateStarter,
  TemplateSummary,
  TemplateVersion,
  TemplateVersionDetail,
} from './types';

// ------------------------------------------------------------------ filters

export interface PageFilters {
  q?: string;
  sort?: string;
  page: number;
  pageSize: number;
}

export interface CertificateFilters extends PageFilters {
  status?: string;
  definitionId?: string;
  userId?: string;
  teamId?: string;
  issuedFrom?: string;
  issuedTo?: string;
  expiringWithinDays?: number;
}

export interface TeamFilters extends PageFilters {
  definitionId?: string;
  teamId?: string;
  filter?: c.TeamFilter;
  expiringWithinDays?: number;
}

export interface ApprovalFilters extends PageFilters {
  status?: string;
  definitionId?: string;
}

export interface CandidateFilters extends PageFilters {
  status?: string;
  definitionId?: string;
}

export interface RenewalFilters extends PageFilters {
  status?: string;
  definitionId?: string;
}

export interface DefinitionFilters extends PageFilters {
  status?: string;
}

export interface TemplateFilters extends PageFilters {
  status?: string;
}

export interface ArtworkFilters extends PageFilters {
  active?: 'true' | 'false';
}

// ------------------------------------------------------------------ keys

export const certKeys = {
  all: ['certification'] as const,
  mine: () => [...certKeys.all, 'mine'] as const,
  mineDetail: (id: string) => [...certKeys.all, 'mine', 'detail', id] as const,
  dashboard: () => [...certKeys.all, 'dashboard'] as const,
  team: (f: TeamFilters) => [...certKeys.all, 'team', f] as const,
  approvals: (f: ApprovalFilters) => [...certKeys.all, 'approvals', f] as const,
  certificates: () => [...certKeys.all, 'certificates'] as const,
  certificateList: (f: CertificateFilters) => [...certKeys.certificates(), 'list', f] as const,
  certificate: (id: string) => [...certKeys.certificates(), 'detail', id] as const,
  events: (id: string) => [...certKeys.certificates(), 'events', id] as const,
  candidates: (f: CandidateFilters) => [...certKeys.all, 'candidates', f] as const,
  revocations: (f: PageFilters & { definitionId?: string }) =>
    [...certKeys.all, 'revocations', f] as const,
  renewals: (f: RenewalFilters) => [...certKeys.all, 'renewals', f] as const,
  definitions: () => [...certKeys.all, 'definitions'] as const,
  definitionList: (f: DefinitionFilters) => [...certKeys.definitions(), 'list', f] as const,
  definition: (id: string) => [...certKeys.definitions(), 'detail', id] as const,
  progress: (id: string, userId: string | undefined) =>
    [...certKeys.all, 'progress', id, userId ?? 'me'] as const,
  templates: () => [...certKeys.all, 'templates'] as const,
  templateList: (f: TemplateFilters) => [...certKeys.templates(), 'list', f] as const,
  template: (id: string) => [...certKeys.templates(), 'detail', id] as const,
  versions: (id: string) => [...certKeys.templates(), 'versions', id] as const,
  version: (id: string, versionId: string) =>
    [...certKeys.templates(), 'version', id, versionId] as const,
  starters: () => [...certKeys.templates(), 'starters'] as const,
  signatories: () => [...certKeys.all, 'signatories'] as const,
  signatoryList: (f: ArtworkFilters) => [...certKeys.signatories(), 'list', f] as const,
  signatures: (id: string) => [...certKeys.signatories(), 'signatures', id] as const,
  stamps: () => [...certKeys.all, 'stamps'] as const,
  stampList: (f: ArtworkFilters) => [...certKeys.stamps(), 'list', f] as const,
  settings: () => [...certKeys.all, 'settings'] as const,
  lookups: () => [...certKeys.all, 'lookups'] as const,
};

/** Everything that changes when a certificate is issued, revoked, approved or renewed. */
function invalidateLifecycle(qc: QueryClient) {
  for (const key of [
    certKeys.certificates(),
    certKeys.mine(),
    [...certKeys.all, 'dashboard'],
    [...certKeys.all, 'team'],
    [...certKeys.all, 'approvals'],
    [...certKeys.all, 'candidates'],
    [...certKeys.all, 'revocations'],
    [...certKeys.all, 'renewals'],
    certKeys.definitions(),
    ['notifications', 'unread'],
  ]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

// ------------------------------------------------------------------ learner

export function useMyCertifications() {
  return useQuery({
    queryKey: certKeys.mine(),
    queryFn: ({ signal }) => api.get<MyCertifications>('/certificates/me', undefined, signal),
  });
}

export function useMyCertificate(id: string) {
  return useQuery({
    queryKey: certKeys.mineDetail(id),
    queryFn: ({ signal }) => api.get<OwnCertificate>(`/certificates/me/${id}`, undefined, signal),
  });
}

/** Signed download link, then hand the browser the file. */
export async function startDownload(link: DownloadLink): Promise<void> {
  const a = document.createElement('a');
  a.href = link.url;
  a.download = link.fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function useDownloadCertificate(mode: 'owner' | 'admin') {
  return useMutation({
    mutationFn: async (id: string) => {
      const link = await api.post<DownloadLink>(
        mode === 'owner' ? `/certificates/me/${id}/download` : `/certificates/${id}/download`,
      );
      await startDownload(link);
      return link;
    },
  });
}

// ------------------------------------------------------------------ manager & admin reads

export function useDashboard(enabled = true) {
  return useQuery({
    queryKey: certKeys.dashboard(),
    queryFn: ({ signal }) => api.get<Dashboard>('/certificates/dashboard', undefined, signal),
    enabled,
  });
}

export function useTeamStatus(filters: TeamFilters, enabled = true) {
  return useQuery({
    queryKey: certKeys.team(filters),
    queryFn: ({ signal }) =>
      api.get<PageResult<TeamStatusRow>>('/certificates/team', { ...filters }, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useApprovals(filters: ApprovalFilters, enabled = true) {
  return useQuery({
    queryKey: certKeys.approvals(filters),
    queryFn: ({ signal }) =>
      api.get<PageResult<Approval>>('/certificates/approvals', { ...filters }, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useCandidates(filters: CandidateFilters, enabled = true) {
  return useQuery({
    queryKey: certKeys.candidates(filters),
    queryFn: ({ signal }) =>
      api.get<PageResult<Candidate>>('/certificates/eligibility', { ...filters }, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useCertificates(filters: CertificateFilters, enabled = true) {
  return useQuery({
    queryKey: certKeys.certificateList(filters),
    queryFn: ({ signal }) =>
      api.get<PageResult<CertificateSummary>>('/certificates', { ...filters }, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useCertificate(id: string) {
  return useQuery({
    queryKey: certKeys.certificate(id),
    queryFn: ({ signal }) => api.get<CertificateDetail>(`/certificates/${id}`, undefined, signal),
  });
}

export function useCertificateEvents(id: string) {
  return useQuery({
    queryKey: certKeys.events(id),
    queryFn: ({ signal }) =>
      api.get<{ items: CertificateEvent[] }>(`/certificates/${id}/events`, undefined, signal),
  });
}

export function useRevocations(filters: PageFilters & { definitionId?: string }, enabled = true) {
  return useQuery({
    queryKey: certKeys.revocations(filters),
    queryFn: ({ signal }) =>
      api.get<PageResult<RevocationItem>>('/certificates/revocations', { ...filters }, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useRenewals(filters: RenewalFilters, enabled = true) {
  return useQuery({
    queryKey: certKeys.renewals(filters),
    queryFn: ({ signal }) =>
      api.get<PageResult<RenewalItem>>('/certificates/renewals', { ...filters }, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

// ------------------------------------------------------------------ certificate actions

export function useDecideApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'rejected'; comment: string | null }) =>
      api.post<Approval>(`/certificates/approvals/${v.id}/decision`, {
        decision: v.decision,
        comment: v.comment,
      }),
    onSuccess: () => invalidateLifecycle(qc),
    // A concurrent decision by someone else: refresh so the queue shows the current state.
    onError: () => void qc.invalidateQueries({ queryKey: [...certKeys.all, 'approvals'] }),
  });
}

export function useIssueCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { definitionId: string; userId: string; override?: { reason: string } }) =>
      api.post<CertificateDetail>('/certificates', body),
    onSuccess: (cert) => {
      qc.setQueryData(certKeys.certificate(cert.id), cert);
      invalidateLifecycle(qc);
    },
  });
}

export function useReissueCertificate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { reasonCode: ReissueReason; note: string }) =>
      api.post<CertificateDetail>(`/certificates/${id}/reissue`, body),
    onSuccess: () => invalidateLifecycle(qc),
  });
}

export function useRevokeCertificate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { reason: string; publicNote: string | null; confirmation: string }) =>
      api.post<CertificateDetail>(`/certificates/${id}/revoke`, body),
    onSuccess: (cert) => {
      qc.setQueryData(certKeys.certificate(id), cert);
      invalidateLifecycle(qc);
    },
  });
}

export function useRetryPdf(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<CertificateDetail>(`/certificates/${id}/pdf/retry`),
    onSuccess: (cert) => {
      qc.setQueryData(certKeys.certificate(id), cert);
      void qc.invalidateQueries({ queryKey: certKeys.certificates() });
    },
  });
}

// ------------------------------------------------------------------ definitions

export function useDefinitions(filters: DefinitionFilters, enabled = true) {
  return useQuery({
    queryKey: certKeys.definitionList(filters),
    queryFn: ({ signal }) =>
      api.get<PageResult<CertificationSummary>>('/certifications', { ...filters }, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Names for filters and pickers: first page of active and draft certifications. */
export function useDefinitionOptions(enabled = true) {
  return useQuery({
    queryKey: certKeys.definitionList({ page: 1, pageSize: 100, status: 'draft,active' }),
    queryFn: ({ signal }) =>
      api.get<PageResult<CertificationSummary>>(
        '/certifications',
        { page: 1, pageSize: 100, status: 'draft,active', sort: 'name' },
        signal,
      ),
    staleTime: 60_000,
    enabled,
  });
}

export function useDefinition(id: string, enabled = true) {
  return useQuery({
    queryKey: certKeys.definition(id),
    queryFn: ({ signal }) =>
      api.get<CertificationDetail>(`/certifications/${id}`, undefined, signal),
    enabled,
  });
}

export function useMyProgress(definitionId: string, enabled = true) {
  return useQuery({
    queryKey: certKeys.progress(definitionId, undefined),
    queryFn: ({ signal }) =>
      api.get<Progress>(`/certifications/${definitionId}/progress`, undefined, signal),
    enabled,
  });
}

function useDefinitionCache() {
  const qc = useQueryClient();
  return (def: CertificationDetail) => {
    qc.setQueryData(certKeys.definition(def.id), def);
    void qc.invalidateQueries({ queryKey: [...certKeys.definitions(), 'list'] });
  };
}

export function useCreateDefinition() {
  const cache = useDefinitionCache();
  return useMutation({
    mutationFn: (
      body: Partial<c.CreateCertificationRequest> & {
        name: string;
        code: string;
        issuingOrganizationName: string;
      },
    ) => api.post<CertificationDetail>('/certifications', body),
    onSuccess: cache,
  });
}

export function useUpdateDefinition(id: string) {
  const cache = useDefinitionCache();
  return useMutation({
    mutationFn: (body: c.UpdateCertificationRequest) =>
      api.patch<CertificationDetail>(`/certifications/${id}`, body),
    onSuccess: cache,
  });
}

export function useActivateDefinition(id: string) {
  const cache = useDefinitionCache();
  return useMutation({
    mutationFn: () => api.post<CertificationDetail>(`/certifications/${id}/activate`),
    onSuccess: cache,
  });
}

export function useArchiveDefinition(id: string) {
  const cache = useDefinitionCache();
  return useMutation({
    mutationFn: () => api.post<CertificationDetail>(`/certifications/${id}/archive`),
    onSuccess: cache,
  });
}

// ------------------------------------------------------------------ templates

export function useTemplates(filters: TemplateFilters, enabled = true) {
  return useQuery({
    queryKey: certKeys.templateList(filters),
    queryFn: ({ signal }) =>
      api.get<PageResult<TemplateSummary>>('/certificate-templates', { ...filters }, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useTemplateOptions(enabled = true) {
  return useTemplates({ page: 1, pageSize: 100, status: 'active' }, enabled);
}

export function useTemplateStarters() {
  return useQuery({
    queryKey: certKeys.starters(),
    queryFn: ({ signal }) =>
      api.get<{ items: TemplateStarter[] }>('/certificate-templates/starters', undefined, signal),
    staleTime: 10 * 60_000,
  });
}

export function useTemplate(id: string) {
  return useQuery({
    queryKey: certKeys.template(id),
    queryFn: ({ signal }) =>
      api.get<TemplateDetail>(`/certificate-templates/${id}`, undefined, signal),
  });
}

export function useTemplateVersions(id: string) {
  return useQuery({
    queryKey: certKeys.versions(id),
    queryFn: ({ signal }) =>
      api.get<{ items: TemplateVersion[] }>(
        `/certificate-templates/${id}/versions`,
        undefined,
        signal,
      ),
  });
}

export function useTemplateVersion(id: string, versionId: string | null) {
  return useQuery({
    queryKey: certKeys.version(id, versionId ?? ''),
    queryFn: ({ signal }) =>
      api.get<TemplateVersionDetail>(
        `/certificate-templates/${id}/versions/${versionId}`,
        undefined,
        signal,
      ),
    enabled: Boolean(versionId),
    staleTime: Infinity,
  });
}

function useTemplateCache() {
  const qc = useQueryClient();
  return (template: TemplateDetail) => {
    qc.setQueryData(certKeys.template(template.id), template);
    void qc.invalidateQueries({ queryKey: [...certKeys.templates(), 'list'] });
    void qc.invalidateQueries({ queryKey: certKeys.versions(template.id) });
    void qc.invalidateQueries({ queryKey: [...certKeys.definitions(), 'list'] });
  };
}

export function useCreateTemplate() {
  const cache = useTemplateCache();
  return useMutation({
    mutationFn: (body: { name: string; description?: string | null; starter?: StarterKey }) =>
      api.post<TemplateDetail>('/certificate-templates', body),
    onSuccess: cache,
  });
}

export function useCloneTemplate(id: string) {
  const cache = useTemplateCache();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<TemplateDetail>(`/certificate-templates/${id}/clone`, { name }),
    onSuccess: cache,
  });
}

export function useUpdateTemplate(id: string) {
  const cache = useTemplateCache();
  return useMutation({
    mutationFn: (body: { name?: string; description?: string | null }) =>
      api.patch<TemplateDetail>(`/certificate-templates/${id}`, body),
    onSuccess: cache,
  });
}

export function useSaveTemplateDesign(id: string) {
  const cache = useTemplateCache();
  return useMutation({
    mutationFn: (body: { design: TemplateDesignInput; changeNote: string | null }) =>
      api.put<TemplateDetail>(`/certificate-templates/${id}/design`, body),
    onSuccess: cache,
  });
}

export function useArchiveTemplate(id: string) {
  const cache = useTemplateCache();
  return useMutation({
    mutationFn: () => api.post<TemplateDetail>(`/certificate-templates/${id}/archive`),
    onSuccess: cache,
  });
}

export function useSetDefaultTemplate(id: string) {
  const cache = useTemplateCache();
  return useMutation({
    mutationFn: () => api.post<TemplateDetail>(`/certificate-templates/${id}/default`),
    onSuccess: cache,
  });
}

export function useAssignTemplate(id: string) {
  const cache = useTemplateCache();
  return useMutation({
    mutationFn: (certificationIds: string[]) =>
      api.post<TemplateDetail>(`/certificate-templates/${id}/assign`, { certificationIds }),
    onSuccess: cache,
  });
}

/** Server-rendered sample: a watermarked PDF plus the resolved values the live preview needs. */
export function usePreviewTemplate(id: string) {
  return useMutation({
    mutationFn: (body: { design?: TemplateDesignInput; certificationId?: string }) =>
      api.post<TemplatePreview>(`/certificate-templates/${id}/preview`, body),
  });
}

// ------------------------------------------------------------------ signatories & stamps

export function useSignatories(filters: ArtworkFilters, enabled = true) {
  return useQuery({
    queryKey: certKeys.signatoryList(filters),
    queryFn: ({ signal }) => api.get<PageResult<Signatory>>('/signatories', { ...filters }, signal),
    placeholderData: keepPreviousData,
    enabled,
    // Preview URLs are signed and short-lived.
    staleTime: 5 * 60_000,
  });
}

export function useSignatures(id: string, enabled: boolean) {
  return useQuery({
    queryKey: certKeys.signatures(id),
    queryFn: ({ signal }) =>
      api.get<{ items: ImageVersion[] }>(`/signatories/${id}/signatures`, undefined, signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useSaveSignatory(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      id
        ? api.patch<Signatory>(`/signatories/${id}`, body)
        : api.post<Signatory>('/signatories', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: certKeys.signatories() });
      void qc.invalidateQueries({ queryKey: [...certKeys.definitions()] });
    },
  });
}

export function useStamps(filters: ArtworkFilters, enabled = true) {
  return useQuery({
    queryKey: certKeys.stampList(filters),
    queryFn: ({ signal }) => api.get<PageResult<Stamp>>('/stamps', { ...filters }, signal),
    placeholderData: keepPreviousData,
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useSaveStamp(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      id ? api.patch<Stamp>(`/stamps/${id}`, body) : api.post<Stamp>('/stamps', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: certKeys.stamps() });
      void qc.invalidateQueries({ queryKey: [...certKeys.definitions()] });
    },
  });
}

/** Multipart upload of a signature or stamp image: the field must be named `file`. */
function formWithFile(file: File): FormData {
  const form = new FormData();
  form.append('file', file);
  return form;
}

export function useUploadSignature(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) =>
      api.post<Signatory>(`/certification-assets/signatories/${id}/signature`, formWithFile(file)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: certKeys.signatories() });
    },
  });
}

export function useUploadStampImage(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) =>
      api.post<Stamp>(`/certification-assets/stamps/${id}/image`, formWithFile(file)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: certKeys.stamps() });
    },
  });
}

/** Template and badge images (background, logo, badge). Returns the asset with a signed preview URL. */
export function useUploadAsset(purpose: 'background' | 'logo' | 'badge') {
  return useMutation({
    mutationFn: async (file: File) => {
      const asset = await api.post<CertificationAsset>(
        `/certification-assets/images?purpose=${purpose}`,
        formWithFile(file),
      );
      return asset;
    },
  });
}

export function useAsset(id: string | null | undefined) {
  return useQuery({
    queryKey: [...certKeys.all, 'asset', id ?? ''],
    queryFn: ({ signal }) =>
      api.get<CertificationAsset>(`/certification-assets/${id}`, undefined, signal),
    enabled: Boolean(id),
    staleTime: 5 * 60_000,
  });
}

// ------------------------------------------------------------------ settings

export function useCertificationSettings() {
  return useQuery({
    queryKey: certKeys.settings(),
    queryFn: ({ signal }) =>
      api.get<CertificationSettings>('/certification-settings', undefined, signal),
  });
}

export function useSaveCertificationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.put<CertificationSettings>('/certification-settings', body),
    onSuccess: (settings) => {
      qc.setQueryData(certKeys.settings(), settings);
      void qc.invalidateQueries({ queryKey: certKeys.definitions() });
    },
  });
}

// ------------------------------------------------------------------ lookups for the rule editor

export interface LookupOption {
  id: string;
  label: string;
}

/** Reference data for eligibility rules. Each lookup needs the owning area's view permission. */
export function useProgramLookup() {
  return useQuery({
    queryKey: [...certKeys.lookups(), 'programs'],
    queryFn: async ({ signal }): Promise<LookupOption[]> => {
      const page = await api.get<PageResult<learning.ProgramSummary>>(
        '/programs',
        { page: 1, pageSize: 100, sort: 'title' },
        signal,
      );
      return page.items.map((p) => ({ id: p.id, label: p.title }));
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Query options for one program's phases and lessons (used to pick phase and lesson requirements). */
export function programStructureQuery(programId: string) {
  return {
    queryKey: [...certKeys.lookups(), 'program-structure', programId],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api.get<learning.ProgramDetail>(`/programs/${programId}`, undefined, signal),
    staleTime: 5 * 60_000,
    retry: false,
  };
}

export function useAssessmentLookup() {
  return useQuery({
    queryKey: [...certKeys.lookups(), 'assessments'],
    queryFn: async ({ signal }): Promise<LookupOption[]> => {
      const page = await api.get<PageResult<assessment.AssessmentSummary>>(
        '/assessments',
        { page: 1, pageSize: 100, sort: 'title' },
        signal,
      );
      return page.items.map((a) => ({ id: a.id, label: a.title }));
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useScenarioLookup() {
  return useQuery({
    queryKey: [...certKeys.lookups(), 'scenarios'],
    queryFn: async ({ signal }): Promise<LookupOption[]> => {
      const page = await api.get<PageResult<z.infer<typeof ai.scenarioSummarySchema>>>(
        '/ai/scenarios',
        { page: 1, pageSize: 100, sort: 'title' },
        signal,
      );
      return page.items.map((s) => ({ id: s.id, label: s.title }));
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// ------------------------------------------------------------------ public verification

/**
 * Public verification result. Deliberately bypasses the authenticated client: no credentials, no
 * bearer token and no refresh attempt, so the page behaves identically for signed-in and
 * anonymous visitors.
 */
export async function fetchPublicVerification(
  token: string,
  signal?: AbortSignal,
): Promise<PublicVerification> {
  let res: Response;
  try {
    res = await fetch(buildUrl(`/public/certificates/verify/${encodeURIComponent(token)}`), {
      signal,
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE);
  }
  if (!res.ok) throw await ApiError.fromResponse(res);
  return (await res.json()) as PublicVerification;
}
