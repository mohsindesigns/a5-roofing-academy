import type { assessment } from '@a5/contracts';
import { assessmentEvents, type EventActor, type EventDefinition } from '@a5/events';
import { uuidv7 } from '@a5/observability';
import type { z } from 'zod';
import type { AssessmentRow, AttemptRow, Trx } from '../database/index.js';
import type { DrawnQuestion } from './draw.js';
import { gradeResponse, needsReview, round2, toDefinition } from './question-types.js';
import { isPassing, scorePercent } from './policy.js';

/** Where engine events go: the EventBus in the service, a dated outbox writer in the seed. */
export interface EventSink {
  emit<T extends string, S extends z.ZodType>(
    trx: Trx,
    def: EventDefinition<T, S>,
    payload: z.input<S>,
    options?: {
      subject?: { type: string; id: string } | null;
      organizationId?: string | null;
      actor?: EventActor;
    },
  ): Promise<unknown>;
}

export interface ManagerLookup {
  managersOf(userId: string): Promise<string[]>;
}

export interface CreateAttemptInput {
  id?: string;
  assessment: AssessmentRow;
  userId: string;
  attemptNumber: number;
  context: assessment.AttemptContext;
  drawn: readonly DrawnQuestion[];
  startedAt: Date;
}

export interface ReviewerGrade {
  attemptQuestionId: string;
  awardedPoints: number;
  feedback: string | null;
}

const subject = (attemptId: string) => ({ type: 'assessment_attempt', id: attemptId });

/**
 * Attempt state machine shared by the HTTP services, the expiry sweeper and the seed:
 * create (draw snapshot) → close (freeze answers) → grade (automatic) → finalize after review.
 * Every method runs inside the caller's transaction; callers lock the attempt row first.
 */
export class AttemptEngine {
  constructor(
    private readonly events: EventSink,
    private readonly managers: ManagerLookup,
  ) {}

