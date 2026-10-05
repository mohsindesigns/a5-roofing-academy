import { fileTypeFromBuffer } from 'file-type';

export interface SniffResult {
  mime: string;
  ext: string;
}

/** Detect the real file type from magic bytes. Returns null for unknown/plain-text content. */
export async function sniffMime(head: Buffer): Promise<SniffResult | null> {
  const result = await fileTypeFromBuffer(head);
  return result ? { mime: result.mime, ext: result.ext } : null;
}

export const ALLOWED_TYPES = {
  video: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'],
  document: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  image: ['image/png', 'image/jpeg', 'image/webp'],
  /** Certificate artwork is embedded into PDFs, which accept PNG and JPEG only. */
  certificateImage: ['image/png', 'image/jpeg'],
  caption: ['text/vtt'],
} as const;

export type AllowedKind = keyof typeof ALLOWED_TYPES;

/**
 * Validate declared and sniffed types. Office documents are ZIP containers and sniff as
 * `application/zip` (or the specific OOXML type), WebVTT is text and must start with "WEBVTT".
 */
export async function validateFileContent(
  kind: AllowedKind,
  declaredMime: string,
  head: Buffer,
): Promise<{ ok: true; mime: string } | { ok: false; reason: string }> {
  const allowed = ALLOWED_TYPES[kind] as readonly string[];
  if (!allowed.includes(declaredMime)) return { ok: false, reason: `File type ${declaredMime} is not allowed.` };
  if (kind === 'caption') {
    return head.subarray(0, 6).toString('utf8').replace(/^\uFEFF/, '').startsWith('WEBVTT')
      ? { ok: true, mime: 'text/vtt' }
      : { ok: false, reason: 'Captions must be WebVTT files.' };
  }
  const sniffed = await sniffMime(head);
  if (!sniffed) return { ok: false, reason: 'The file content could not be recognised.' };
  const officeZip = declaredMime.startsWith('application/vnd.openxmlformats') && (sniffed.mime === 'application/zip' || sniffed.mime === declaredMime);
  const quicktime = declaredMime === 'video/quicktime' && sniffed.mime === 'video/quicktime';
  if (sniffed.mime !== declaredMime && !officeZip && !quicktime) {
    return { ok: false, reason: `File content (${sniffed.mime}) does not match its declared type (${declaredMime}).` };
  }
  return { ok: true, mime: declaredMime };
}
