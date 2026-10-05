import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { assessment } from '@a5/contracts';
import { likePattern, paginate, sql, type Page } from '@a5/database';
import { userScopeCondition } from '@a5/directory';
import { ConflictError, EventBus, InjectDb, NotFoundError, PreconditionError, ValidationError } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import type { PermissionKey } from '@a5/permissions';
import { Clock } from '../common/clock.js';
import { withIntegrityErrors } from '../common/db-errors.js';
import { effectiveScore, latestOverrides } from '../common/effective-score.js';
import { People, refOrNull } from '../common/people.js';
import type { AttemptRow, Db, DbOrTrx } from '../database/index.js';
import { AttemptEngine } from '../engine/attempt-engine.js';
import { isPassing } from '../engine/policy.js';
import { outcomeOf, round2, toDefinition } from '../engine/question-types.js';

export interface AttemptListFilters {
  q?: string;
  assessmentId?: string;
  userId?: string;
  status?: assessment.AttemptStatus[];
  pendingReview?: boolean;
  submittedFrom?: string;
  submittedTo?: string;
  sort?: string;
  page: number;
  pageSize: number;
}

const SORTS = {
  submittedAt: sql`t.submitted_at`,
  startedAt: sql`t.started_at`,
  learner: sql`u.display_name`,
  assessment: sql`lower(a.title)`,
  score: sql`t.score_percent`,
} as const;

/**
 * Trainer and manager review: attempts are visible only within the reviewer's data scope
 * (managers: their teams and direct reports; trainers: assigned trainees). Out-of-scope attempts
 * answer 404 so their existence is not disclosed.
 */
