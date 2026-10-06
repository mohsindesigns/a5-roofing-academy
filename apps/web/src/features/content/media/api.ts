import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageResult, media } from '@a5/contracts';
import { api } from '@/lib/api/client';

export const mediaKeys = {
  all: ['media'] as const,
  list: (q: Record<string, unknown>) => [...mediaKeys.all, 'list', q] as const,
  detail: (id: string) => [...mediaKeys.all, 'detail', id] as const,
  preview: (id: string) => [...mediaKeys.all, 'preview', id] as const,
};

/** Assets that are still being checked or converted. The library polls until they settle. */
export const IN_PROGRESS: ReadonlySet<media.MediaStatus> = new Set([
  'awaiting_upload',
  'uploaded',
  'scanning',
  'processing',
]);

export interface MediaListQuery {
  q?: string;
  kind?: string;
  status?: string;
  includeArchived?: boolean;
  sort?: string;
  page: number;
  pageSize: number;
}

export function useMediaList(query: MediaListQuery, enabled = true) {
  return useQuery({
    queryKey: mediaKeys.list({ ...query }),
    queryFn: ({ signal }) =>
      api.get<PageResult<media.MediaAssetSummary>>(
        '/media',
        { ...query, includeArchived: query.includeArchived ? 'true' : undefined },
        signal,
      ),
    placeholderData: keepPreviousData,
    enabled,
    refetchInterval: (q) =>
      q.state.data?.items.some((a) => IN_PROGRESS.has(a.status)) ? 3_000 : false,
  });
}

export function useMediaAsset(id: string | null) {
  return useQuery({
    queryKey: mediaKeys.detail(id ?? ''),
    queryFn: ({ signal }) => api.get<media.MediaAssetDetail>(`/media/${id}`, undefined, signal),
    enabled: Boolean(id),
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      const captionsPending = q.state.data?.captions.some((c) => IN_PROGRESS.has(c.status));
      return (status && IN_PROGRESS.has(status)) || captionsPending ? 3_000 : false;
    },
  });
}

export function useMediaPreview(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: mediaKeys.preview(id ?? ''),
    queryFn: () => api.post<media.PlaybackDescriptor>(`/media/${id}/preview`),
    enabled: Boolean(id) && enabled,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}

function useStore(id: string) {
  const qc = useQueryClient();
  return (asset: media.MediaAssetDetail) => {
    qc.setQueryData(mediaKeys.detail(id), asset);
    void qc.invalidateQueries({ queryKey: [...mediaKeys.all, 'list'] });
  };
}

export function useUpdateMedia(id: string) {
  const store = useStore(id);
  return useMutation({
    mutationFn: (body: media.UpdateMediaRequest) =>
      api.patch<media.MediaAssetDetail>(`/media/${id}`, body),
    onSuccess: store,
  });
}

export function useArchiveMedia(id: string) {
  const store = useStore(id);
  return useMutation({
    mutationFn: () => api.post<media.MediaAssetDetail>(`/media/${id}/archive`),
    onSuccess: store,
  });
}

export function useChapters(id: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: mediaKeys.detail(id) });
  return {
    create: useMutation({
      mutationFn: (body: media.CreateChapterRequest) =>
        api.post<{ items: media.Chapter[] }>(`/media/${id}/chapters`, body),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ chapterId, body }: { chapterId: string; body: media.UpdateChapterRequest }) =>
        api.patch<{ items: media.Chapter[] }>(`/media/${id}/chapters/${chapterId}`, body),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (chapterId: string) =>
        api.delete<{ items: media.Chapter[] }>(`/media/${id}/chapters/${chapterId}`),
      onSuccess: refresh,
    }),
  };
}

export function useCaptions(id: string) {
  const store = useStore(id);
  return {
    update: useMutation({
      mutationFn: ({ captionId, body }: { captionId: string; body: media.UpdateCaptionRequest }) =>
        api.patch<media.MediaAssetDetail>(`/media/${id}/captions/${captionId}`, body),
      onSuccess: store,
    }),
    remove: useMutation({
      mutationFn: (captionId: string) =>
        api.delete<media.MediaAssetDetail>(`/media/${id}/captions/${captionId}`),
      onSuccess: store,
    }),
  };
}

// ------------------------------------------------------------------ uploads

export function createUpload(body: media.CreateUploadRequest) {
  return api.post<media.CreateUploadResponse>('/media/uploads', body);
}

export function createCaptionUpload(videoId: string, body: media.CreateCaptionUploadRequest) {
  return api.post<media.CreateUploadResponse & { captionId: string }>(
    `/media/${videoId}/captions`,
    body,
  );
}

export function completeUpload(assetId: string) {
  return api.post<media.MediaAssetDetail>(`/media/uploads/${assetId}/complete`);
}
