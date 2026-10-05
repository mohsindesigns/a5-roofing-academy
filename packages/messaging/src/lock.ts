import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { RedisNamespace } from './redis.js';

const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const EXTEND = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

export class LockNotAcquiredError extends Error {
  constructor(readonly lockName: string) {
    super(`Could not acquire lock "${lockName}"`);
    this.name = 'LockNotAcquiredError';
  }
}

export interface Lock {
  readonly name: string;
  release(): Promise<boolean>;
  extend(ttlMs: number): Promise<boolean>;
}

/**
 * Single-instance Redis lock (SET NX PX + token-checked release). Used to prevent duplicate
 * concurrent work such as issuing the same certificate twice. It is a performance and UX guard;
 * correctness is additionally enforced by database constraints.
 */
export class DistributedLock {
  constructor(
    private readonly redis: Redis,
    private readonly ns: RedisNamespace,
  ) {}

  async acquire(
    name: string,
    ttlMs: number,
    { waitMs = 0, retryDelayMs = 50 }: { waitMs?: number; retryDelayMs?: number } = {},
  ): Promise<Lock | null> {
    const key = this.ns.key('lock', name);
    const token = randomBytes(16).toString('hex');
    const deadline = Date.now() + waitMs;
    for (;;) {
      const ok = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
      if (ok === 'OK') {
        return {
          name,
          release: async () => (await this.redis.eval(RELEASE, 1, key, token)) === 1,
          extend: async (ms: number) => (await this.redis.eval(EXTEND, 1, key, token, ms)) === 1,
        };
      }
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, retryDelayMs + Math.floor(Math.random() * retryDelayMs)));
    }
  }

  async withLock<T>(
    name: string,
    ttlMs: number,
    fn: () => Promise<T>,
    opts: { waitMs?: number } = {},
  ): Promise<T> {
    const lock = await this.acquire(name, ttlMs, opts);
    if (!lock) throw new LockNotAcquiredError(name);
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }
}