@Injectable()
export class ReviewService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly engine: AttemptEngine,
    private readonly events: EventBus,
    private readonly people: People,
    private readonly clock: Clock,
  ) {}

  private scoped(db: DbOrTrx, p: Principal, permission: PermissionKey) {
    return db
      .selectFrom('attempts as t')
      .where('t.organization_id', '=', p.organizationId)
      .where(userScopeCondition(p.scopeFilter(permission), { userColumn: 't.user_id', orgColumn: 't.organization_id' }));
  }

  private async scopedAttempt(db: DbOrTrx, p: Principal, permission: PermissionKey, id: string): Promise<AttemptRow> {
    const row = await this.scoped(db, p, permission).selectAll('t').where('t.id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundError('Attempt');
    return row;
  }

  async list(p: Principal, f: AttemptListFilters): Promise<Page<assessment.ReviewAttemptSummary>> {
    let query = this.scoped(this.db, p, 'assessment_attempts.view')
      .innerJoin('assessments as a', 'a.id', 't.assessment_id')
      .leftJoin('dir_users as u', 'u.id', 't.user_id')
      .selectAll('t')
      .select((eb) => [
        'a.title as assessment_title',
        'a.kind as assessment_kind',
        'u.display_name',
        eb
          .selectFrom('attempt_answers as aa')
          .select(eb.fn.countAll<number>().as('n'))
          .whereRef('aa.attempt_id', '=', 't.id')
          .where('aa.needs_review', '=', true)
          .where('aa.graded_at', 'is', null)
          .as('pending_count'),
      ]);
    if (f.assessmentId) query = query.where('t.assessment_id', '=', f.assessmentId);
    if (f.userId) query = query.where('t.user_id', '=', f.userId);
    if (f.status?.length) query = query.where('t.status', 'in', f.status);
    if (f.pendingReview) query = query.where('t.status', '=', 'pending_review');
    if (f.submittedFrom) query = query.where('t.submitted_at', '>=', new Date(f.submittedFrom));
    if (f.submittedTo) query = query.where('t.submitted_at', '<', new Date(f.submittedTo));
    if (f.q) {
      const pattern = likePattern(f.q);
      query = query.where((eb) => eb.or([eb('u.display_name', 'ilike', pattern), eb('u.email', 'ilike', pattern), eb('a.title', 'ilike', pattern)]));
    }
    const desc = f.sort ? f.sort.startsWith('-') : true;
    const key = (f.sort?.replace(/^-/, '') ?? 'submittedAt') as keyof typeof SORTS;
    query = query
      .orderBy(SORTS[key] ?? SORTS.submittedAt, (ob) => (desc ? ob.desc().nullsLast() : ob.asc().nullsLast()))
      .orderBy('t.id', 'desc');

    const page = await paginate(query, { page: f.page, pageSize: f.pageSize });
    const overrides = await latestOverrides(
      this.db,
      page.items.map((r) => r.id),
    );
    return {
      ...page,
      items: page.items.map((r) => {
        const score = effectiveScore(r, overrides.get(r.id));
        return {
          id: r.id,
          assessment: { id: r.assessment_id, title: r.assessment_title, kind: r.assessment_kind },
          learner: { id: r.user_id, displayName: r.display_name ?? 'Unknown user' },
          attemptNumber: r.attempt_number,
          status: r.status,
          startedAt: r.started_at.toISOString(),
          submittedAt: r.submitted_at?.toISOString() ?? null,
          gradedAt: r.graded_at?.toISOString() ?? null,
          autoSubmitted: r.auto_submitted,
          scorePercent: score.scorePercent,
          passed: score.passed,
          overridden: score.overridden,
          pendingReviewCount: Number(r.pending_count ?? 0),
          context: r.context,
        };
      }),
    };
  }

  async detail(p: Principal, id: string, permission: PermissionKey = 'assessment_attempts.view'): Promise<assessment.ReviewAttemptDetail> {
    const t = await this.scopedAttempt(this.db, p, permission, id);
    const [a, rows, overrides] = await Promise.all([
      this.db.selectFrom('assessments').select(['id', 'title', 'kind']).where('id', '=', t.assessment_id).executeTakeFirstOrThrow(),
      this.db
        .selectFrom('attempt_questions as aq')
        .innerJoin('question_versions as v', 'v.id', 'aq.question_version_id')
        .innerJoin('attempt_answers as aa', 'aa.attempt_question_id', 'aq.id')
        .leftJoin('question_categories as c', 'c.id', 'v.category_id')
        .select([
          'aq.id',
          'aq.position',
          'aq.question_id',
          'aq.question_version_id',
          'aq.option_order',
          'aq.points',
          'v.version',
          'v.type',
          'v.config',
          'v.prompt',
          'v.explanation',
          'v.difficulty',
          'c.id as category_id',
          'c.name as category_name',
          'aa.response',
          'aa.saved_at',
          'aa.needs_review',
          'aa.is_correct',
          'aa.awarded_points',
          'aa.feedback',
          'aa.graded_by',
          'aa.graded_by_name',
          'aa.graded_at',
        ])
        .where('aq.attempt_id', '=', id)
        .orderBy('aq.position')
        .execute(),
      this.db.selectFrom('score_overrides').selectAll().where('attempt_id', '=', id).orderBy('created_at', 'desc').orderBy('id', 'desc').execute(),
    ]);
    const learner = await this.people.refs([t.user_id]);
    const score = effectiveScore(t, overrides[0]);
    return {
      id: t.id,
      assessment: { id: a.id, title: a.title, kind: a.kind },
      learner: refOrNull(learner, t.user_id)!,
      attemptNumber: t.attempt_number,
      status: t.status,
      startedAt: t.started_at.toISOString(),
      submittedAt: t.submitted_at?.toISOString() ?? null,
      gradedAt: t.graded_at?.toISOString() ?? null,
      autoSubmitted: t.auto_submitted,
      scorePercent: score.scorePercent,
      passed: score.passed,
      overridden: score.overridden,
      pendingReviewCount: rows.filter((r) => r.needs_review && !r.graded_at).length,
      context: t.context,
      config: t.config,
      expiresAt: t.expires_at?.toISOString() ?? null,
      maxPoints: t.max_points,
      gradedScorePoints: t.score_points,
      gradedScorePercent: t.score_percent,
      gradedPassed: t.passed,
      questions: rows.map((r) => ({
        attemptQuestionId: r.id,
        position: r.position,
        questionId: r.question_id,
        questionVersionId: r.question_version_id,
        version: r.version,
        points: r.points,
        difficulty: r.difficulty,
        category: r.category_id ? { id: r.category_id, name: r.category_name! } : null,
        prompt: r.prompt,
        explanation: r.explanation,
        definition: toDefinition(r),
        optionOrder: r.option_order,
        response: r.response,
        savedAt: r.saved_at?.toISOString() ?? null,
        outcome: outcomeOf(r),
        needsReview: r.needs_review,
        isCorrect: r.is_correct,
        awardedPoints: r.awarded_points,
        feedback: r.feedback,
        gradedBy: r.graded_by ? { id: r.graded_by, displayName: r.graded_by_name ?? 'Unknown user' } : null,
        gradedAt: r.graded_at?.toISOString() ?? null,
      })),
      overrides: overrides.map((o) => ({
        id: o.id,
        previousScorePercent: o.previous_score_percent,
        previousPassed: o.previous_passed,
        newScorePercent: o.new_score_percent,
        newPassed: o.new_passed,
        reason: o.reason,
        actor: { id: o.actor_id, displayName: o.actor_name },
        createdAt: o.created_at.toISOString(),
      })),
    };
  }

  /** Grade open answers; the attempt is finalised (and `attempt.graded` emitted) once none remain. */
  async grade(
    p: Principal,
    id: string,
    grades: ReadonlyArray<{ attemptQuestionId: string; awardedPoints: number; feedback?: string | null }>,
  ): Promise<assessment.ReviewAttemptDetail> {
    await this.scopedAttempt(this.db, p, 'assessment_attempts.grade', id);
    await withIntegrityErrors(() =>
      this.db.transaction().execute(async (trx) => {
        const now = this.clock.now();
        let attempt = await trx.selectFrom('attempts').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
        if (attempt.status === 'in_progress') {
          throw new ConflictError('ATTEMPT_NOT_SUBMITTED', 'This attempt has not been submitted yet. Answers can be graded after the learner submits.');
        }
        if (attempt.status === 'submitted' || attempt.status === 'expired') attempt = await this.engine.grade(trx, id, now);
        if (attempt.status === 'graded') {
          throw new ConflictError('ATTEMPT_ALREADY_GRADED', 'This attempt is already graded. Record a score override to change its result.');
        }
        const answers = await trx
          .selectFrom('attempt_answers as aa')
          .innerJoin('attempt_questions as aq', 'aq.id', 'aa.attempt_question_id')
          .select(['aq.id', 'aq.position', 'aq.points', 'aa.needs_review'])
          .where('aa.attempt_id', '=', id)
          .execute();
        const byQuestion = new Map(answers.map((a) => [a.id, a]));
        const fields: Array<{ path: string; message: string }> = [];
        const seen = new Set<string>();
        grades.forEach((g, index) => {
          const answer = byQuestion.get(g.attemptQuestionId);
          if (!answer) fields.push({ path: `grades.${index}.attemptQuestionId`, message: 'This question is not part of the attempt' });
          else if (!answer.needs_review) {
            fields.push({ path: `grades.${index}.attemptQuestionId`, message: `Question ${answer.position} is graded automatically and cannot be graded by hand` });
          } else if (g.awardedPoints > answer.points) {
            fields.push({ path: `grades.${index}.awardedPoints`, message: `Award at most ${answer.points} points for question ${answer.position}` });
          }
          if (seen.has(g.attemptQuestionId)) fields.push({ path: `grades.${index}.attemptQuestionId`, message: 'Each question can be graded once per request' });
          seen.add(g.attemptQuestionId);
        });
        if (fields.length) throw new ValidationError(fields);

        await this.engine.applyReviewerGrades(
          trx,
          id,
          grades.map((g) => ({ attemptQuestionId: g.attemptQuestionId, awardedPoints: g.awardedPoints, feedback: g.feedback ?? null })),
          { id: p.userId, name: p.displayName },
          now,
        );
        const finalized = await this.engine.finalizeReview(trx, id, now);
        await this.events.audit(trx, {
          action: finalized ? 'assessment.attempt.review_completed' : 'assessment.attempt.answers_graded',
          resourceType: 'assessment_attempt',
          resourceId: id,
          actorDisplay: p.displayName,
          after: {
            learnerId: attempt.user_id,
            assessmentId: attempt.assessment_id,
            grades: grades.map((g) => ({
              position: byQuestion.get(g.attemptQuestionId)!.position,
              awardedPoints: round2(g.awardedPoints),
              possiblePoints: byQuestion.get(g.attemptQuestionId)!.points,
            })),
            ...(finalized && { scorePercent: finalized.score_percent, passed: finalized.passed }),
          },
        });
      }),
    );
    return this.detail(p, id, 'assessment_attempts.grade');
  }

  /**
   * Record a score override. The original grading stays untouched; the override row carries the
   * previous and new effective result, an audit entry is written and `attempt.graded` is emitted
   * with `overridden: true`.
   */
  async override(p: Principal, id: string, input: { scorePercent: number; passed?: boolean; reason: string }): Promise<assessment.ReviewAttemptDetail> {
    await this.scopedAttempt(this.db, p, 'assessment_scores.override', id);
    await this.db.transaction().execute(async (trx) => {
      const attempt = await trx.selectFrom('attempts').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      if (attempt.status !== 'graded') {
        throw new ConflictError('ATTEMPT_NOT_GRADED', 'Only graded attempts can be overridden. Finish reviewing the open answers first.');
      }
      const previous = effectiveScore(attempt, (await latestOverrides(trx, [id])).get(id));
      const newPercent = round2(input.scorePercent);
      const newPassed = input.passed ?? isPassing(newPercent, attempt.config.passingPercent);
      if (previous.scorePercent === newPercent && previous.passed === newPassed) {
        throw new PreconditionError('OVERRIDE_UNCHANGED', 'The new score and result are the same as the current ones. Nothing was changed.');
      }
      const now = this.clock.now();
      await trx
        .insertInto('score_overrides')
        .values({
          id: uuidv7(),
          organization_id: attempt.organization_id,
          attempt_id: id,
          previous_score_percent: previous.scorePercent!,
          previous_passed: previous.passed!,
          new_score_percent: newPercent,
          new_passed: newPassed,
          reason: input.reason,
          actor_id: p.userId,
          actor_name: p.displayName,
          created_at: now,
        })
        .execute();
      await this.events.audit(trx, {
        action: 'assessment.score.overridden',
        resourceType: 'assessment_attempt',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { scorePercent: previous.scorePercent, passed: previous.passed },
        after: { scorePercent: newPercent, passed: newPassed },
        reason: input.reason,
        metadata: { learnerId: attempt.user_id, assessmentId: attempt.assessment_id, attemptNumber: attempt.attempt_number },
      });
      await this.engine.emitGraded(trx, attempt, { scorePercent: newPercent, passed: newPassed, gradedAt: now, overridden: true });
    });
    return this.detail(p, id, 'assessment_scores.override');
  }
}
