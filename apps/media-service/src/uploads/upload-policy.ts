import { media } from '@a5/contracts';
import type { FieldError } from '@a5/nest-kit';
import { ALLOWED_TYPES } from '@a5/storage';

const KIND_LABEL: Record<media.MediaKind, string> = {
  video: 'Videos',
  document: 'Documents',
  image: 'Images',
  caption: 'Caption files',
};

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round((bytes / 1024 ** 2) * 10) / 10} MB`;
  return `${Math.round((bytes / 1024) * 10) / 10} KB`;
}

/** Display name only: strip any path, control characters and surrounding whitespace. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return (cleaned || 'upload').slice(0, 255);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Validate a requested upload against the allowed types and the configured per-kind size limit.
 * Content is verified again after the upload (magic bytes) and during processing.
 */
export function validateUpload(
  input: { kind: media.MediaKind; filename: string; mimeType: string; sizeBytes: number },
  limits: Record<media.MediaKind, number>,
): FieldError[] {
  const errors: FieldError[] = [];
  const allowed = ALLOWED_TYPES[input.kind] as readonly string[];
  if (!allowed.includes(input.mimeType)) {
    const names = (media.MEDIA_MIME_TYPES[input.kind] as readonly string[])
      .flatMap((m) => media.MEDIA_FILE_EXTENSIONS[m] ?? [])
      .map((e) => `.${e}`)
      .join(', ');
    errors.push({ path: 'mimeType', message: `${KIND_LABEL[input.kind]} must be one of: ${names}.` });
  } else {
    const extensions = media.MEDIA_FILE_EXTENSIONS[input.mimeType] ?? [];
    if (!extensions.includes(extensionOf(input.filename))) {
      errors.push({ path: 'filename', message: `The file name must end in ${extensions.map((e) => `.${e}`).join(' or ')} for this file type.` });
    }
  }
  const limit = limits[input.kind];
  if (input.sizeBytes > limit) {
    errors.push({ path: 'sizeBytes', message: `${KIND_LABEL[input.kind]} can be at most ${formatBytes(limit)}.` });
  }
  return errors;
}
