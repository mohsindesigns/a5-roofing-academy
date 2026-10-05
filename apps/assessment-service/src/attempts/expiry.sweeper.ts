import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { QueueFactory } from '@a5/messaging';
import { InjectDb, LOGGER, runsWorkers } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { Clock } from '../common/clock.js';
import { ASSESSMENT_CONFIG, type AssessmentConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { AttemptLifecycle } from './attempt-lifecycle.js';

export const EXPIRY_QUEUE = 'assessment.expiry';
const SCHEDULER_ID = 'attempt-expiry-sweep';
const BATCH = 200;
/** Closed attempts still ungraded after this long were interrupted mid-submission. */
const STUCK_AFTER_MS = 60_000;

/**
 * Server-side time limits: a repeatable BullMQ job auto-submits attempts whose deadline (plus
 * grace) has passed, with the answers saved so far, and finishes grading any attempt whose
 * submission was interrupted. Learner requests enforce the same rule on access.
 */
@Injectable()
export class ExpirySweeper implements OnModuleInit {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly lifecycle: AttemptLifecycle,
    private readonly queues: QueueFactory,
    @Inject(ASSESSMENT_CONFIG) private readonly config: AssessmentConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly clock: Clock,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!runsWorkers(this.config)) return;
    this.startWorker();
    await this.schedule();
  }

  startWorker(): void {
    this.queues.worker(EXPIRY_QUEUE, async () => this.sweep(), { concurrency: 1 });
  }

  async schedule(): Promise<void> {
    await this.queues
      .queue(EXPIRY_QUEUE, { attempts: 3, removeOnComplete: { count: 100 }, removeOnFail: { count: 500 } })
      .upsertJobScheduler(SCHEDULER_ID, { every: this.config.attempts.expirySweepSeconds * 1000 }, { name: 'sweep', data: {} });
  }

  /** Enqueue a one-off sweep (operations and tests). */
  async enqueueSweep(jobId: string): Promise<void> {
    await this.queues.add(EXPIRY_QUEUE, 'sweep', {}, { jobId });
  }

  async sweep(now: Date = this.clock.now()): Promise<{ expired: number; graded: number }> {
    const deadline = new Date(now.getTime() - this.config.attempts.deadlineGraceMs);
    const overdue = await this.db
      .selectFrom('attempts')
      .select('id')
      .where('status', '=', 'in_progress')
      .where('expires_at', '<', deadline)
      .orderBy('expires_at')
      .limit(BATCH)
      .execute();
    let expired = 0;
    for (const { id } of overdue) {
      try {
        const result = await this.lifecycle.expire(id, now, { skipLocked: true });
        if (result && result.status !== 'in_progress') expired++;
      } catch (err) {
        this.logger.error({ err, attemptId: id }, 'failed to auto-submit an expired attempt');
      }
    }

    const stuck = await this.db
      .selectFrom('attempts')
      .select('id')
      .where('status', 'in', ['submitted', 'expired'])
      .where('submitted_at', '<', new Date(now.getTime() - STUCK_AFTER_MS))
      .orderBy('submitted_at')
      .limit(BATCH)
      .execute();
    let graded = 0;
    for (const { id } of stuck) {
      try {
        const result = await this.lifecycle.gradeClosed(id, now, { skipLocked: true });
        if (result && result.status !== 'submitted' && result.status !== 'expired') graded++;
      } catch (err) {
        this.logger.error({ err, attemptId: id }, 'failed to grade a closed attempt');
      }
    }
    if (expired || graded) this.logger.info({ expired, graded }, 'attempt expiry sweep completed');
    return { expired, graded };
  }
}
