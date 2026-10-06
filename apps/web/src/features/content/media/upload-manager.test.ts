import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  createUpload: vi.fn(),
  completeUpload: vi.fn(),
  createCaptionUpload: vi.fn(),
}));
const storage = vi.hoisted(() => ({ uploadToStorage: vi.fn() }));

vi.mock('./api', () => ({ ...api, mediaKeys: { all: ['media'] } }));
vi.mock('./upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./upload')>()),
  uploadToStorage: storage.uploadToStorage,
}));
vi.mock('@/lib/query-client', () => ({ queryClient: { invalidateQueries: vi.fn() } }));

import { UploadError } from './upload';
import { useUploads } from './upload-manager';

const target = {
  method: 'PUT',
  url: '/u',
  fields: {},
  headers: {},
  expiresAt: '2026-10-05T18:00:00.000Z',
};
const file = (name: string) => new File(['x'.repeat(10)], name, { type: 'video/mp4' });
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  useUploads.setState({ items: [] });
  vi.clearAllMocks();
  api.createUpload.mockImplementation(async (body: { filename: string }) => ({
    assetId: `asset-${body.filename}`,
    upload: target,
    maxBytes: 1_000,
  }));
  api.completeUpload.mockResolvedValue({});
});

describe('upload manager', () => {
  it('runs two uploads at a time and starts the next when one finishes', async () => {
    const releases: Array<() => void> = [];
    storage.uploadToStorage.mockImplementation(
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );
    useUploads
      .getState()
      .enqueue(
        ['a', 'b', 'c'].map((n) => ({ file: file(`${n}.mp4`), title: n, kind: 'video' as const })),
      );
    await tick();
    const stages = () => useUploads.getState().items.map((i) => i.stage);
    expect(stages()).toEqual(['uploading', 'uploading', 'queued']);

    releases[0]!();
    await tick();
    await tick();
    expect(stages()).toEqual(['done', 'uploading', 'uploading']);
    expect(api.completeUpload).toHaveBeenCalledWith('asset-a.mp4');
  });

  it('reports a storage failure and retries from the start', async () => {
    storage.uploadToStorage.mockRejectedValueOnce(
      new UploadError('The connection dropped during the upload. Try again.', 'network'),
    );
    useUploads.getState().enqueue([{ file: file('a.mp4'), title: 'a', kind: 'video' }]);
    await tick();
    const failed = useUploads.getState().items[0]!;
    expect(failed.stage).toBe('failed');
    expect(failed.error).toMatch(/connection dropped/);

    storage.uploadToStorage.mockResolvedValueOnce(undefined);
    useUploads.getState().retry(failed.id);
    await tick();
    await tick();
    expect(useUploads.getState().items[0]!.stage).toBe('done');
    expect(api.createUpload).toHaveBeenCalledTimes(2);
  });

  it('retries only the verification when the file already reached storage', async () => {
    storage.uploadToStorage.mockResolvedValue(undefined);
    api.completeUpload.mockRejectedValueOnce(new Error('The file looks damaged.'));
    useUploads.getState().enqueue([{ file: file('a.mp4'), title: 'a', kind: 'video' }]);
    await tick();
    await tick();
    const item = useUploads.getState().items[0]!;
    expect(item.stage).toBe('failed');
    expect(item.stored).toBe(true);

    useUploads.getState().retry(item.id);
    await tick();
    await tick();
    expect(useUploads.getState().items[0]!.stage).toBe('done');
    expect(api.createUpload).toHaveBeenCalledTimes(1);
    expect(storage.uploadToStorage).toHaveBeenCalledTimes(1);
    expect(api.completeUpload).toHaveBeenCalledTimes(2);
  });

  it('cancels an upload in flight', async () => {
    storage.uploadToStorage.mockImplementation(
      (_t: unknown, _f: unknown, _p: unknown, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new UploadError('cancelled', 'aborted')));
        }),
    );
    useUploads.getState().enqueue([{ file: file('a.mp4'), title: 'a', kind: 'video' }]);
    await tick();
    const id = useUploads.getState().items[0]!.id;
    useUploads.getState().cancel(id);
    await tick();
    expect(useUploads.getState().items[0]!.stage).toBe('cancelled');
    expect(api.completeUpload).not.toHaveBeenCalled();
  });
});
