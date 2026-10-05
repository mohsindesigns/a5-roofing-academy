import { randomBytes } from 'node:crypto';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

/** Unique Redis namespace so parallel suites never share keys, streams or queues. */
export function testRedisNamespace(prefix: string): string {
  return `test:${prefix}:${randomBytes(4).toString('hex')}`;
}
