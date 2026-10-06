import { createHash } from 'node:crypto';

/**
 * Deterministic UUID (version 5 layout) for derived rows such as feed entries, so re-applying the
 * same fact from a different event (redelivery, regrade) updates one row instead of adding another.
 */
export function stableId(...parts: string[]): string {
  const hash = createHash('sha1')
    .update(`a5-analytics:${parts.join(':')}`)
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
