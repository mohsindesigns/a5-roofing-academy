import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { media } from '@a5/contracts';
import { DistributedLock } from '@a5/messaging';
import { AppError, ForbiddenError, InjectDb, LOGGER, UnauthenticatedError } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { CLOCK, type Clock } from '../common/tokens.js';
import { MEDIA_CONFIG, type MediaConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { MediaTokenError, MediaTokens, type PlaybackTokenClaims } from '../playback/media-tokens.js';
import { mergeIntervals, percentOf, plausibleIntervals, reachedMilestones, totalLength } from './intervals.js';
import { ProgressStore } from './progress-store.js';
import { WatchBuffer, type WatchState } from './watch-buffer.js';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Resume from the start when the learner stopped within the last seconds of the video. */
const RESTART_WITHIN_SECONDS = 2;

@Injectable()
export class TelemetryService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(MEDIA_CONFIG) private readonly config: MediaConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly tokens: MediaTokens,
    private readonly buffer: WatchBuffer,
    private readonly store: ProgressStore,
    private readonly locks: DistributedLock,
  ) {}

  private verify(token: string): PlaybackTokenClaims {
    try {
      return this.tokens.verify(token, 'play');
    } catch (err) {
      if (err instanceof MediaTokenError && err.reason === 'expired') {
        throw new UnauthenticatedError('PLAYBACK_EXPIRED', 'This playback session expired. Reload the lesson to keep saving your progress.');
      }
      throw new UnauthenticatedError('PLAYBACK_TOKEN_INVALID', 'This playback session is not valid. Reload the lesson to keep saving your progress.');
    }
  }

  /**
   * Credit plausibly watched time from a heartbeat or beacon. Only Redis is written here; the
   * state reaches PostgreSQL through the flush job, or immediately when a milestone is crossed.
   */
  async heartbeat(input: media.HeartbeatRequest, caller: Principal | null): Promise<media.HeartbeatResponse> {
    const claims = this.verify(input.playbackToken);
    if (caller && (caller.userId !== claims.sub || caller.organizationId !== claims.org)) {
      throw new ForbiddenError('This playback session belongs to another account.');
    }
    const key = this.buffer.key(claims.sub, claims.aid, claims.ct, claims.ci);
    const lock = await this.locks.acquire(`med:wp:${claims.sub}:${claims.aid}:${claims.ct}:${claims.ci}`, 10_000, { waitMs: 5_000 });
    if (!lock) {
      throw new AppError(409, 'HEARTBEAT_BUSY', 'Progress is being saved from another window. It will be sent again with the next update.');
    }

    let result: { next: WatchState; previousWatched: number; needsFlush: boolean; dropped: number; truncated: number };
    try {
      const now = this.clock.now();
      const state = (await this.buffer.load(key)) ?? (await this.hydrate(claims, now));
      const duration = claims.dur;
      const policy = claims.pol;
      // Budget: wall-clock time since the previous accepted report, or since this session began.
      const reference = Math.max(state.lastReportAt ?? 0, claims.iat * 1000);
      const credit = plausibleIntervals({
        intervals: input.intervals,
        durationSeconds: duration,
        maxRate: policy.maxCreditedPlaybackRate,
        elapsedSeconds: (now - reference) / 1000,
        toleranceSeconds: this.config.media.telemetryToleranceSeconds,
      });
      const intervals = mergeIntervals([...state.intervals, ...credit.accepted]);
      const watchedSeconds = Math.min(totalLength(intervals), duration);
      const percent = percentOf(watchedSeconds, duration);
      const next: WatchState = {
        ...state,
        durationSeconds: duration,
        completionPercent: policy.completionPercent,
        intervals,
        watchedSeconds,
        lastPositionSeconds: input.ended ? duration : Math.min(Math.max(input.positionSeconds, 0), duration),
        lastReportAt: now,
      };
      const known = new Set(state.milestones);
      const needsFlush =
        !state.persisted ||
        reachedMilestones(percent).some((m) => !known.has(m)) ||
        (state.completedAt === null && percent >= policy.completionPercent);
      await this.buffer.save(key, next);
      result = { next, previousWatched: state.watchedSeconds, needsFlush, dropped: credit.droppedForRate, truncated: credit.truncated };
    } finally {
      await lock.release();
    }

    const { next } = result;
    let completedAt = next.completedAt;
    if (result.needsFlush) {
      try {
        completedAt = (await this.store.flushKey(key))?.completedAt ?? completedAt;
      } catch (err) {
        // Still buffered and dirty: the periodic flush retries.
        this.logger.error({ err, assetId: claims.aid }, 'immediate watch progress flush failed');
      }
    }
    if (result.dropped > 0 || result.truncated > 0) {
      this.logger.info(
        { assetId: claims.aid, userId: claims.sub, droppedForRate: result.dropped, truncated: result.truncated },
        'watch telemetry: implausible viewing was not credited',
      );
    }
    const percent = percentOf(next.watchedSeconds, next.durationSeconds);
    return {
      watchedSeconds: next.watchedSeconds,
      watchedPercent: percent,
      creditedSeconds: round3(Math.max(0, next.watchedSeconds - result.previousWatched)),
      completed: completedAt !== null || percent >= next.completionPercent,
      nextHeartbeatSeconds: this.config.media.heartbeatIntervalSeconds,
    };
  }

  /** Start from what PostgreSQL holds (first heartbeat, or after the buffer expired). */
  private async hydrate(claims: PlaybackTokenClaims, now: number): Promise<WatchState> {
    const row = await this.progressRow(claims.sub, claims.aid, claims.ct, claims.ci);
    return {
      userId: claims.sub,
      assetId: claims.aid,
      organizationId: claims.org,
      contextType: claims.ct,
      contextId: claims.ci,
      durationSeconds: claims.dur,
      completionPercent: claims.pol.completionPercent,
      intervals: row?.intervals ?? [],
      watchedSeconds: row?.watched_seconds ?? 0,
      lastPositionSeconds: row?.last_position_seconds ?? 0,
      lastReportAt: null,
      startedAt: row?.started_at.getTime() ?? now,
      completedAt: row?.completed_at?.getTime() ?? null,
      milestones: row?.milestones_emitted ?? [],
      persisted: Boolean(row),
    };
  }

  private progressRow(userId: string, assetId: string, contextType: string, contextId: string) {
    return this.db
      .selectFrom('video_progress')
      .selectAll()
      .where('user_id', '=', userId)
      .where('asset_id', '=', assetId)
      .where('context_type', '=', contextType)
      .where('context_id', '=', contextId)
      .executeTakeFirst();
  }

  /** Saved progress for the player (buffer first, then PostgreSQL). */
  async resume(userId: string, assetId: string, contextType: string, contextId: string, completionPercent: number): Promise<media.PlaybackResume> {
    const buffered = await this.buffer.load(this.buffer.key(userId, assetId, contextType, contextId));
    const source = buffered
      ? { watched: buffered.watchedSeconds, duration: buffered.durationSeconds, position: buffered.lastPositionSeconds, completed: buffered.completedAt !== null }
      : await this.progressRow(userId, assetId, contextType, contextId).then((r) =>
          r ? { watched: r.watched_seconds, duration: r.duration_seconds, position: r.last_position_seconds, completed: r.completed_at !== null } : null,
        );
    if (!source) return { positionSeconds: 0, watchedPercent: 0, completed: false };
    const percent = percentOf(source.watched, source.duration);
    return {
      positionSeconds: source.position >= source.duration - RESTART_WITHIN_SECONDS ? 0 : source.position,
      watchedPercent: percent,
      completed: source.completed || percent >= completionPercent,
    };
  }
}
