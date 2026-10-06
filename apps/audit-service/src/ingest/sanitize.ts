/**
 * Producers should never put secrets in audit snapshots, but the audit trail is long-lived and
 * widely readable, so values under secret-looking keys are masked here as a second line of defense.
 */
const SECRET_KEY =
  /password|passcode|passwd|passhash|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|credential|mfa[-_]?code/i;
const MASK = '[redacted]';
const MAX_DEPTH = 12;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated: nested too deeply]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      SECRET_KEY.test(key) && v !== null && v !== undefined && v !== ''
        ? MASK
        : redact(v, depth + 1);
  }
  return out;
}

export interface SnapshotLimit {
  maxBytes: number;
}

/** Redact a snapshot and replace it with a marker when it exceeds the size limit. */
export function sanitizeSnapshot(value: unknown, { maxBytes }: SnapshotLimit): unknown {
  if (value === undefined || value === null) return null;
  const cleaned = redact(value);
  const bytes = Buffer.byteLength(JSON.stringify(cleaned) ?? '', 'utf8');
  if (bytes <= maxBytes) return cleaned;
  return {
    _truncated: true,
    _bytes: bytes,
    _note: 'The snapshot exceeded the audit size limit and was not stored.',
  };
}

export function clip(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return value.length > max ? value.slice(0, max) : value;
}
