import { media } from '@a5/contracts';

/**
 * Direct-to-storage upload with progress. The media API hands out a one-shot upload target
 * (presigned POST for S3-compatible storage, signed PUT for local development); the browser sends
 * the file there and then asks the API to verify it. The API has no chunked or resumable upload,
 * so an interrupted transfer is restarted from the beginning (the caller offers a retry).
 */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'rejected' | 'aborted',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

/** Send `file` to the target from `POST /media/uploads`. Resolves when storage accepted it. */
export function uploadToStorage(
  target: media.UploadTarget,
  file: Blob,
  onProgress: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadError('The upload was cancelled.', 'aborted'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, target.url);
    let body: Blob | FormData;
    if (target.method === 'POST') {
      const form = new FormData();
      // Storage requires the policy fields before the file field.
      for (const [name, value] of Object.entries(target.fields)) form.append(name, value);
      form.append('file', file);
      body = form;
    } else {
      for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);
      body = file;
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress({ loaded: e.loaded, total: e.total });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress({ loaded: file.size, total: file.size });
        resolve();
      } else {
        reject(
          new UploadError(
            xhr.status === 403
              ? 'The upload link expired. Start the upload again.'
              : xhr.status === 413
                ? 'The file is larger than the library allows.'
                : 'Storage did not accept the file. Try again.',
            'rejected',
            xhr.status,
          ),
        );
      }
    };
    xhr.onerror = () =>
      reject(new UploadError('The connection dropped during the upload. Try again.', 'network'));
    xhr.onabort = () => reject(new UploadError('The upload was cancelled.', 'aborted'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

// ------------------------------------------------------------------ file checks

export type UploadKind = Exclude<media.MediaKind, 'caption'>;

const EXTENSION_TO_MIME = new Map<string, string>();
for (const [mime, extensions] of Object.entries(media.MEDIA_FILE_EXTENSIONS)) {
  for (const ext of extensions) EXTENSION_TO_MIME.set(ext, mime);
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** MIME type to send: the browser's, or one derived from the extension when it reports none. */
export function resolveMime(file: Pick<File, 'name' | 'type'>): string {
  return (file.type || EXTENSION_TO_MIME.get(extensionOf(file.name)) || '').toLowerCase();
}

/** Library kind for a file, or null when the library does not accept it. */
export function kindOfFile(file: Pick<File, 'name' | 'type'>): UploadKind | null {
  const mime = resolveMime(file);
  for (const kind of ['video', 'document', 'image'] as const) {
    if ((media.MEDIA_MIME_TYPES[kind] as readonly string[]).includes(mime)) {
      const allowed = media.MEDIA_FILE_EXTENSIONS[mime];
      return !allowed || allowed.includes(extensionOf(file.name)) ? kind : null;
    }
  }
  return null;
}

/** Accept list for `<input type="file">`, built from the same table the API validates with. */
export function acceptAttribute(): string {
  const mimes = (['video', 'document', 'image'] as const).flatMap((k) => media.MEDIA_MIME_TYPES[k]);
  const extensions = mimes.flatMap((m) =>
    (media.MEDIA_FILE_EXTENSIONS[m] ?? []).map((e) => `.${e}`),
  );
  return [...mimes, ...extensions].join(',');
}

/** "Video: MP4, M4V, MOV … · Documents: PDF …" built from the same table the API validates with. */
export function acceptedTypesText(): string {
  const label = { video: 'Video', document: 'Documents', image: 'Images' } as const;
  return (['video', 'document', 'image'] as const)
    .map((kind) => {
      const exts = media.MEDIA_MIME_TYPES[kind].flatMap(
        (m) => media.MEDIA_FILE_EXTENSIONS[m] ?? [],
      );
      return `${label[kind]}: ${exts.map((e) => e.toUpperCase()).join(', ')}`;
    })
    .join(' · ');
}

export function titleFromFilename(name: string): string {
  const base = name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (base || name).slice(0, 200);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// ------------------------------------------------------------------ chapter times

/** "1:05" → 65, "01:02:03" → 3723, "90" → 90. Returns null for anything else. */
export function parseClock(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p)))
    return null;
  const nums = parts.map(Number);
  if (nums.slice(1).some((n) => n >= 60)) return null;
  return nums.reduce((total, n) => total * 60 + n, 0);
}
