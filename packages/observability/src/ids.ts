import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): 48-bit unix ms timestamp + random. Time ordered, so B-tree inserts stay
 * append-mostly. A monotonic counter keeps ids generated in the same millisecond ordered.
 */
let lastMs = 0;
let seq = 0;

export function uuidv7(now: number = Date.now()): string {
  if (now === lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) now = lastMs + 1;
  } else {
    seq = randomBytes(2).readUInt16BE(0) & 0x7ff;
  }
  lastMs = Math.max(now, lastMs);
  const bytes = randomBytes(16);
  const ms = BigInt(lastMs);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** URL-safe random token with the given entropy in bytes. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
