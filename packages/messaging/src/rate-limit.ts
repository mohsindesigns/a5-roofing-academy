import type { Redis } from 'ioredis';
import type { RedisNamespace } from './redis.js';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  resetSeconds: number;
}

/** Fixed-window counter. Cheap, shared across replicas, good enough for abuse protection. */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly ns: RedisNamespace,
  ) {}

  async hit(bucket: string, subject: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const window = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = this.ns.key('rl', bucket, subject, window);
    const results = await this.redis.multi().incr(key).expire(key, windowSeconds, 'NX').ttl(key).exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const ttl = Number(results?.[2]?.[1] ?? windowSeconds);
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  }

  async reset(bucket: string, subject: string, windowSeconds: number): Promise<void> {
    const window = Math.floor(Date.now() / 1000 / windowSeconds);
    await this.redis.del(this.ns.key('rl', bucket, subject, window));
  }
}
