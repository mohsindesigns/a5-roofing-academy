import { Injectable } from '@nestjs/common';
import { RedisNamespace, type Redis } from '@a5/messaging';
import { InjectRedis } from '@a5/nest-kit';
import type { Interval } from './intervals.js';

/** Buffered watch progress of one learner, asset and learning context. */
export interface WatchState {
  userId: string;
  assetId: string;
  organizationId: string;
  contextType: string;
  contextId: string;
  durationSeconds: number;
  completionPercent: number;
  /** Merged credited intervals (includes everything already persisted). */
  intervals: Interval[];
  watchedSeconds: number;
  lastPositionSeconds: number;
  /** Server time (ms) of the last accepted report; null right after loading from PostgreSQL. */
  lastReportAt: number | null;
  startedAt: number;
  completedAt: number | null;
  /** Milestones already persisted (and announced) in PostgreSQL. */
  milestones: number[];
  /** A `video_progress` row exists. */
  persisted: boolean;
}

/** Idle buffers expire; PostgreSQL holds everything flushed, and is re-read on the next heartbeat. */
const BUFFER_TTL_SECONDS = 3 * 24 * 3600;

const MARK_PERSISTED = `
if redis.call('exists', KEYS[1]) == 1 then
  redis.call('hset', KEYS[1], 'p', '1', 'ms', ARGV[1], 'ca', ARGV[2])
  return 1
end
return 0`;

/**
 * Redis write-behind buffer for watch telemetry: one hash per learner/asset/context
 * (`med:wp:{user}:{asset}:{contextType}:{contextId}`) plus a set of keys with unflushed changes
 * (`med:wp:dirty`). Heartbeats only touch Redis; the flush job persists dirty keys to PostgreSQL.
 */
@Injectable()
export class WatchBuffer {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly ns: RedisNamespace,
  ) {}

  key(userId: string, assetId: string, contextType: string, contextId: string): string {
    return this.ns.key('med', 'wp', userId, assetId, contextType, contextId);
  }

  get dirtyKey(): string {
    return this.ns.key('med', 'wp', 'dirty');
  }

  async load(key: string): Promise<WatchState | null> {
    const h = await this.redis.hgetall(key);
    if (!h.u) return null;
    return {
      userId: h.u,
      assetId: h.a!,
      organizationId: h.o!,
      contextType: h.ct!,
      contextId: h.ci!,
      durationSeconds: Number(h.d),
      completionPercent: Number(h.cp),
      intervals: JSON.parse(h.iv ?? '[]') as Interval[],
      watchedSeconds: Number(h.ws ?? 0),
      lastPositionSeconds: Number(h.pos ?? 0),
      lastReportAt: h.la ? Number(h.la) : null,
      startedAt: Number(h.sa),
      completedAt: h.ca ? Number(h.ca) : null,
      milestones: JSON.parse(h.ms ?? '[]') as number[],
      persisted: h.p === '1',
    };
  }

  /** Store the new state and mark it dirty, atomically. */
  async save(key: string, s: WatchState): Promise<void> {
    await this.redis
      .multi()
      .hset(key, {
        u: s.userId,
        a: s.assetId,
        o: s.organizationId,
        ct: s.contextType,
        ci: s.contextId,
        d: String(s.durationSeconds),
        cp: String(s.completionPercent),
        iv: JSON.stringify(s.intervals),
        ws: String(s.watchedSeconds),
        pos: String(s.lastPositionSeconds),
        la: s.lastReportAt === null ? '' : String(s.lastReportAt),
        sa: String(s.startedAt),
        ca: s.completedAt === null ? '' : String(s.completedAt),
        ms: JSON.stringify(s.milestones),
        p: s.persisted ? '1' : '0',
      })
      .expire(key, BUFFER_TTL_SECONDS)
      .sadd(this.dirtyKey, key)
      .exec();
  }

  /** Record what PostgreSQL now holds (no-op if the buffer expired meanwhile). */
  async markPersisted(key: string, persisted: { milestones: number[]; completedAt: number | null }): Promise<void> {
    await this.redis.eval(MARK_PERSISTED, 1, key, JSON.stringify(persisted.milestones), persisted.completedAt === null ? '' : String(persisted.completedAt));
  }

  async popDirty(count: number): Promise<string[]> {
    return (await this.redis.spop(this.dirtyKey, count)) ?? [];
  }

  async removeDirty(key: string): Promise<void> {
    await this.redis.srem(this.dirtyKey, key);
  }

  async addDirty(key: string): Promise<void> {
    await this.redis.sadd(this.dirtyKey, key);
  }

  async dirtyCount(): Promise<number> {
    return this.redis.scard(this.dirtyKey);
  }
}
