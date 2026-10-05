import { create } from 'zustand';
import type { media } from '@a5/contracts';
import { errorMessage } from '@/lib/api/errors';
import { queryClient } from '@/lib/query-client';
import { completeUpload, createCaptionUpload, createUpload, mediaKeys } from './api';
import { UploadError, resolveMime, uploadToStorage, type UploadKind } from './upload';

export type UploadStage = 'queued' | 'uploading' | 'verifying' | 'done' | 'failed' | 'cancelled';

export interface UploadItem {
  id: string;
  file: File;
  title: string;
  kind: UploadKind;
  stage: UploadStage;
  loaded: number;
  error?: string;
  assetId?: string;
  /** True once storage has the file; a retry then only has to ask the API to verify it. */
  stored: boolean;
}

interface UploadState {
  items: UploadItem[];
  enqueue: (files: Array<{ file: File; title: string; kind: UploadKind }>) => void;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  dismiss: (id: string) => void;
  clearFinished: () => void;
}

const CONCURRENCY = 2;
const controllers = new Map<string, AbortController>();
let seq = 0;

export const useUploads = create<UploadState>((set, get) => {
  const patch = (id: string, change: Partial<UploadItem>) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...change } : i)) }));

  async function run(id: string): Promise<void> {
    const item = get().items.find((i) => i.id === id);
    if (!item) return;
    const controller = new AbortController();
    controllers.set(id, controller);
    patch(id, { stage: 'uploading', error: undefined });
    try {
      let assetId = item.assetId;
      if (!item.stored) {
        const created = await createUpload({
          kind: item.kind,
          title: item.title,
          filename: item.file.name,
          mimeType: resolveMime(item.file),
          sizeBytes: item.file.size,
        } as media.CreateUploadRequest);
        assetId = created.assetId;
        patch(id, { assetId });
        await uploadToStorage(
          created.upload,
          item.file,
          (p) => patch(id, { loaded: p.loaded }),
          controller.signal,
        );
        patch(id, { stored: true });
      }
      patch(id, { stage: 'verifying' });
      await completeUpload(assetId!);
      patch(id, { stage: 'done', loaded: item.file.size });
      void queryClient.invalidateQueries({ queryKey: mediaKeys.all });
    } catch (err) {
      if (err instanceof UploadError && err.kind === 'aborted') patch(id, { stage: 'cancelled' });
      else patch(id, { stage: 'failed', error: errorMessage(err) });
    } finally {
      controllers.delete(id);
      pump();
    }
  }

  /** Start queued uploads while fewer than CONCURRENCY are running. */
  function pump(): void {
    const { items } = get();
    let running = items.filter((i) => i.stage === 'uploading' || i.stage === 'verifying').length;
    for (const item of items) {
      if (running >= CONCURRENCY) break;
      if (item.stage === 'queued') {
        running += 1;
        void run(item.id);
      }
    }
  }

  return {
    items: [],
    enqueue: (files) => {
      set((s) => ({
        items: [
          ...s.items,
          ...files.map((f) => ({
            id: `upload-${++seq}`,
            file: f.file,
            title: f.title,
            kind: f.kind,
            stage: 'queued' as const,
            loaded: 0,
            stored: false,
          })),
        ],
      }));
      pump();
    },
    cancel: (id) => {
      controllers.get(id)?.abort();
      if (get().items.find((i) => i.id === id)?.stage === 'queued')
        patch(id, { stage: 'cancelled' });
    },
    retry: (id) => {
      const item = get().items.find((i) => i.id === id);
      if (!item) return;
      patch(id, { stage: 'queued', error: undefined, loaded: item.stored ? item.file.size : 0 });
      pump();
    },
    dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
    clearFinished: () =>
      set((s) => ({ items: s.items.filter((i) => i.stage !== 'done' && i.stage !== 'cancelled') })),
  };
});

/**
 * Upload a WebVTT file as captions for a video. Resolves once the API verified the file.
 * Progress is reported for the transfer only.
 */
export async function uploadCaptions(
  videoId: string,
  input: { file: File; language: string; label: string; isDefault: boolean },
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  const created = await createCaptionUpload(videoId, {
    language: input.language,
    label: input.label,
    isDefault: input.isDefault,
    filename: input.file.name,
    sizeBytes: input.file.size,
  });
  await uploadToStorage(created.upload, input.file, (p) => onProgress(p.loaded, p.total));
  await completeUpload(created.assetId);
  await queryClient.invalidateQueries({ queryKey: mediaKeys.detail(videoId) });
}
