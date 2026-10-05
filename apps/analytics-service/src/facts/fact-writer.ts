import { sql } from '@a5/database';
import type { EventEnvelope, EventPayload, EventType } from '@a5/events';
import type { Trx } from '../database/index.js';
import { stableId } from '../common/ids.js';

type Envelope<T extends EventType> = EventEnvelope<EventPayload<T>, T>;

interface EnrollmentRef {
  enrollmentId: string;
  programId: string;
  userId: string;
}

const ts = (value: string | null | undefined): Date | null => (value ? new Date(value) : null);

export interface FactWriterOptions {
  /** IANA time zone used to derive the calendar day of a fact (rollup invalidation). */
  timezone: string;
}

/**
 * Applies domain events to the analytics fact and dimension tables.
 *
 * Every method is idempotent and tolerant of out-of-order delivery: rows are upserted, "first"
 * timestamps use least(), "last" timestamps use greatest(), and state transitions only apply
 * when the event is at least as new as the state already stored. Callers wrap each call in
 * `processOnce` so a redelivered event is skipped entirely; the guards make reordering and
 * duplicate facts from distinct events safe as well.
 */
export class FactWriter {
  constructor(private readonly options: FactWriterOptions) {}

  // ---------------------------------------------------------------- learning

  async programPublished(trx: Trx, e: Envelope<'program.published'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const at = new Date(e.occurredAt);
    const existing = await trx.selectFrom('dim_programs').select('version').where('id', '=', p.programId).executeTakeFirst();
    if (existing && existing.version >= p.version) return;

    await trx
      .insertInto('dim_programs')
      .values({
        id: p.programId,
        organization_id: org,
        title: p.title,
        version: p.version,
        required_lesson_count: p.requiredLessonIds.length,
        archived: false,
        published_at: at,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          title: sql`excluded.title`,
          version: sql`excluded.version`,
          required_lesson_count: sql`excluded.required_lesson_count`,
          archived: false,
          published_at: sql`excluded.published_at`,
        }),
      )
      .execute();

