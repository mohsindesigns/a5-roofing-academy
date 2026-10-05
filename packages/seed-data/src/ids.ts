import { createHash } from 'node:crypto';

const NAMESPACE = 'a5-roofing-sales-academy-seed';

/**
 * Deterministic RFC 4122 version 5 UUID for seed records, so every service's seed refers to the
 * same users, programs and assessments without coordination.
 */
export function seedId(name: string): string {
  const hash = createHash('sha1').update(`${NAMESPACE}:${name}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
