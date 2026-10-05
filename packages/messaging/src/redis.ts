import { Redis, type RedisOptions } from 'ioredis';

export type { Redis } from 'ioredis';

export function createRedis(url: string, options: RedisOptions = {}): Redis {
  return new Redis(url, {
    lazyConnect: false,
    enableAutoPipelining: true,
    maxRetriesPerRequest: 3,
    ...options,
  });
}

/**
 * Builds keys under an environment namespace (e.g. `a5`, `a5-staging`, `test:xyz`), so several
 * environments or test suites can share one Redis without collisions.
 */
export class RedisNamespace {
  constructor(readonly prefix: string) {}

  key(...parts: Array<string | number>): string {
    return [this.prefix, ...parts].join(':');
  }

  stream(name: string): string {
    return this.key(name);
  }
}