    for (const phase of p.phases) {
      await trx
        .insertInto('dim_phases')
        .values({ id: phase.phaseId, organization_id: org, program_id: p.programId, title: phase.title, position: phase.position })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({ title: sql`excluded.title`, position: sql`excluded.position`, program_id: sql`excluded.program_id` }),
        )
        .execute();
    }

    const required = new Set(p.requiredLessonIds);
    if (p.lessons?.length) {
      for (const l of p.lessons) {
        await trx
          .insertInto('dim_lessons')
          .values({
            id: l.lessonId,
            organization_id: org,
            program_id: p.programId,
            phase_id: l.phaseId,
            module_id: l.moduleId,
            title: l.title,
            lesson_type: l.type,
            position: l.position,
            required: l.required || required.has(l.lessonId),
            in_program: true,
          })
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              program_id: sql`excluded.program_id`,
              phase_id: sql`excluded.phase_id`,
              module_id: sql`excluded.module_id`,
              title: sql`excluded.title`,
              lesson_type: sql`excluded.lesson_type`,
              position: sql`excluded.position`,
              required: sql`excluded.required`,
              in_program: true,
            }),
          )
          .execute();
      }
      await trx
        .updateTable('dim_lessons')
        .set({ in_program: false })
        .where('program_id', '=', p.programId)
        .where('id', 'not in', p.lessons.map((l) => l.lessonId))
        .execute();
    } else if (required.size) {
      for (const lessonId of required) {
        await trx
          .insertInto('dim_lessons')
          .values({ id: lessonId, organization_id: org, program_id: p.programId, required: true, in_program: true })
          .onConflict((oc) => oc.column('id').doUpdateSet({ required: true, in_program: true }))
          .execute();
      }
      await trx
        .updateTable('dim_lessons')
        .set({ required: false })
        .where('program_id', '=', p.programId)
        .where('id', 'not in', [...required])
        .execute();
    }

    for (const a of p.assessments) {
      await trx
        .insertInto('dim_assessments')
        .values({
          id: a.assessmentId,
          organization_id: org,
          program_id: p.programId,
          lesson_id: a.lessonId,
          title: a.title,
          kind: a.kind,
          required: a.required,
          passing_percent: null,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            program_id: sql`excluded.program_id`,
            lesson_id: sql`excluded.lesson_id`,
            title: sql`excluded.title`,
            kind: sql`excluded.kind`,
            required: sql`excluded.required`,
          }),
        )
        .execute();
    }

    for (const s of p.aiScenarios) {
      await trx
        .insertInto('dim_scenarios')
        .values({ id: s.scenarioId, organization_id: org, program_id: p.programId, lesson_id: s.lessonId, min_score: s.minScore })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            program_id: sql`excluded.program_id`,
            lesson_id: sql`excluded.lesson_id`,
            min_score: sql`excluded.min_score`,
          }),
        )
        .execute();
    }
  }

  async programArchived(trx: Trx, e: Envelope<'program.archived'>): Promise<void> {
    await trx.updateTable('dim_programs').set({ archived: true }).where('id', '=', e.payload.programId).execute();
  }

  async enrolled(trx: Trx, e: Envelope<'program.enrolled'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const at = new Date(e.occurredAt);
    await trx
      .insertInto('fact_enrollments')
      .values({
        enrollment_id: p.enrollmentId,
        organization_id: org,
        user_id: p.userId,
        program_id: p.programId,
        program_title: p.programTitle,
        source: p.source,
        assigned_by: p.assignedBy,
        status: 'active',
        enrolled_at: at,
        first_seen_at: at,
        due_at: ts(p.dueAt),
        progress_percent: 0,
        required_completed: 0,
        overdue: false,
      })
      .onConflict((oc) =>
        oc.column('enrollment_id').doUpdateSet({
          program_title: sql`excluded.program_title`,
          source: sql`excluded.source`,
          assigned_by: sql`excluded.assigned_by`,
          enrolled_at: sql`least(fact_enrollments.enrolled_at, excluded.enrolled_at)`,
          first_seen_at: sql`least(fact_enrollments.first_seen_at, excluded.first_seen_at)`,
          // An overdue notice carries the current due date, so it wins over the enrolment default.
          due_at: sql`coalesce(fact_enrollments.due_at, excluded.due_at)`,
        }),
      )
      .execute();
    await trx
      .insertInto('dim_programs')
      .values({ id: p.programId, organization_id: org, title: p.programTitle, version: 0, archived: false, published_at: null })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          title: sql`case when dim_programs.version = 0 then excluded.title else dim_programs.title end`,
        }),
      )
      .execute();
    await this.feed(trx, {
      id: stableId('enrolled', p.enrollmentId),
      organization_id: org,
      user_id: p.userId,
      occurred_at: at,
      kind: 'enrolled',
      title: p.programTitle,
      program_id: p.programId,
    });
    await this.markDirty(trx, org, [at]);
  }

  async progressed(trx: Trx, e: Envelope<'enrollment.progressed'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const at = new Date(e.occurredAt);
    await this.ensureEnrollment(trx, org, p, at, null);
    await trx
      .updateTable('fact_enrollments')
      .set({
        progress_percent: p.progressPercent,
        required_completed: p.requiredCompleted,
        required_total: p.requiredTotal,
        current_phase_id: p.currentPhaseId,
        progress_at: at,
      })
      .where('enrollment_id', '=', p.enrollmentId)
      .where((eb) => eb.or([eb('progress_at', 'is', null), eb('progress_at', '<=', at)]))
      .execute();
  }

  async programCompleted(trx: Trx, e: Envelope<'program.completed'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const at = new Date(p.completedAt);
    await this.ensureEnrollment(trx, org, p, at, at);
    await sql`
      update fact_enrollments set
        completed_at = least(completed_at, ${at}::timestamptz),
        status = case when status_at is null or status_at <= ${at}::timestamptz then 'completed' else status end,
        status_at = greatest(status_at, ${at}::timestamptz),
        progress_percent = case when progress_at is null or progress_at <= ${at}::timestamptz then 100 else progress_percent end,
        required_completed = case
          when (progress_at is null or progress_at <= ${at}::timestamptz) and required_total is not null then required_total
          else required_completed end,
        progress_at = greatest(progress_at, ${at}::timestamptz),
        program_title = coalesce(program_title, ${p.programTitle})
      where enrollment_id = ${p.enrollmentId}
    `.execute(trx);
    await this.touchLearner(trx, org, p.userId, at);
    await this.feed(trx, {
      id: stableId('program_completed', p.enrollmentId),
      organization_id: org,
      user_id: p.userId,
      occurred_at: at,
      kind: 'program_completed',
      title: p.programTitle,
      program_id: p.programId,
    });
    await this.markDirty(trx, org, [at]);
  }

  async withdrawn(trx: Trx, e: Envelope<'enrollment.withdrawn'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const at = new Date(e.occurredAt);
    await this.ensureEnrollment(trx, org, p, at, null);
    await sql`
      update fact_enrollments set
        status = case when status_at is null or status_at <= ${at}::timestamptz then 'withdrawn' else status end,
        status_at = greatest(status_at, ${at}::timestamptz),
        withdrawn_at = greatest(withdrawn_at, ${at}::timestamptz)
      where enrollment_id = ${p.enrollmentId}
    `.execute(trx);
  }

  async overdue(trx: Trx, e: Envelope<'enrollment.overdue'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const at = new Date(e.occurredAt);
    await this.ensureEnrollment(trx, org, p, at, null);
    await sql`
      update fact_enrollments set
        due_at = case when overdue_at is null or overdue_at <= ${at}::timestamptz then ${new Date(p.dueAt)}::timestamptz else due_at end,
        overdue = true,
        overdue_at = greatest(overdue_at, ${at}::timestamptz),
        program_title = coalesce(program_title, ${p.programTitle})
      where enrollment_id = ${p.enrollmentId}
    `.execute(trx);
  }

  async lessonStarted(trx: Trx, e: Envelope<'lesson.started'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const at = new Date(e.occurredAt);
    await this.ensureEnrollment(trx, org, p, at, at);
    await this.touchLearner(trx, org, p.userId, at);
    await trx
      .insertInto('fact_lesson_events')
      .values({
        enrollment_id: p.enrollmentId,
        lesson_id: p.lessonId,
        organization_id: org,
        user_id: p.userId,
        program_id: p.programId,
        lesson_type: p.lessonType,
        started_at: at,
      })
      .onConflict((oc) =>
        oc.columns(['enrollment_id', 'lesson_id']).doUpdateSet({
          started_at: sql`least(fact_lesson_events.started_at, excluded.started_at)`,
          lesson_type: sql`coalesce(fact_lesson_events.lesson_type, excluded.lesson_type)`,
        }),
      )
      .execute();
    await trx
      .insertInto('dim_lessons')
      .values({ id: p.lessonId, organization_id: org, program_id: p.programId, lesson_type: p.lessonType, in_program: true })
      .onConflict((oc) => oc.column('id').doUpdateSet({ lesson_type: sql`coalesce(dim_lessons.lesson_type, excluded.lesson_type)` }))
      .execute();
    await this.markDirty(trx, org, [at]);
  }

  async lessonCompleted(trx: Trx, e: Envelope<'lesson.completed'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const at = new Date(p.completedAt);
    const before = await trx
      .selectFrom('fact_lesson_events')
      .select('completed_at')
      .where('enrollment_id', '=', p.enrollmentId)
      .where('lesson_id', '=', p.lessonId)
      .executeTakeFirst();
    await this.ensureEnrollment(trx, org, p, at, at);
    await this.touchLearner(trx, org, p.userId, at);
    await trx
      .insertInto('fact_lesson_events')
      .values({
        enrollment_id: p.enrollmentId,
        lesson_id: p.lessonId,
        organization_id: org,
        user_id: p.userId,
        program_id: p.programId,
        phase_id: p.phaseId,
        module_id: p.moduleId,
        lesson_type: p.lessonType,
        required: p.required,
        completed_at: at,
        completion_source: p.source,
      })
      .onConflict((oc) =>
        oc.columns(['enrollment_id', 'lesson_id']).doUpdateSet({
          completion_source: sql`case
            when fact_lesson_events.completed_at is null or excluded.completed_at < fact_lesson_events.completed_at
            then excluded.completion_source else fact_lesson_events.completion_source end`,
          completed_at: sql`least(fact_lesson_events.completed_at, excluded.completed_at)`,
          phase_id: sql`coalesce(excluded.phase_id, fact_lesson_events.phase_id)`,
          module_id: sql`coalesce(excluded.module_id, fact_lesson_events.module_id)`,
          lesson_type: sql`coalesce(excluded.lesson_type, fact_lesson_events.lesson_type)`,
          required: sql`coalesce(excluded.required, fact_lesson_events.required)`,
        }),
      )
      .execute();
    // The published outline is authoritative; completions only fill gaps.
    await trx
      .insertInto('dim_lessons')
      .values({
        id: p.lessonId,
        organization_id: org,
        program_id: p.programId,
        phase_id: p.phaseId,
        module_id: p.moduleId,
        title: p.lessonTitle,
        lesson_type: p.lessonType,
        required: p.required,
        in_program: true,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          phase_id: sql`coalesce(dim_lessons.phase_id, excluded.phase_id)`,
          module_id: sql`coalesce(dim_lessons.module_id, excluded.module_id)`,
          title: sql`coalesce(dim_lessons.title, excluded.title)`,
          lesson_type: sql`coalesce(dim_lessons.lesson_type, excluded.lesson_type)`,
          required: sql`coalesce(dim_lessons.required, excluded.required)`,
        }),
      )
      .execute();
    await this.feed(
      trx,
      {
        id: stableId('lesson_completed', p.enrollmentId, p.lessonId),
        organization_id: org,
        user_id: p.userId,
        occurred_at: at,
        kind: 'lesson_completed',
        title: p.lessonTitle,
        program_id: p.programId,
      },
      'earliest',
    );
    await this.markDirty(trx, org, [at, before?.completed_at ?? null]);
  }

  async phaseCompleted(trx: Trx, e: Envelope<'phase.completed'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const at = new Date(p.completedAt);
    await this.ensureEnrollment(trx, org, p, at, at);
    await trx
      .insertInto('fact_phase_completions')
      .values({
        enrollment_id: p.enrollmentId,
        phase_id: p.phaseId,
        organization_id: org,
        user_id: p.userId,
        program_id: p.programId,
        phase_title: p.phaseTitle,
        completed_at: at,
      })
      .onConflict((oc) =>
        oc.columns(['enrollment_id', 'phase_id']).doUpdateSet({
          completed_at: sql`least(fact_phase_completions.completed_at, excluded.completed_at)`,
          phase_title: sql`excluded.phase_title`,
        }),
      )
      .execute();
    await trx
      .insertInto('dim_phases')
      .values({ id: p.phaseId, organization_id: org, program_id: p.programId, title: p.phaseTitle, position: null })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await this.feed(
      trx,
      {
        id: stableId('phase_completed', p.enrollmentId, p.phaseId),
        organization_id: org,
        user_id: p.userId,
        occurred_at: at,
        kind: 'phase_completed',
        title: p.phaseTitle,
        program_id: p.programId,
      },
      'earliest',
    );
  }

  // ---------------------------------------------------------------- assessment

  async attemptGraded(trx: Trx, e: Envelope<'assessment.attempt.graded'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const gradedAt = new Date(p.gradedAt);
    const existing = await trx
      .selectFrom('fact_assessment_attempts')
      .select(['graded_at', 'overridden'])
      .where('attempt_id', '=', p.attemptId)
      .executeTakeFirst();
    // Latest grading wins; at the same instant a score override beats the automatic grade.
    const newer =
      !existing ||
      gradedAt.getTime() > existing.graded_at.getTime() ||
      (gradedAt.getTime() === existing.graded_at.getTime() && p.overridden && !existing.overridden);

    const ctx = p.context;
    if (newer) {
      await trx
        .insertInto('fact_assessment_attempts')
        .values({
          attempt_id: p.attemptId,
          organization_id: org,
          user_id: p.userId,
          assessment_id: p.assessmentId,
          assessment_title: p.assessmentTitle,
          kind: p.kind,
          attempt_number: p.attemptNumber,
          score_percent: p.scorePercent,
          passed: p.passed,
          passing_percent: p.passingPercent,
          overridden: p.overridden,
          graded_at: gradedAt,
          program_id: ctx.programId ?? null,
          enrollment_id: ctx.enrollmentId ?? null,
          lesson_id: ctx.lessonId ?? null,
        })
        .onConflict((oc) =>
          oc.column('attempt_id').doUpdateSet({
            assessment_title: sql`excluded.assessment_title`,
            kind: sql`excluded.kind`,
            attempt_number: sql`excluded.attempt_number`,
            score_percent: sql`excluded.score_percent`,
            passed: sql`excluded.passed`,
            passing_percent: sql`excluded.passing_percent`,
            overridden: sql`excluded.overridden`,
            graded_at: sql`excluded.graded_at`,
            program_id: sql`coalesce(excluded.program_id, fact_assessment_attempts.program_id)`,
            enrollment_id: sql`coalesce(excluded.enrollment_id, fact_assessment_attempts.enrollment_id)`,
            lesson_id: sql`coalesce(excluded.lesson_id, fact_assessment_attempts.lesson_id)`,
          }),
        )
        .execute();
      await trx.deleteFrom('fact_question_results').where('attempt_id', '=', p.attemptId).execute();
      const seen = new Set<string>();
      const results = p.questionResults.filter((q) => (seen.has(q.questionId) ? false : (seen.add(q.questionId), true)));
      if (results.length) {
        await trx
          .insertInto('fact_question_results')
          .values(
            results.map((q) => ({
              attempt_id: p.attemptId,
              question_id: q.questionId,
              organization_id: org,
              user_id: p.userId,
              assessment_id: p.assessmentId,
              question_version_id: q.questionVersionId,
              category_id: q.categoryId,
              correct: q.correct,
              awarded_points: q.awardedPoints,
              possible_points: q.possiblePoints,
              graded_at: gradedAt,
            })),
          )
          .execute();
      }
      await this.feed(
        trx,
        {
          id: stableId('attempt', p.attemptId),
          organization_id: org,
          user_id: p.userId,
          occurred_at: gradedAt,
          kind: p.passed ? 'assessment_passed' : 'assessment_failed',
          title: p.assessmentTitle,
          program_id: ctx.programId ?? null,
          score: p.scorePercent,
          passed: p.passed,
        },
        'replace',
      );
    }

    await trx
      .insertInto('dim_assessments')
      .values({
        id: p.assessmentId,
        organization_id: org,
        program_id: ctx.programId ?? null,
        lesson_id: ctx.lessonId ?? null,
        title: p.assessmentTitle,
        kind: p.kind,
        passing_percent: p.passingPercent,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          title: sql`excluded.title`,
          kind: sql`excluded.kind`,
          passing_percent: sql`excluded.passing_percent`,
          program_id: sql`coalesce(dim_assessments.program_id, excluded.program_id)`,
          lesson_id: sql`coalesce(dim_assessments.lesson_id, excluded.lesson_id)`,
        }),
      )
      .execute();
    for (const q of p.questionResults) {
      if (q.categoryId && q.categoryName) {
        await trx
          .insertInto('dim_question_categories')
          .values({ id: q.categoryId, organization_id: org, name: q.categoryName })
          .onConflict((oc) => oc.column('id').doUpdateSet({ name: sql`excluded.name` }))
          .execute();
      }
      await trx
        .insertInto('dim_questions')
        .values({
          id: q.questionId,
          organization_id: org,
          assessment_id: p.assessmentId,
          category_id: q.categoryId,
          prompt: q.prompt ?? null,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            category_id: sql`coalesce(excluded.category_id, dim_questions.category_id)`,
            prompt: sql`coalesce(excluded.prompt, dim_questions.prompt)`,
          }),
        )
        .execute();
    }

    await this.touchLearner(trx, org, p.userId, gradedAt);
    if (ctx.enrollmentId && ctx.programId) {
      await this.ensureEnrollment(trx, org, { enrollmentId: ctx.enrollmentId, programId: ctx.programId, userId: p.userId }, gradedAt, gradedAt);
    }
    await this.markDirty(trx, org, [gradedAt, existing?.graded_at ?? null]);
  }

  // ---------------------------------------------------------------- ai coaching

  async aiScored(trx: Trx, e: Envelope<'ai.score.generated'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const at = new Date(p.evaluatedAt);
    const existing = await trx
      .selectFrom('fact_ai_sessions')
      .select('evaluated_at')
      .where('session_id', '=', p.sessionId)
      .executeTakeFirst();
    const newer = !existing || at.getTime() > existing.evaluated_at.getTime();
    const ctx = p.context;
    if (newer) {
      await trx
        .insertInto('fact_ai_sessions')
        .values({
          session_id: p.sessionId,
          organization_id: org,
          user_id: p.userId,
          scenario_id: p.scenarioId,
          scenario_title: p.scenarioTitle,
          scenario_category: p.scenarioCategory,
          difficulty: p.difficulty,
          overall_score: p.overallScore,
          passed: p.passed,
          passing_score: p.passingScore,
          evaluated_at: at,
          program_id: ctx.programId ?? null,
          enrollment_id: ctx.enrollmentId ?? null,
          lesson_id: ctx.lessonId ?? null,
          prompt_version_id: p.promptVersionId,
          rubric_version_id: p.rubricVersionId,
        })
        .onConflict((oc) =>
          oc.column('session_id').doUpdateSet({
            scenario_title: sql`excluded.scenario_title`,
            scenario_category: sql`excluded.scenario_category`,
            difficulty: sql`excluded.difficulty`,
            overall_score: sql`excluded.overall_score`,
            passed: sql`excluded.passed`,
            passing_score: sql`excluded.passing_score`,
            evaluated_at: sql`excluded.evaluated_at`,
            prompt_version_id: sql`excluded.prompt_version_id`,
            rubric_version_id: sql`excluded.rubric_version_id`,
          }),
        )
        .execute();
      await trx.deleteFrom('fact_ai_category_scores').where('session_id', '=', p.sessionId).execute();
      const seen = new Set<string>();
      const categories = p.categoryScores.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)));
      if (categories.length) {
        await trx
          .insertInto('fact_ai_category_scores')
          .values(
            categories.map((c) => ({
              session_id: p.sessionId,
              category_key: c.key,
              organization_id: org,
              user_id: p.userId,
              category_label: c.label,
              score: c.score,
              evaluated_at: at,
            })),
          )
          .execute();
      }
      await this.feed(
        trx,
        {
          id: stableId('ai', p.sessionId),
          organization_id: org,
          user_id: p.userId,
          occurred_at: at,
          kind: 'ai_session_scored',
          title: p.scenarioTitle,
          program_id: ctx.programId ?? null,
          score: p.overallScore,
          passed: p.passed,
        },
        'replace',
      );
    }
    await trx
      .insertInto('dim_scenarios')
      .values({
        id: p.scenarioId,
        organization_id: org,
        title: p.scenarioTitle,
        category: p.scenarioCategory,
        difficulty: p.difficulty,
        passing_score: p.passingScore,
        program_id: ctx.programId ?? null,
        lesson_id: ctx.lessonId ?? null,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          title: sql`excluded.title`,
          category: sql`excluded.category`,
          difficulty: sql`excluded.difficulty`,
          passing_score: sql`excluded.passing_score`,
          program_id: sql`coalesce(dim_scenarios.program_id, excluded.program_id)`,
          lesson_id: sql`coalesce(dim_scenarios.lesson_id, excluded.lesson_id)`,
        }),
      )
      .execute();
    await this.touchLearner(trx, org, p.userId, at);
    if (ctx.enrollmentId && ctx.programId) {
      await this.ensureEnrollment(trx, org, { enrollmentId: ctx.enrollmentId, programId: ctx.programId, userId: p.userId }, at, at);
    }
    await this.markDirty(trx, org, [at, existing?.evaluated_at ?? null]);
  }

  // ---------------------------------------------------------------- certification

  async certificateEligible(trx: Trx, e: Envelope<'certificate.eligible'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const at = new Date(e.occurredAt);
    await this.certification(trx, org, p.definitionId, p.definitionName);
    await trx
      .insertInto('fact_certification_candidates')
      .values({
        definition_id: p.definitionId,
        user_id: p.userId,
        organization_id: org,
        definition_name: p.definitionName,
        eligible_at: at,
        requires_approval: p.requiresApproval,
      })
      .onConflict((oc) =>
        oc.columns(['definition_id', 'user_id']).doUpdateSet({
          eligible_at: sql`least(fact_certification_candidates.eligible_at, excluded.eligible_at)`,
          requires_approval: sql`excluded.requires_approval`,
          definition_name: sql`excluded.definition_name`,
        }),
      )
      .execute();
    await this.markDirty(trx, org, [at]);
  }

  async certificateApprovalRequested(trx: Trx, e: Envelope<'certificate.approval_requested'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const at = new Date(e.occurredAt);
    await this.certification(trx, org, p.definitionId, p.definitionName);
    await trx
      .insertInto('fact_certification_candidates')
      .values({
        definition_id: p.definitionId,
        user_id: p.userId,
        organization_id: org,
        definition_name: p.definitionName,
        approval_requested_at: at,
        requires_approval: true,
      })
      .onConflict((oc) =>
        oc.columns(['definition_id', 'user_id']).doUpdateSet({
          approval_requested_at: sql`least(fact_certification_candidates.approval_requested_at, excluded.approval_requested_at)`,
          requires_approval: true,
        }),
      )
      .execute();
  }

  async certificateIssued(trx: Trx, e: Envelope<'certificate.issued'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const issuedAt = new Date(p.issuedAt);
    await this.certification(trx, org, p.definitionId, p.definitionName);
    await trx
      .insertInto('fact_certificates')
      .values({
        certificate_id: p.certificateId,
        organization_id: org,
        user_id: p.userId,
        definition_id: p.definitionId,
        definition_name: p.definitionName,
        certificate_number: p.certificateNumber,
        mode: p.mode,
        status: 'issued',
        status_at: issuedAt,
        issued_at: issuedAt,
        expires_at: ts(p.expiresAt),
      })
      .onConflict((oc) =>
        oc.column('certificate_id').doUpdateSet({
          certificate_number: sql`excluded.certificate_number`,
          mode: sql`excluded.mode`,
          definition_name: sql`excluded.definition_name`,
          issued_at: sql`excluded.issued_at`,
          expires_at: sql`excluded.expires_at`,
          status: sql`case when fact_certificates.status_at <= excluded.status_at then 'issued' else fact_certificates.status end`,
          status_at: sql`greatest(fact_certificates.status_at, excluded.status_at)`,
        }),
      )
      .execute();
    await trx
      .insertInto('fact_certification_candidates')
      .values({
        definition_id: p.definitionId,
        user_id: p.userId,
        organization_id: org,
        definition_name: p.definitionName,
        first_issued_at: issuedAt,
      })
      .onConflict((oc) =>
        oc.columns(['definition_id', 'user_id']).doUpdateSet({
          first_issued_at: sql`least(fact_certification_candidates.first_issued_at, excluded.first_issued_at)`,
        }),
      )
      .execute();
    await this.feed(trx, {
      id: stableId('certificate_issued', p.certificateId),
      organization_id: org,
      user_id: p.userId,
      occurred_at: issuedAt,
      kind: 'certificate_issued',
      title: p.definitionName,
    });
    await this.markDirty(trx, org, [issuedAt]);
  }

  async certificateRevoked(trx: Trx, e: Envelope<'certificate.revoked'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const at = new Date(e.occurredAt);
    await this.certificateTransition(trx, org, p, 'revoked', at, { revoked_at: at, revoke_reason: p.reason, certificate_number: p.certificateNumber });
    await this.feed(trx, {
      id: stableId('certificate_revoked', p.certificateId),
      organization_id: org,
      user_id: p.userId,
      occurred_at: at,
      kind: 'certificate_revoked',
      title: p.definitionName,
    });
  }

  async certificateExpired(trx: Trx, e: Envelope<'certificate.expired'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const at = new Date(p.expiredAt);
    await this.certificateTransition(trx, org, p, 'expired', at, { expired_at: at });
    await this.feed(trx, {
      id: stableId('certificate_expired', p.certificateId),
      organization_id: org,
      user_id: p.userId,
      occurred_at: at,
      kind: 'certificate_expired',
      title: p.definitionName,
    });
  }

  async certificateReissued(trx: Trx, e: Envelope<'certificate.reissued'>): Promise<void> {
    const org = e.organizationId;
    if (!org) return;
    const p = e.payload;
    const at = new Date(e.occurredAt);
    await this.certification(trx, org, p.definitionId, p.definitionName);
    await trx
      .insertInto('fact_certificates')
      .values({
        certificate_id: p.certificateId,
        organization_id: org,
        user_id: p.userId,
        definition_id: p.definitionId,
        definition_name: p.definitionName,
        status: 'issued',
        status_at: at,
        replaces_certificate_id: p.originalCertificateId,
      })
      .onConflict((oc) => oc.column('certificate_id').doUpdateSet({ replaces_certificate_id: sql`excluded.replaces_certificate_id` }))
      .execute();
    await this.certificateTransition(
      trx,
      org,
      { ...p, certificateId: p.originalCertificateId },
      'superseded',
      at,
      { superseded_at: at },
    );
  }

  // ---------------------------------------------------------------- helpers

  private async certificateTransition(
    trx: Trx,
    org: string,
    p: { certificateId: string; userId: string; definitionId: string; definitionName: string },
    status: 'revoked' | 'expired' | 'superseded',
    at: Date,
    extra: { revoked_at?: Date; revoke_reason?: string; expired_at?: Date; superseded_at?: Date; certificate_number?: string },
  ): Promise<void> {
    await this.certification(trx, org, p.definitionId, p.definitionName);
    await trx
      .insertInto('fact_certificates')
      .values({
        certificate_id: p.certificateId,
        organization_id: org,
        user_id: p.userId,
        definition_id: p.definitionId,
        definition_name: p.definitionName,
        status,
        status_at: at,
        ...extra,
      })
      .onConflict((oc) =>
        oc.column('certificate_id').doUpdateSet({
          status: sql`case when fact_certificates.status_at <= excluded.status_at then excluded.status else fact_certificates.status end`,
          status_at: sql`greatest(fact_certificates.status_at, excluded.status_at)`,
          revoked_at: sql`coalesce(fact_certificates.revoked_at, excluded.revoked_at)`,
          revoke_reason: sql`coalesce(fact_certificates.revoke_reason, excluded.revoke_reason)`,
          expired_at: sql`coalesce(fact_certificates.expired_at, excluded.expired_at)`,
          superseded_at: sql`coalesce(fact_certificates.superseded_at, excluded.superseded_at)`,
          certificate_number: sql`coalesce(fact_certificates.certificate_number, excluded.certificate_number)`,
        }),
      )
      .execute();
  }

  private async certification(trx: Trx, org: string, id: string, name: string): Promise<void> {
    await trx
      .insertInto('dim_certifications')
      .values({ id, organization_id: org, name })
      .onConflict((oc) => oc.column('id').doUpdateSet({ name: sql`excluded.name` }))
      .execute();
  }

  /** Creates a placeholder enrollment when facts arrive before `program.enrolled`. */
  private async ensureEnrollment(trx: Trx, org: string, ref: EnrollmentRef, at: Date, activityAt: Date | null): Promise<void> {
    await trx
      .insertInto('fact_enrollments')
      .values({
        enrollment_id: ref.enrollmentId,
        organization_id: org,
        user_id: ref.userId,
        program_id: ref.programId,
        status: 'active',
        first_seen_at: at,
        last_activity_at: activityAt,
        progress_percent: 0,
        required_completed: 0,
        overdue: false,
      })
      .onConflict((oc) =>
        oc.column('enrollment_id').doUpdateSet({
          first_seen_at: sql`least(fact_enrollments.first_seen_at, excluded.first_seen_at)`,
          last_activity_at: sql`greatest(fact_enrollments.last_activity_at, excluded.last_activity_at)`,
        }),
      )
      .execute();
  }

  private async touchLearner(trx: Trx, org: string, userId: string, at: Date): Promise<void> {
    await trx
      .insertInto('learner_activity')
      .values({ user_id: userId, organization_id: org, first_activity_at: at, last_activity_at: at })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({
          first_activity_at: sql`least(learner_activity.first_activity_at, excluded.first_activity_at)`,
          last_activity_at: sql`greatest(learner_activity.last_activity_at, excluded.last_activity_at)`,
        }),
      )
      .execute();
  }

  /**
   * Feed rows are keyed by the fact they describe. `earliest` keeps the first occurrence (repeat
   * completions), `replace` overwrites with the newest grading (overrides, re-evaluations).
   */
  private async feed(
    trx: Trx,
    row: {
      id: string;
      organization_id: string;
      user_id: string;
      occurred_at: Date;
      kind: string;
      title: string;
      program_id?: string | null;
      score?: number | null;
      passed?: boolean | null;
    },
    mode: 'keep' | 'earliest' | 'replace' = 'keep',
  ): Promise<void> {
    const values = { program_id: null, score: null, passed: null, ...row };
    const query = trx.insertInto('fact_activity').values(values);
    if (mode === 'keep') {
      await query.onConflict((oc) => oc.column('id').doNothing()).execute();
    } else if (mode === 'earliest') {
      await query
        .onConflict((oc) => oc.column('id').doUpdateSet({ occurred_at: sql`least(fact_activity.occurred_at, excluded.occurred_at)` }))
        .execute();
    } else {
      await query
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            occurred_at: sql`excluded.occurred_at`,
            kind: sql`excluded.kind`,
            title: sql`excluded.title`,
            score: sql`excluded.score`,
            passed: sql`excluded.passed`,
          }),
        )
        .execute();
    }
  }

  /** Flags calendar days whose rollups must be recomputed. */
  private async markDirty(trx: Trx, org: string, times: Array<Date | null>): Promise<void> {
    const valid = times.filter((t): t is Date => t instanceof Date && !Number.isNaN(t.getTime()));
    if (!valid.length) return;
    await sql`
      insert into rollup_dirty_days (organization_id, date)
      select distinct ${org}::uuid, (t at time zone ${this.options.timezone})::date
      from unnest(${sql.val(valid.map((d) => d.toISOString()))}::timestamptz[]) as t
      on conflict (organization_id, date) do update set marked_at = now()
    `.execute(trx);
  }
}
