import { Inject, Injectable } from '@nestjs/common';
import { InjectDb } from '@a5/nest-kit';
import { Clock } from '../common/clock.js';
import { withIntegrityErrors } from '../common/db-errors.js';
import { ASSESSMENT_CONFIG, type AssessmentConfig } from '../config.js';
import type { AttemptRow, Db } from '../database/index.js';
import { AttemptEngine } from '../engine/attempt-engine.js';

/**
 * Transactional wrappers around the attempt engine for closing and grading attempts. Used by the
 * learner endpoints (submit, access after the deadline) and the expiry sweeper.
 */
@Injectable()
export class AttemptLifecycle {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly engine: AttemptEngine,
    @Inject(ASSESSMENT_CONFIG) private readonly config: AssessmentConfig,
    private readonly clock: Clock,
  ) {}

  /** The deadline (plus network grace) has passed for an open attempt. */
  isOverdue(
    attempt: Pick<AttemptRow, 'status' | 'expires_at'>,
    now: Date = this.clock.now(),
  ): boolean {
    return (
      attempt.status === 'in_progress' &&
      attempt.expires_at !== null &&
      now.getTime() > attempt.expires_at.getTime() + this.config.attempts.deadlineGraceMs
    );
  }

  /** Submit an attempt (idempotent). Past the deadline it is closed as expired at its deadline. */
  async submit(attemptId: string, now: Date = this.clock.now()): Promise<AttemptRow> {
    return withIntegrityErrors(() =>
      this.db.transaction().execute(async (trx) => {
        let attempt = await trx
          .selectFrom('attempts')
          .selectAll()
          .where('id', '=', attemptId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (attempt.status === 'in_progress') {
          attempt = this.isOverdue(attempt, now)
            ? await this.engine.close(trx, attempt, 'time_limit', attempt.expires_at!)
            : await this.engine.close(trx, attempt, 'learner', now);
        }
        if (attempt.status === 'submitted' || attempt.status === 'expired')
          attempt = await this.engine.grade(trx, attempt.id, now);
        return attempt;
      }),
    );
  }

  /**
   * Auto-submit an overdue attempt with its saved answers. No-op when it is not overdue. The sweeper
   * passes `skipLocked` so it never waits behind a learner's request on the same attempt.
   */
  async expire(
    attemptId: string,
    now: Date = this.clock.now(),
    { skipLocked = false }: { skipLocked?: boolean } = {},
  ): Promise<AttemptRow | null> {
    return this.db.transaction().execute(async (trx) => {
      let query = trx.selectFrom('attempts').selectAll().where('id', '=', attemptId).forUpdate();
      if (skipLocked) query = query.skipLocked();
      const attempt = await query.executeTakeFirst();
      if (!attempt || !this.isOverdue(attempt, now)) return attempt ?? null;
      const closed = await this.engine.close(trx, attempt, 'time_limit', attempt.expires_at!);
      return this.engine.grade(trx, closed.id, now);
    });
  }

  /** Grade an attempt that was closed but not graded (recovery after an interrupted submission). */
  async gradeClosed(
    attemptId: string,
    now: Date = this.clock.now(),
    { skipLocked = false }: { skipLocked?: boolean } = {},
  ): Promise<AttemptRow | null> {
    return this.db.transaction().execute(async (trx) => {
      let query = trx.selectFrom('attempts').selectAll().where('id', '=', attemptId).forUpdate();
      if (skipLocked) query = query.skipLocked();
      const attempt = await query.executeTakeFirst();
      if (!attempt) return null;
      if (attempt.status !== 'submitted' && attempt.status !== 'expired') return attempt;
      return this.engine.grade(trx, attempt.id, now);
    });
  }

  /** Close the learner's overdue attempt on an assessment, if any (access-time enforcement). */
  async expireOverdueFor(
    assessmentId: string,
    userId: string,
    now: Date = this.clock.now(),
  ): Promise<void> {
    const open = await this.db
      .selectFrom('attempts')
      .select(['id', 'status', 'expires_at'])
      .where('assessment_id', '=', assessmentId)
      .where('user_id', '=', userId)
      .where('status', '=', 'in_progress')
      .executeTakeFirst();
    if (open && this.isOverdue(open, now)) await this.expire(open.id, now);
  }
}
