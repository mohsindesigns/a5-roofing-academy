import { Inject, Injectable } from '@nestjs/common';
import { TokenError, verifyLessonGrant, type Principal } from '@a5/auth';
import type { assessment } from '@a5/contracts';
import { sql } from '@a5/database';
import {
  AppError,
  ConflictError,
  InjectDb,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '@a5/nest-kit';
import type { z } from 'zod';
import { Clock } from '../common/clock.js';
import { withIntegrityErrors } from '../common/db-errors.js';
import { effectiveScore, latestOverrides } from '../common/effective-score.js';
import { ASSESSMENT_CONFIG, type AssessmentConfig } from '../config.js';
import type { AssessmentRow, AttemptRow, Db, DbOrTrx } from '../database/index.js';
import { AttemptEngine } from '../engine/attempt-engine.js';
import { DrawError, drawQuestions } from '../engine/draw.js';
import { answersRevealed, kindNoun, waitPhrase } from '../engine/policy.js';
import {
  correctAnswer,
  isAnswered,
  learnerQuestion,
  outcomeOf,
  toDefinition,
  validateResponse,
} from '../engine/question-types.js';
import { randomRng } from '../engine/random.js';
import { AttemptLifecycle } from './attempt-lifecycle.js';

interface Target {
  assessment: AssessmentRow;
  context: assessment.AttemptContext;
}

class GrantError extends AppError {
  constructor(code: string, message: string) {
    super(403, code, message);
  }
}

/** Learner-facing attempt flows: intro, start/resume, autosave, submit and result. */
@Injectable()
export class AttemptsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly engine: AttemptEngine,
    private readonly lifecycle: AttemptLifecycle,
    @Inject(ASSESSMENT_CONFIG) private readonly config: AssessmentConfig,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------- access

  /**
   * Resolve what the learner is allowed to take. A lesson grant (issued by learning-service when the
   * lesson is unlocked) must be for an assessment, for this learner and organization; it supplies
   * the learning context. Without a grant the assessment must allow standalone attempts.
   */
  private async target(
    p: Principal,
    input: { grant?: string; assessmentId?: string },
    expectedAssessmentId?: string,
  ): Promise<Target> {
    let assessmentId = input.assessmentId ?? expectedAssessmentId;
    let context: assessment.AttemptContext = {};
    if (input.grant) {
      let grant;
      try {
        grant = await verifyLessonGrant(input.grant, this.config.grantSecret);
      } catch (err) {
        if (err instanceof TokenError && err.code === 'expired') {
          throw new GrantError(
            'GRANT_EXPIRED',
            'This lesson link has expired. Reopen the lesson from your training plan and try again.',
          );
        }
        throw new GrantError(
          'GRANT_INVALID',
          'This lesson link is not valid. Reopen the lesson from your training plan.',
        );
      }
      if (grant.resource.type !== 'assessment') {
        throw new GrantError(
          'GRANT_MISMATCH',
          'This lesson link does not open an assessment. Reopen the lesson from your training plan.',
        );
      }
      if (grant.userId !== p.userId || grant.organizationId !== p.organizationId) {
        throw new GrantError(
          'GRANT_MISMATCH',
          'This lesson link was issued to a different learner. Open the lesson from your own training plan.',
        );
      }
      if (expectedAssessmentId && grant.resource.id !== expectedAssessmentId) {
        throw new GrantError(
          'GRANT_MISMATCH',
          'This lesson link is for a different assessment. Reopen the lesson from your training plan.',
        );
      }
      assessmentId = grant.resource.id;
      context = {
        programId: grant.programId,
        enrollmentId: grant.enrollmentId,
        lessonId: grant.lessonId,
      };
    }
    const a = await this.db
      .selectFrom('assessments')
      .selectAll()
      .where('id', '=', assessmentId!)
      .where('organization_id', '=', p.organizationId)
      .executeTakeFirst();
    if (!a || a.status === 'draft') throw new NotFoundError('Assessment');
    if (!input.grant && !a.config.allowStandalone) {
      throw new AppError(
        403,
        'STANDALONE_NOT_ALLOWED',
        `This ${kindNoun(a.kind)} can only be taken from its lesson in your training program. Open it from your training plan.`,
      );
    }
    return { assessment: a, context };
  }

  private async ownAttempt(p: Principal, id: string): Promise<AttemptRow> {
    const attempt = await this.db
      .selectFrom('attempts')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', p.userId)
      .where('organization_id', '=', p.organizationId)
      .executeTakeFirst();
    if (!attempt) throw new NotFoundError('Attempt');
    return attempt;
  }

  /** Access-time enforcement of the time limit: an overdue attempt is auto-submitted first. */
  private async current(p: Principal, id: string): Promise<AttemptRow> {
    const attempt = await this.ownAttempt(p, id);
    if (this.lifecycle.isOverdue(attempt)) {
      await this.lifecycle.expire(attempt.id);
      return this.ownAttempt(p, id);
    }
    if (attempt.status === 'submitted' || attempt.status === 'expired') {
      await this.lifecycle.gradeClosed(attempt.id);
      return this.ownAttempt(p, id);
    }
    return attempt;
  }

  private attemptsOf(db: DbOrTrx, assessmentId: string, userId: string) {
    return db
      .selectFrom('attempts')
      .selectAll()
      .where('assessment_id', '=', assessmentId)
      .where('user_id', '=', userId)
      .orderBy('attempt_number', 'desc')
      .execute();
  }

  private async summaries(
    attempts: readonly AttemptRow[],
  ): Promise<assessment.LearnerAttemptSummary[]> {
    const overrides = await latestOverrides(
      this.db,
      attempts.map((a) => a.id),
    );
    return attempts.map((a) => {
      const score = effectiveScore(a, overrides.get(a.id));
      return {
        id: a.id,
        assessmentId: a.assessment_id,
        title: a.config.title,
        kind: a.config.kind,
        attemptNumber: a.attempt_number,
        status: a.status,
        startedAt: a.started_at.toISOString(),
        submittedAt: a.submitted_at?.toISOString() ?? null,
        gradedAt: a.graded_at?.toISOString() ?? null,
        autoSubmitted: a.auto_submitted,
        scorePercent: a.config.revealScore ? score.scorePercent : null,
        passed: score.passed,
      };
    });
  }

  private cooldownUntil(a: AssessmentRow, attempts: readonly AttemptRow[], now: Date): Date | null {
    const last = attempts.find((t) => t.submitted_at !== null);
    if (!last || a.config.retryCooldownMinutes <= 0) return null;
    const until = new Date(last.submitted_at!.getTime() + a.config.retryCooldownMinutes * 60_000);
    return until > now ? until : null;
  }

  private async questionCount(assessmentId: string): Promise<number> {
    const row = await this.db
      .selectFrom('assessment_items')
      .select(
        sql<number>`coalesce(sum(case when kind = 'question' then 1 else pool_count end), 0)`.as(
          'n',
        ),
      )
      .where('assessment_id', '=', assessmentId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  // ---------------------------------------------------------------- intro

  async intro(
    p: Principal,
    assessmentId: string,
    grant?: string,
  ): Promise<assessment.AssessmentIntro> {
    const { assessment: a } = await this.target(p, { grant }, assessmentId);
    await this.lifecycle.expireOverdueFor(a.id, p.userId);
    const now = this.clock.now();
    const attempts = await this.attemptsOf(this.db, a.id, p.userId);
    const summaries = await this.summaries(attempts);
    const open = attempts.find((t) => t.status === 'in_progress') ?? null;
    const used = attempts.length;
    const remaining =
      a.config.maxAttempts === null ? null : Math.max(0, a.config.maxAttempts - used);
    const cooldown = this.cooldownUntil(a, attempts, now);
    const noun = kindNoun(a.kind);

    let blockedReason: { code: string; message: string } | null = null;
    if (!open) {
      if (a.status !== 'published') {
        blockedReason = {
          code: 'ASSESSMENT_NOT_AVAILABLE',
          message: `This ${noun} is not open for attempts right now. Contact your trainer if you expected it to be available.`,
        };
      } else if (remaining === 0) {
        blockedReason = {
          code: 'ATTEMPTS_EXHAUSTED',
          message: `You have used all ${a.config.maxAttempts} attempts for this ${noun}. Ask your trainer if you need another attempt.`,
        };
      } else if (cooldown) {
        blockedReason = {
          code: 'COOLDOWN_ACTIVE',
          message: `You can start another attempt in ${waitPhrase(cooldown, now)}.`,
        };
      }
    }
    const visibleScores = summaries
      .map((s) => s.scorePercent)
      .filter((s): s is number => s !== null);
    return {
      assessment: {
        id: a.id,
        title: a.title,
        description: a.description,
        kind: a.kind,
        questionCount: await this.questionCount(a.id),
        passingPercent: a.config.passingPercent,
        timeLimitSeconds: a.config.timeLimitSeconds,
        maxAttempts: a.config.maxAttempts,
        revealScore: a.config.revealScore,
        revealCorrectAnswers: a.config.revealCorrectAnswers,
      },
      attemptsUsed: used,
      attemptsRemaining: remaining,
      inProgressAttempt: open
        ? {
            id: open.id,
            attemptNumber: open.attempt_number,
            startedAt: open.started_at.toISOString(),
            expiresAt: open.expires_at?.toISOString() ?? null,
          }
        : null,
      cooldownUntil: cooldown?.toISOString() ?? null,
      bestScorePercent: visibleScores.length ? Math.max(...visibleScores) : null,
      passed: summaries.some((s) => s.passed === true),
      canStart: blockedReason === null,
      blockedReason,
      attempts: summaries,
    };
  }

  // ---------------------------------------------------------------- start / resume

  async start(
    p: Principal,
    input: { grant?: string; assessmentId?: string },
  ): Promise<{ attempt: assessment.LearnerAttempt; created: boolean }> {
    const { assessment: a, context } = await this.target(p, input);
    const noun = kindNoun(a.kind);
    if (a.status !== 'published') {
      throw new PreconditionError(
        'ASSESSMENT_NOT_AVAILABLE',
        `This ${noun} is not open for attempts right now. Contact your trainer if you expected it to be available.`,
      );
    }
    await this.lifecycle.expireOverdueFor(a.id, p.userId);
    const now = this.clock.now();
    const outcome = await this.db.transaction().execute(async (trx) => {
      // Serialise starts per learner and assessment; the partial unique index backs this up.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`attempt-start:${a.id}:${p.userId}`}, 0))`.execute(
        trx,
      );
      const previous = await this.attemptsOf(trx, a.id, p.userId);
      const open = previous.find((t) => t.status === 'in_progress');
      if (open) return { attempt: open, created: false };

      if (a.config.maxAttempts !== null && previous.length >= a.config.maxAttempts) {
        throw new PreconditionError(
          'ATTEMPTS_EXHAUSTED',
          `You have used all ${a.config.maxAttempts} attempts for this ${noun}. Ask your trainer if you need another attempt.`,
          { attemptsUsed: previous.length, maxAttempts: a.config.maxAttempts },
        );
      }
      const cooldown = this.cooldownUntil(a, previous, now);
      if (cooldown) {
        throw new PreconditionError(
          'COOLDOWN_ACTIVE',
          `You can start another attempt in ${waitPhrase(cooldown, now)}.`,
          { availableAt: cooldown.toISOString() },
        );
      }
      const items = await trx
        .selectFrom('assessment_items')
        .selectAll()
        .where('assessment_id', '=', a.id)
        .execute();
      let drawn;
      try {
        drawn = await drawQuestions(trx, a.organization_id, items, a.config, randomRng());
      } catch (err) {
        if (err instanceof DrawError) {
          throw new PreconditionError(
            'ASSESSMENT_NOT_AVAILABLE',
            `This ${noun} cannot be started right now because its questions are being updated. Contact your training administrator.`,
          );
        }
        throw err;
      }
      const attempt = await this.engine.create(trx, {
        assessment: a,
        userId: p.userId,
        attemptNumber: (previous[0]?.attempt_number ?? 0) + 1,
        context,
        drawn,
        startedAt: now,
      });
      return { attempt, created: true };
    });
    return {
      attempt: await this.view(outcome.attempt, !outcome.created),
      created: outcome.created,
    };
  }

  // ---------------------------------------------------------------- attempt view

  private async questionRows(db: DbOrTrx, attemptId: string) {
    return db
      .selectFrom('attempt_questions as aq')
      .innerJoin('question_versions as v', 'v.id', 'aq.question_version_id')
      .innerJoin('attempt_answers as aa', 'aa.attempt_question_id', 'aq.id')
      .select([
        'aq.id',
        'aq.position',
        'aq.option_order',
        'aq.points',
        'v.type',
        'v.config',
        'v.prompt',
        'v.explanation',
        'aa.response',
        'aa.saved_at',
        'aa.needs_review',
        'aa.is_correct',
        'aa.awarded_points',
        'aa.feedback',
        'aa.graded_at',
      ])
      .where('aq.attempt_id', '=', attemptId)
      .orderBy('aq.position')
      .execute();
  }

  private async view(
    attempt: AttemptRow,
    resumed: boolean,
    now: Date = this.clock.now(),
  ): Promise<assessment.LearnerAttempt> {
    const rows = await this.questionRows(this.db, attempt.id);
    const open = attempt.status === 'in_progress';
    return {
      id: attempt.id,
      assessmentId: attempt.assessment_id,
      title: attempt.config.title,
      kind: attempt.config.kind,
      attemptNumber: attempt.attempt_number,
      status: attempt.status,
      startedAt: attempt.started_at.toISOString(),
      expiresAt: attempt.expires_at?.toISOString() ?? null,
      timeLimitSeconds: attempt.config.timeLimitSeconds,
      timeRemainingSeconds:
        open && attempt.expires_at
          ? Math.max(0, Math.ceil((attempt.expires_at.getTime() - now.getTime()) / 1000))
          : null,
      submittedAt: attempt.submitted_at?.toISOString() ?? null,
      autoSubmitted: attempt.auto_submitted,
      passingPercent: attempt.config.passingPercent,
      questionCount: rows.length,
      answeredCount: rows.filter((r) => isAnswered(r.response)).length,
      questions: rows.map((r) =>
        learnerQuestion(toDefinition(r), r.option_order, {
          id: r.id,
          position: r.position,
          prompt: r.prompt,
          points: r.points,
          response: r.response,
          savedAt: r.saved_at?.toISOString() ?? null,
        }),
      ),
      resumed,
      context: attempt.context,
    };
  }

  async get(p: Principal, id: string): Promise<assessment.LearnerAttempt> {
    return this.view(await this.current(p, id), false);
  }

  async mine(p: Principal, assessmentId?: string): Promise<assessment.LearnerAttemptSummary[]> {
    let query = this.db
      .selectFrom('attempts')
      .selectAll()
      .where('user_id', '=', p.userId)
      .where('organization_id', '=', p.organizationId);
    if (assessmentId) query = query.where('assessment_id', '=', assessmentId);
    const attempts = await query.orderBy('started_at', 'desc').limit(200).execute();
    for (const a of attempts.filter((t) => this.lifecycle.isOverdue(t)))
      await this.lifecycle.expire(a.id);
    const refreshed = attempts.some((t) => this.lifecycle.isOverdue(t))
      ? await query.orderBy('started_at', 'desc').limit(200).execute()
      : attempts;
    return this.summaries(refreshed);
  }

  // ---------------------------------------------------------------- autosave

  async saveAnswer(
    p: Principal,
    attemptId: string,
    attemptQuestionId: string,
    input: { response: assessment.AnswerResponse | null; clientSequence?: number },
  ): Promise<z.infer<typeof assessment.saveAnswerResultSchema>> {
    const attempt = await this.ownAttempt(p, attemptId);
    const noun = kindNoun(attempt.config.kind);
    if (this.lifecycle.isOverdue(attempt)) {
      await this.lifecycle.expire(attempt.id);
      throw new ConflictError(
        'ATTEMPT_EXPIRED',
        `Time ran out on this ${noun} attempt. Your saved answers were submitted automatically.`,
      );
    }
    if (attempt.status !== 'in_progress')
      throw new ConflictError(
        'ATTEMPT_SUBMITTED',
        `This ${noun} attempt has already been submitted.`,
      );

    return withIntegrityErrors(
      () =>
        this.db.transaction().execute(async (trx) => {
          const now = this.clock.now();
          const locked = await trx
            .selectFrom('attempts')
            .selectAll()
            .where('id', '=', attemptId)
            .forShare()
            .executeTakeFirstOrThrow();
          if (locked.status !== 'in_progress')
            throw new ConflictError(
              'ATTEMPT_SUBMITTED',
              `This ${noun} attempt has already been submitted.`,
            );
          if (this.lifecycle.isOverdue(locked, now)) {
            throw new ConflictError(
              'ATTEMPT_EXPIRED',
              `Time ran out on this ${noun} attempt. Your saved answers were submitted automatically.`,
            );
          }
          const row = await trx
            .selectFrom('attempt_answers as aa')
            .innerJoin('attempt_questions as aq', 'aq.id', 'aa.attempt_question_id')
            .innerJoin('question_versions as v', 'v.id', 'aq.question_version_id')
            .select([
              'aa.id',
              'aa.response',
              'aa.saved_at',
              'aa.client_sequence',
              'v.type',
              'v.config',
            ])
            .where('aa.attempt_id', '=', attemptId)
            .where('aq.id', '=', attemptQuestionId)
            .forUpdate()
            .executeTakeFirst();
          if (!row) throw new NotFoundError('Question');
          if (input.response) {
            const problem = validateResponse(toDefinition(row), input.response);
            if (problem)
              throw new ValidationError([{ path: 'response', message: problem }], problem);
          }
          const stale =
            input.clientSequence !== undefined &&
            row.client_sequence !== null &&
            input.clientSequence <= row.client_sequence;
          let savedAt = row.saved_at;
          let response = row.response;
          if (!stale) {
            savedAt = now;
            response = input.response;
            await trx
              .updateTable('attempt_answers')
              .set({
                response: input.response,
                saved_at: now,
                client_sequence: input.clientSequence ?? row.client_sequence,
              })
              .where('id', '=', row.id)
              .execute();
          }
          const responses = await trx
            .selectFrom('attempt_answers')
            .select('response')
            .where('attempt_id', '=', attemptId)
            .execute();
          return {
            attemptQuestionId,
            answered: isAnswered(response),
            savedAt: savedAt?.toISOString() ?? null,
            applied: !stale,
            answeredCount: responses.filter((r) => isAnswered(r.response)).length,
            timeRemainingSeconds: locked.expires_at
              ? Math.max(0, Math.ceil((locked.expires_at.getTime() - now.getTime()) / 1000))
              : null,
          };
        }),
      `${noun} attempt`,
    );
  }

  // ---------------------------------------------------------------- submit / result

  /** Idempotent: a repeated submit returns the same result. */
  async submit(p: Principal, id: string): Promise<assessment.AttemptResult> {
    const attempt = await this.ownAttempt(p, id);
    await this.lifecycle.submit(attempt.id);
    return this.result(p, id);
  }

  async result(p: Principal, id: string): Promise<assessment.AttemptResult> {
    const attempt = await this.current(p, id);
    const noun = kindNoun(attempt.config.kind);
    if (attempt.status === 'in_progress') {
      throw new ConflictError(
        'ATTEMPT_IN_PROGRESS',
        `This ${noun} attempt is still in progress. Submit it to see your result.`,
      );
    }
    const [assessmentRow, attempts, overrides, rows] = await Promise.all([
      this.db
        .selectFrom('assessments')
        .selectAll()
        .where('id', '=', attempt.assessment_id)
        .executeTakeFirstOrThrow(),
      this.attemptsOf(this.db, attempt.assessment_id, attempt.user_id),
      latestOverrides(this.db, [attempt.id]),
      this.questionRows(this.db, attempt.id),
    ]);
    const score = effectiveScore(attempt, overrides.get(attempt.id));
    const graded = attempt.status === 'graded';
    const scoreVisible = graded && attempt.config.revealScore;
    const maxAttempts = assessmentRow.config.maxAttempts;
    const remaining = maxAttempts === null ? null : Math.max(0, maxAttempts - attempts.length);
    const revealed = answersRevealed(attempt.config.revealCorrectAnswers, {
      closed: true,
      passed: score.passed,
      attemptsUsed: attempts.length,
      maxAttempts,
    });
    const now = this.clock.now();
    const retakeAt =
      score.passed === false &&
      remaining !== 0 &&
      assessmentRow.status === 'published' &&
      attempts[0]?.id === attempt.id
        ? (this.cooldownUntil(assessmentRow, attempts, now) ?? now)
        : null;

    return {
      attemptId: attempt.id,
      assessmentId: attempt.assessment_id,
      title: attempt.config.title,
      kind: attempt.config.kind,
      attemptNumber: attempt.attempt_number,
      status: attempt.status,
      submittedAt: attempt.submitted_at?.toISOString() ?? null,
      gradedAt: attempt.graded_at?.toISOString() ?? null,
      autoSubmitted: attempt.auto_submitted,
      scoreVisible,
      scorePercent: scoreVisible ? score.scorePercent : null,
      scorePoints: scoreVisible && !score.overridden ? attempt.score_points : null,
      maxPoints: scoreVisible ? attempt.max_points : null,
      passed: score.passed,
      passingPercent: attempt.config.passingPercent,
      overridden: score.overridden,
      answersRevealed: revealed,
      attemptsUsed: attempts.length,
      attemptsRemaining: remaining,
      retakeAvailableAt: retakeAt?.toISOString() ?? null,
      message: this.resultMessage(attempt, noun, score, scoreVisible, remaining, retakeAt, now),
      questions: rows.map((r) => {
        const def = toDefinition(r);
        const outcome = outcomeOf(r);
        return {
          attemptQuestionId: r.id,
          position: r.position,
          type: r.type,
          prompt: r.prompt,
          points: r.points,
          response: r.response,
          outcome: attempt.config.revealScore || outcome === 'pending_review' ? outcome : null,
          awardedPoints: attempt.config.revealScore && r.graded_at ? r.awarded_points : null,
          feedback: r.graded_at ? r.feedback : null,
          correctAnswer: revealed ? correctAnswer(def) : null,
          explanation: revealed ? r.explanation : null,
        };
      }),
    };
  }

  private resultMessage(
    attempt: AttemptRow,
    noun: string,
    score: { scorePercent: number | null; passed: boolean | null },
    scoreVisible: boolean,
    remaining: number | null,
    retakeAt: Date | null,
    now: Date,
  ): string {
    const prefix = attempt.auto_submitted
      ? 'Time ran out, so your saved answers were submitted automatically. '
      : '';
    if (attempt.status === 'pending_review') {
      return `${prefix}Your answers were submitted. A trainer will review your written answers, and your result will appear here once grading is complete.`;
    }
    if (attempt.status !== 'graded')
      return `${prefix}Your answers were submitted and are being graded.`;
    const scoreText =
      scoreVisible && score.scorePercent !== null ? ` with ${score.scorePercent}%` : '';
    if (score.passed) return `${prefix}You passed this ${noun}${scoreText}.`;
    const base = `${prefix}You did not reach the passing score of ${attempt.config.passingPercent}%${scoreText ? ` (you scored ${score.scorePercent}%)` : ''}.`;
    if (remaining === 0)
      return `${base} You have no attempts left; your trainer will follow up with you.`;
    if (retakeAt && retakeAt > now)
      return `${base} You can try again in ${waitPhrase(retakeAt, now)}.`;
    return `${base} Review the material and try again when you are ready.`;
  }
}
