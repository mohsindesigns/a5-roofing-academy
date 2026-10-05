import type { Redis } from 'ioredis';
import type { RedisNamespace } from './redis.js';

/**
 * JSON cache with TTLs, per-process single-flight loading and namespace versioning.
 * `bump(namespace)` invalidates every key built with `versioned(namespace, ...)` without SCAN.
 */
export class Cache {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly redis: Redis,
    private readonly ns: RedisNamespace,
  ) {}

  key(...parts: Array<string | number>): string {
    return this.ns.key('cache', ...parts);
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.redis.del(...keys);
  }

  async getOrSet<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const promise = (async () => {
      try {
        const value = await loader();
        if (value !== undefined && value !== null) await this.set(key, value, ttlSeconds);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  /** Current version of a namespace (starts at 0). */
  async version(namespace: string): Promise<number> {
    const raw = await this.redis.get(this.ns.key('cachever', namespace));
    return raw ? Number(raw) : 0;
  }

  async bump(namespace: string): Promise<number> {
    return this.redis.incr(this.ns.key('cachever', namespace));
  }

  /** Key that becomes unreachable (and expires) once the namespace is bumped. */
  async versioned(namespace: string, ...parts: Array<string | number>): Promise<string> {
    return this.key(namespace, `v${await this.version(namespace)}`, ...parts);
  }
}