  async create(trx: Trx, input: CreateAttemptInput): Promise<AttemptRow> {
    const { assessment: a, drawn } = input;
    const id = input.id ?? uuidv7();
    const config: assessment.AttemptConfigSnapshot = {
      ...a.config,
      title: a.title,
      kind: a.kind,
      assessmentRevision: a.revision,
    };
    const maxPoints = round2(drawn.reduce((sum, q) => sum + q.points, 0));
    const attempt = await trx
      .insertInto('attempts')
      .values({
        id,
        organization_id: a.organization_id,
        assessment_id: a.id,
        user_id: input.userId,
        attempt_number: input.attemptNumber,
        status: 'in_progress',
        context: input.context,
        config,
        started_at: input.startedAt,
        expires_at: config.timeLimitSeconds
          ? new Date(input.startedAt.getTime() + config.timeLimitSeconds * 1000)
          : null,
        submitted_at: null,
        graded_at: null,
        auto_submitted: false,
        max_points: maxPoints,
        score_points: null,
        score_percent: null,
        passed: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const questions = drawn.map((q, index) => ({
      id: uuidv7(),
      attempt_id: id,
      position: index + 1,
      item_id: q.itemId,
      question_id: q.question.questionId,
      question_version_id: q.question.versionId,
      option_order: q.optionOrder,
      points: q.points,
    }));
    if (questions.length) {
      await trx.insertInto('attempt_questions').values(questions).execute();
      await trx
        .insertInto('attempt_answers')
        .values(
          questions.map((q) => ({
            id: uuidv7(),
            attempt_id: id,
            attempt_question_id: q.id,
            response: null,
            saved_at: null,
            client_sequence: null,
            is_correct: null,
            awarded_points: null,
            feedback: null,
            graded_by: null,
            graded_by_name: null,
            graded_at: null,
          })),
        )
        .execute();
    }
    await this.events.emit(
      trx,
      assessmentEvents.attemptStarted,
      {
        attemptId: id,
        assessmentId: a.id,
        userId: input.userId,
        attemptNumber: input.attemptNumber,
        context: input.context,
      },
      { subject: subject(id), organizationId: a.organization_id },
    );
    return attempt;
  }

  private answerRows(trx: Trx, attemptId: string) {
    return trx
      .selectFrom('attempt_answers as aa')
      .innerJoin('attempt_questions as aq', 'aq.id', 'aa.attempt_question_id')
      .innerJoin('question_versions as v', 'v.id', 'aq.question_version_id')
      .select([
        'aa.id',
        'aa.response',
        'aa.needs_review',
        'aa.is_correct',
        'aa.awarded_points',
        'aa.graded_at',
        'aq.id as attempt_question_id',
        'aq.question_id',
        'aq.question_version_id',
        'aq.points',
        'v.type',
        'v.config',
        'v.category_id',
      ])
      .where('aa.attempt_id', '=', attemptId)
      .orderBy('aq.position')
      .execute();
  }

  /** Freeze the answers: `in_progress` → `submitted` (learner) or `expired` (time limit). */
  async close(
    trx: Trx,
    attempt: AttemptRow,
    reason: 'learner' | 'time_limit',
    at: Date,
  ): Promise<AttemptRow> {
    if (attempt.status !== 'in_progress') return attempt;
    const rows = await this.answerRows(trx, attempt.id);
    const reviewNeeded = rows.some((r) => needsReview(toDefinition(r), r.response));
    const closed = await trx
      .updateTable('attempts')
      .set({
        status: reason === 'learner' ? 'submitted' : 'expired',
        submitted_at: at,
        auto_submitted: reason === 'time_limit',
      })
      .where('id', '=', attempt.id)
      .where('status', '=', 'in_progress')
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.events.emit(
      trx,
      assessmentEvents.attemptSubmitted,
      {
        attemptId: attempt.id,
        assessmentId: attempt.assessment_id,
        assessmentTitle: attempt.config.title,
        userId: attempt.user_id,
        needsReview: reviewNeeded,
        context: attempt.context,
      },
      { subject: subject(attempt.id), organizationId: attempt.organization_id },
    );
    return closed;
  }

  /**
   * Grade a closed attempt automatically. Objective answers are scored; answered open questions
   * wait for a reviewer (`pending_review`). Without open answers the attempt is final (`graded`).
   */
  async grade(trx: Trx, attemptId: string, at: Date): Promise<AttemptRow> {
    const attempt = await trx
      .selectFrom('attempts')
      .selectAll()
      .where('id', '=', attemptId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (attempt.status !== 'submitted' && attempt.status !== 'expired') return attempt;
    const rows = await this.answerRows(trx, attemptId);
    let pending = false;
    for (const row of rows) {
      const grade = gradeResponse(toDefinition(row), row.response, row.points);
      if (grade.kind === 'review') {
        pending = true;
        await trx
          .updateTable('attempt_answers')
          .set({ needs_review: true })
          .where('id', '=', row.id)
          .execute();
      } else {
        await trx
          .updateTable('attempt_answers')
          .set({
            needs_review: false,
            is_correct: grade.correct,
            awarded_points: grade.awarded,
            graded_at: at,
          })
          .where('id', '=', row.id)
          .execute();
      }
    }
    if (pending) {
      return trx
        .updateTable('attempts')
        .set({ status: 'pending_review' })
        .where('id', '=', attemptId)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    return this.finalize(trx, attempt, at);
  }

  /** Store reviewer grades for open answers of a `pending_review` attempt. */
  async applyReviewerGrades(
    trx: Trx,
    attemptId: string,
    grades: readonly ReviewerGrade[],
    reviewer: { id: string; name: string },
    at: Date,
  ): Promise<void> {
    for (const g of grades) {
      const row = await trx
        .selectFrom('attempt_answers as aa')
        .innerJoin('attempt_questions as aq', 'aq.id', 'aa.attempt_question_id')
        .select(['aa.id', 'aq.points'])
        .where('aa.attempt_id', '=', attemptId)
        .where('aa.attempt_question_id', '=', g.attemptQuestionId)
        .executeTakeFirstOrThrow();
      const awarded = round2(Math.min(g.awardedPoints, row.points));
      await trx
        .updateTable('attempt_answers')
        .set({
          awarded_points: awarded,
          is_correct: awarded >= row.points,
          feedback: g.feedback,
          graded_by: reviewer.id,
          graded_by_name: reviewer.name,
          graded_at: at,
        })
        .where('id', '=', row.id)
        .execute();
    }
  }

  /** Finish a `pending_review` attempt once every open answer has a grade. Returns null while answers remain. */
  async finalizeReview(trx: Trx, attemptId: string, at: Date): Promise<AttemptRow | null> {
    const attempt = await trx
      .selectFrom('attempts')
      .selectAll()
      .where('id', '=', attemptId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (attempt.status !== 'pending_review') return null;
    const open = await trx
      .selectFrom('attempt_answers')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('attempt_id', '=', attemptId)
      .where('needs_review', '=', true)
      .where('graded_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(open.n) > 0) return null;
    return this.finalize(trx, attempt, at);
  }

  private async finalize(trx: Trx, attempt: AttemptRow, at: Date): Promise<AttemptRow> {
    const rows = await this.answerRows(trx, attempt.id);
    const points = round2(rows.reduce((sum, r) => sum + (r.awarded_points ?? 0), 0));
    const percent = scorePercent(points, attempt.max_points);
    const graded = await trx
      .updateTable('attempts')
      .set({
        status: 'graded',
        graded_at: at,
        score_points: points,
        score_percent: percent,
        passed: isPassing(percent, attempt.config.passingPercent),
      })
      .where('id', '=', attempt.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.emitGraded(trx, graded, {
      scorePercent: percent,
      passed: graded.passed!,
      gradedAt: at,
      overridden: false,
    });
    return graded;
  }

  /** `assessment.attempt.graded` for a final result (automatic, after review, or overridden). */
  async emitGraded(
    trx: Trx,
    attempt: AttemptRow,
    result: { scorePercent: number; passed: boolean; gradedAt: Date; overridden: boolean },
  ): Promise<void> {
    const rows = await this.answerRows(trx, attempt.id);
    const outcome = result.passed ? 'passed' : 'failed';
    const notifyManagerIds = attempt.config.notifyManagerOn.includes(outcome)
      ? await this.managers.managersOf(attempt.user_id)
      : [];
    await this.events.emit(
      trx,
      assessmentEvents.attemptGraded,
      {
        attemptId: attempt.id,
        assessmentId: attempt.assessment_id,
        assessmentTitle: attempt.config.title,
        kind: attempt.config.kind,
        userId: attempt.user_id,
        attemptNumber: attempt.attempt_number,
        scorePercent: result.scorePercent,
        passed: result.passed,
        passingPercent: attempt.config.passingPercent,
        gradedAt: result.gradedAt.toISOString(),
        overridden: result.overridden,
        context: attempt.context,
        questionResults: rows.map((r) => ({
          questionId: r.question_id,
          questionVersionId: r.question_version_id,
          categoryId: r.category_id,
          correct: r.is_correct,
          awardedPoints: r.awarded_points ?? 0,
          possiblePoints: r.points,
        })),
        notifyManagerIds,
      },
      { subject: subject(attempt.id), organizationId: attempt.organization_id },
    );
  }
}
