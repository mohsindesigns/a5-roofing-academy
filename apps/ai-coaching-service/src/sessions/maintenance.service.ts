import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { sql } from '@a5/database';
import { DistributedLock } from '@a5/messaging';
import { InjectDb, LOGGER, runsWorkers } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { AI_CONFIG, type AiConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { EvaluationService } from '../evaluation/evaluation.service.js';
import { ConversationEngine } from './conversation.engine.js';
import { SessionLifecycle } from './lifecycle.js';

const BATCH = 100;

/**
 * Worker-side housekeeping, run by one replica at a time:
 * - idle active sessions end with reason `timeout` (scored when the rep said anything);
 * - ended sessions whose evaluation job was lost (e.g. Redis was down at enqueue) are re-queued;
 * - transcripts older than the organization's retention period are deleted (scores are kept).
 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly lock: DistributedLock,
    private readonly lifecycle: SessionLifecycle,
    private readonly evaluation: EvaluationService,
    @Inject(AI_CONFIG) private readonly config: AiConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap() {
    if (!runsWorkers(this.config)) return;
    this.timer = setInterval(() => void this.tick(), this.config.ai.sweepIntervalMs);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const lock = await this.lock.acquire('ai:maintenance', Math.max(30_000, this.config.ai.sweepIntervalMs));
      if (!lock) return;
      try {
        await this.sweep();
      } finally {
        await lock.release();
      }
    } catch (err) {
      this.logger.error({ err }, 'AI maintenance sweep failed');
    } finally {
      this.running = false;
    }
  }

  async sweep(now: Date = new Date()): Promise<{ timedOut: number; requeued: number; purged: number }> {
    return { timedOut: await this.endIdleSessions(now), requeued: await this.requeueLostEvaluations(now), purged: await this.purgeTranscripts(now) };
  }

  async endIdleSessions(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.config.ai.idleTimeoutMinutes * 60_000);
    const idle = await this.db.selectFrom('ai_sessions').select('id').where('status', '=', 'active').where('last_activity_at', '<', cutoff).limit(BATCH).execute();
    let ended = 0;
    for (const { id } of idle) {
      const turnLock = await this.lock.acquire(ConversationEngine.lockName(id), 15_000);
      if (!turnLock) continue;
      try {
        const status = await this.db.transaction().execute(async (trx) => {
          const s = await trx.selectFrom('ai_sessions').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
          if (s.status !== 'active' || s.last_activity_at >= cutoff) return null;
          return this.lifecycle.end(trx, s, 'timeout', now);
        });
        if (status) {
          ended++;
          await this.lifecycle.afterCommit(id, status);
        }
      } finally {
        await turnLock.release();
      }
    }
    return ended;
  }

  async requeueLostEvaluations(now: Date): Promise<number> {
    const rows = await this.db
      .selectFrom('ai_sessions')
      .select('id')
      .where('status', '=', 'ended')
      .where('ended_at', '<', new Date(now.getTime() - 2 * 60_000))
      .limit(BATCH)
      .execute();
    for (const { id } of rows) await this.evaluation.enqueue(id);
    return rows.length;
  }

  async purgeTranscripts(now: Date): Promise<number> {
    const policies = await this.db
      .selectFrom('ai_settings')
      .select(['organization_id', 'transcript_retention_days'])
      .where('transcript_retention_days', 'is not', null)
      .execute();
    let purged = 0;
    for (const policy of policies) {
      const cutoff = new Date(now.getTime() - policy.transcript_retention_days! * 86_400_000);
      const sessions = await this.db
        .selectFrom('ai_sessions')
        .select('id')
        .where('organization_id', '=', policy.organization_id)
        .where('transcript_purged_at', 'is', null)
        .where('status', 'in', ['evaluated', 'abandoned', 'evaluation_failed'])
        .where('ended_at', '<', cutoff)
        .limit(BATCH)
        .execute();
      if (!sessions.length) continue;
      const ids = sessions.map((s) => s.id);
      await this.db.transaction().execute(async (trx) => {
        await trx.deleteFrom('ai_messages').where('session_id', 'in', ids).execute();
        await trx.updateTable('ai_sessions').set({ transcript_purged_at: sql<Date>`now()` }).where('id', 'in', ids).execute();
      });
      purged += ids.length;
      this.logger.info({ organizationId: policy.organization_id, sessions: ids.length }, 'purged AI transcripts past retention');
    }
    return purged;
  }
}
