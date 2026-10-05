import { Inject, Injectable } from '@nestjs/common';
import { mediaEvents } from '@a5/events';
import { EventBus, InjectDb, LOGGER } from '@a5/nest-kit';
import { uuidv7, type Logger } from '@a5/observability';
import type { Db } from '../database/index.js';
import { mergeIntervals, percentOf, reachedMilestones, totalLength } from './intervals.js';
import { WatchBuffer, type WatchState } from './watch-buffer.js';

export interface PersistedProgress {
  milestones: number[];
  completedAt: number | null;
  watchedSeconds: number;
  percent: number;
}

/**
 * Writes buffered watch progress to `video_progress` and emits `video.started`,
 * `video.progressed` (per newly crossed 5 % boundary) and `video.completed`. The row lock plus the
 * persisted `milestones_emitted` / `completed_at` make every event exactly-once, no matter how many
 * API instances or flush jobs process the same learner concurrently.
 */
@Injectable()
export class ProgressStore {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly buffer: WatchBuffer,
    private readonly events: EventBus,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Persist one buffered key. The dirty flag is cleared before reading, so a heartbeat arriving
   * during the flush marks it dirty again; on failure the key is put back for the next run.
   */
  async flushKey(key: string, { alreadyPopped = false }: { alreadyPopped?: boolean } = {}): Promise<PersistedProgress | null> {
    if (!alreadyPopped) await this.buffer.removeDirty(key);
    const state = await this.buffer.load(key);
    if (!state) return null;
    try {
      const persisted = await this.persist(state);
      await this.buffer.markPersisted(key, persisted);
      return persisted;
    } catch (err) {
      await this.buffer.addDirty(key).catch((e: unknown) => this.logger.error({ err: e, key }, 'could not re-mark watch progress as dirty'));
      throw err;
    }
  }

  async persist(state: WatchState): Promise<PersistedProgress> {
    return this.db.transaction().execute(async (trx) => {
      const now = new Date();
      const match = {
        user_id: state.userId,
        asset_id: state.assetId,
        context_type: state.contextType,
        context_id: state.contextId,
      };
      const inserted = await trx
        .insertInto('video_progress')
        .values({
          id: uuidv7(),
          organization_id: state.organizationId,
          ...match,
          watched_seconds: 0,
          duration_seconds: state.durationSeconds,
          percent: 0,
          last_position_seconds: 0,
          intervals: JSON.stringify([]) as never,
          started_at: new Date(state.startedAt),
          completed_at: null,
          milestones_emitted: [],
        })
        .onConflict((oc) => oc.columns(['user_id', 'asset_id', 'context_type', 'context_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      const row = await trx
        .selectFrom('video_progress')
        .selectAll()
        .where('user_id', '=', match.user_id)
        .where('asset_id', '=', match.asset_id)
        .where('context_type', '=', match.context_type)
        .where('context_id', '=', match.context_id)
        .forUpdate()
        .executeTakeFirstOrThrow();

      const intervals = mergeIntervals([...row.intervals, ...state.intervals]);
      const watchedSeconds = Math.min(totalLength(intervals), state.durationSeconds);
      const percent = percentOf(watchedSeconds, state.durationSeconds);
      const emitted = new Set(row.milestones_emitted);
      const fresh = reachedMilestones(percent).filter((m) => !emitted.has(m));
      const milestones = [...emitted, ...fresh].sort((a, b) => a - b);
      const completedNow = row.completed_at === null && percent >= state.completionPercent;
      const completedAt = row.completed_at ?? (completedNow ? now : null);

      await trx
        .updateTable('video_progress')
        .set({
          intervals: JSON.stringify(intervals) as never,
          watched_seconds: watchedSeconds,
          duration_seconds: state.durationSeconds,
          percent,
          last_position_seconds: Math.min(state.lastPositionSeconds, state.durationSeconds),
          milestones_emitted: milestones,
          completed_at: completedAt,
          updated_at: now,
        })
        .where('id', '=', row.id)
        .execute();

      const ref = { assetId: state.assetId, userId: state.userId, contextType: state.contextType, contextId: state.contextId };
      const watch = { ...ref, watchedPercent: percent, watchedSeconds, durationSeconds: state.durationSeconds };
      const options = {
        organizationId: state.organizationId,
        subject: { type: 'video_progress', id: row.id },
        actor: { type: 'user' as const, id: state.userId },
      };
      if (inserted) await this.events.emit(trx, mediaEvents.videoStarted, ref, options);
      if (fresh.length) await this.events.emit(trx, mediaEvents.videoProgressed, watch, options);
      if (completedNow) await this.events.emit(trx, mediaEvents.videoCompleted, watch, options);
      return { milestones, completedAt: completedAt?.getTime() ?? null, watchedSeconds, percent };
    });
  }
}
