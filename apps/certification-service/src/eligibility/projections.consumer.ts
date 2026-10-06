import { Inject, Injectable } from '@nestjs/common';
import { jsonb } from '../common/jsonb.js';
import { sql } from '@a5/database';
import {
  aiEvents,
  assessmentEvents,
  learningEvents,
  type EventEnvelope,
  type EventPayload,
} from '@a5/events';
import { processOnce } from '@a5/messaging';
import { InjectDb, LOGGER, OnEvent } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import type { Db, Trx } from '../database/index.js';
import { markDirty } from './dirty.js';
import { EligibilityService } from './eligibility.service.js';

/**
 * Fact projections fed by learning, assessment and AI events. Every handler applies its effect
 * exactly once (inbox), tolerates reordering (timestamp/version guards), marks the affected
 * (certification, person) pairs for evaluation in the same transaction and then evaluates them.
 */
@Injectable()
export class ProjectionsConsumer {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly eligibility: EligibilityService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Route an envelope to its handler (used by tests and replays). */
  async dispatch(event: EventEnvelope): Promise<void> {
    switch (event.type) {
      case learningEvents.programPublished.type:
        return this.onProgramPublished(event);
      case learningEvents.programArchived.type:
        return this.onProgramArchived(event);
      case learningEvents.enrolled.type:
        return this.onEnrolled(event);
      case learningEvents.enrollmentProgressed.type:
        return this.onProgressed(event);
      case learningEvents.enrollmentWithdrawn.type:
        return this.onWithdrawn(event);
      case learningEvents.programCompleted.type:
        return this.onProgramCompleted(event);
      case learningEvents.lessonCompleted.type:
        return this.onLessonCompleted(event);
      case learningEvents.phaseCompleted.type:
        return this.onPhaseCompleted(event);
      case assessmentEvents.attemptGraded.type:
        return this.onAttemptGraded(event);
      case aiEvents.scoreGenerated.type:
        return this.onScoreGenerated(event);
      default:
        this.logger.debug({ type: event.type }, 'certification ignores event type');
    }
  }

  private async organizationOf(event: EventEnvelope, userId: string): Promise<string | null> {
    if (event.organizationId) return event.organizationId;
    const user = await this.db
      .selectFrom('dir_users')
      .select('organization_id')
      .where('id', '=', userId)
      .executeTakeFirst();
    return user?.organization_id ?? null;
  }

  /** Apply a learner fact and evaluate that learner's certifications. */
  private async learnerFact(
    event: EventEnvelope,
    handler: string,
    userId: string,
    apply: (trx: Trx, organizationId: string) => Promise<void>,
  ) {
    const organizationId = await this.organizationOf(event, userId);
    if (!organizationId) {
      this.logger.warn(
        { eventId: event.id, type: event.type, userId },
        'event without a known organization; skipped',
      );
      return;
    }
    await processOnce(this.db, handler, event, async (trx) => {
      await apply(trx, organizationId);
      await markDirty(trx, { organizationId, userIds: [userId], learnerActivity: true });
    });
    await this.eligibility.processDirty({ userId });
  }

  @OnEvent(learningEvents.programPublished)
  async onProgramPublished(event: EventEnvelope) {
    const p = event.payload as EventPayload<'program.published'>;
    const applied = await processOnce(
      this.db,
      'certification.program.published',
      event,
      async (trx) => {
        const current = await trx
          .selectFrom('program_catalog')
          .select('version')
          .where('program_id', '=', p.programId)
          .forUpdate()
          .executeTakeFirst();
        if (current && current.version >= p.version) return;
        await trx
          .insertInto('program_catalog')
          .values({
            program_id: p.programId,
            organization_id: event.organizationId,
            title: p.title,
            version: p.version,
            phases: jsonb(p.phases),
            archived: false,
          })
          .onConflict((oc) =>
            oc.column('program_id').doUpdateSet((eb) => ({
              title: eb.ref('excluded.title'),
              version: eb.ref('excluded.version'),
              phases: eb.ref('excluded.phases'),
              organization_id: sql`coalesce(excluded.organization_id, program_catalog.organization_id)`,
            })),
          )
          .execute();
        await trx.deleteFrom('program_assessments').where('program_id', '=', p.programId).execute();
        if (p.assessments.length) {
          await trx
            .insertInto('program_assessments')
            .values(
              p.assessments.map((a) => ({
                program_id: p.programId,
                assessment_id: a.assessmentId,
                lesson_id: a.lessonId,
                kind: a.kind,
                required: a.required,
                title: a.title,
              })),
            )
            .onConflict((oc) => oc.columns(['program_id', 'assessment_id']).doNothing())
            .execute();
        }
        // Re-evaluate everyone whose requirements may reference this program.
        await sql`
        insert into eligibility_dirty (definition_id, user_id, organization_id, marked_at, learner_activity)
        select d.id, x.user_id, d.organization_id, clock_timestamp(), false
        from certification_definitions d
        join lateral (
          select c.user_id from certification_candidates c where c.definition_id = d.id and c.status <> 'issued'
          union
          select s.user_id from learner_program_status s where s.program_id = ${p.programId} and s.organization_id = d.organization_id
        ) x on true
        where d.status = 'active'
          and (exists (select 1 from certification_programs cp where cp.definition_id = d.id and cp.program_id = ${p.programId})
               or d.eligibility_rule::text like ${`%${p.programId}%`}
               or d.renewal_policy::text like ${`%${p.programId}%`})
        on conflict (definition_id, user_id) do update set marked_at = excluded.marked_at
      `.execute(trx);
      },
    );
    if (applied) await this.eligibility.processDirty({ limit: 500 });
  }

  @OnEvent(learningEvents.programArchived)
  async onProgramArchived(event: EventEnvelope) {
    const p = event.payload as EventPayload<'program.archived'>;
    await processOnce(this.db, 'certification.program.archived', event, async (trx) => {
      await trx
        .updateTable('program_catalog')
        .set({ archived: true })
        .where('program_id', '=', p.programId)
        .execute();
    });
  }

  @OnEvent(learningEvents.enrolled)
  async onEnrolled(event: EventEnvelope) {
    const p = event.payload as EventPayload<'program.enrolled'>;
    const at = new Date(event.occurredAt);
    await this.learnerFact(
      event,
      'certification.program.enrolled',
      p.userId,
      async (trx, organizationId) => {
        await trx
          .insertInto('learner_program_status')
          .values({
            user_id: p.userId,
            program_id: p.programId,
            organization_id: organizationId,
            enrollment_id: p.enrollmentId,
            status: 'enrolled',
            progress_percent: 0,
            enrolled_at: at,
            completed_at: null,
            source_occurred_at: at,
          })
          .onConflict((oc) =>
            oc
              .columns(['user_id', 'program_id'])
              .doUpdateSet({
                enrollment_id: sql`excluded.enrollment_id`,
                enrolled_at: sql`excluded.enrolled_at`,
                status: sql`case when learner_program_status.status = 'withdrawn' then 'enrolled' else learner_program_status.status end`,
                source_occurred_at: sql`excluded.source_occurred_at`,
              })
              .where('learner_program_status.source_occurred_at', '<=', at),
          )
          .execute();
      },
    );
  }

  @OnEvent(learningEvents.enrollmentProgressed)
  async onProgressed(event: EventEnvelope) {
    const p = event.payload as EventPayload<'enrollment.progressed'>;
    const at = new Date(event.occurredAt);
    await this.learnerFact(
      event,
      'certification.enrollment.progressed',
      p.userId,
      async (trx, organizationId) => {
        await trx
          .insertInto('learner_program_status')
          .values({
            user_id: p.userId,
            program_id: p.programId,
            organization_id: organizationId,
            enrollment_id: p.enrollmentId,
            status: p.progressPercent >= 100 ? 'completed' : 'enrolled',
            progress_percent: Math.min(100, Math.max(0, p.progressPercent)),
            enrolled_at: null,
            completed_at: p.progressPercent >= 100 ? at : null,
            source_occurred_at: at,
          })
          .onConflict((oc) =>
            oc
              .columns(['user_id', 'program_id'])
              .doUpdateSet({
                progress_percent: sql`excluded.progress_percent`,
                enrollment_id: sql`excluded.enrollment_id`,
                // Completion is an achievement: later progress events never undo it.
                status: sql`case when learner_program_status.status = 'completed' then 'completed' else excluded.status end`,
                completed_at: sql`coalesce(learner_program_status.completed_at, excluded.completed_at)`,
                source_occurred_at: sql`excluded.source_occurred_at`,
              })
              .where('learner_program_status.source_occurred_at', '<=', at)
              .where('learner_program_status.status', '<>', 'withdrawn'),
          )
          .execute();
      },
    );
  }

  @OnEvent(learningEvents.enrollmentWithdrawn)
  async onWithdrawn(event: EventEnvelope) {
    const p = event.payload as EventPayload<'enrollment.withdrawn'>;
    const at = new Date(event.occurredAt);
    await this.learnerFact(event, 'certification.enrollment.withdrawn', p.userId, async (trx) => {
      await trx
        .updateTable('learner_program_status')
        .set({ status: 'withdrawn', source_occurred_at: at })
        .where('user_id', '=', p.userId)
        .where('program_id', '=', p.programId)
        .where('source_occurred_at', '<=', at)
        .execute();
    });
  }

  @OnEvent(learningEvents.programCompleted)
  async onProgramCompleted(event: EventEnvelope) {
    const p = event.payload as EventPayload<'program.completed'>;
    const at = new Date(event.occurredAt);
    const completedAt = new Date(p.completedAt);
    await this.learnerFact(
      event,
      'certification.program.completed',
      p.userId,
      async (trx, organizationId) => {
        await trx
          .insertInto('learner_program_status')
          .values({
            user_id: p.userId,
            program_id: p.programId,
            organization_id: organizationId,
            enrollment_id: p.enrollmentId,
            status: 'completed',
            progress_percent: 100,
            enrolled_at: null,
            completed_at: completedAt,
            source_occurred_at: at,
          })
          .onConflict((oc) =>
            oc
              .columns(['user_id', 'program_id'])
              .doUpdateSet({
                status: sql`'completed'`,
                progress_percent: sql`100`,
                completed_at: sql`coalesce(learner_program_status.completed_at, excluded.completed_at)`,
                enrollment_id: sql`excluded.enrollment_id`,
                source_occurred_at: sql`greatest(learner_program_status.source_occurred_at, excluded.source_occurred_at)`,
              })
              .where('learner_program_status.status', '<>', 'withdrawn'),
          )
          .execute();
      },
    );
  }

  @OnEvent(learningEvents.lessonCompleted)
  async onLessonCompleted(event: EventEnvelope) {
    const p = event.payload as EventPayload<'lesson.completed'>;
    await this.learnerFact(event, 'certification.lesson.completed', p.userId, async (trx) => {
      await trx
        .insertInto('learner_milestones')
        .values({
          user_id: p.userId,
          kind: 'lesson',
          ref_id: p.lessonId,
          program_id: p.programId,
          title: p.lessonTitle,
          completed_at: new Date(p.completedAt),
        })
        .onConflict((oc) => oc.columns(['user_id', 'kind', 'ref_id']).doNothing())
        .execute();
    });
  }

  @OnEvent(learningEvents.phaseCompleted)
  async onPhaseCompleted(event: EventEnvelope) {
    const p = event.payload as EventPayload<'phase.completed'>;
    await this.learnerFact(event, 'certification.phase.completed', p.userId, async (trx) => {
      await trx
        .insertInto('learner_milestones')
        .values({
          user_id: p.userId,
          kind: 'phase',
          ref_id: p.phaseId,
          program_id: p.programId,
          title: p.phaseTitle,
          completed_at: new Date(p.completedAt),
        })
        .onConflict((oc) => oc.columns(['user_id', 'kind', 'ref_id']).doNothing())
        .execute();
    });
  }

  /** One row per attempt; a re-grade (score override) replaces the attempt's score when newer. */
  @OnEvent(assessmentEvents.attemptGraded)
  async onAttemptGraded(event: EventEnvelope) {
    const p = event.payload as EventPayload<'assessment.attempt.graded'>;
    const gradedAt = new Date(p.gradedAt);
    await this.learnerFact(
      event,
      'certification.assessment.graded',
      p.userId,
      async (trx, organizationId) => {
        await trx
          .insertInto('learner_assessment_results')
          .values({
            attempt_id: p.attemptId,
            user_id: p.userId,
            organization_id: organizationId,
            assessment_id: p.assessmentId,
            kind: p.kind,
            title: p.assessmentTitle,
            score_percent: p.scorePercent,
            passed: p.passed,
            program_id: p.context.programId ?? null,
            graded_at: gradedAt,
          })
          .onConflict((oc) =>
            oc
              .column('attempt_id')
              .doUpdateSet({
                score_percent: sql`excluded.score_percent`,
                passed: sql`excluded.passed`,
                title: sql`excluded.title`,
                graded_at: sql`excluded.graded_at`,
              })
              .where('learner_assessment_results.graded_at', '<', gradedAt),
          )
          .execute();
      },
    );
  }

  @OnEvent(aiEvents.scoreGenerated)
  async onScoreGenerated(event: EventEnvelope) {
    const p = event.payload as EventPayload<'ai.score.generated'>;
    const evaluatedAt = new Date(p.evaluatedAt);
    await this.learnerFact(
      event,
      'certification.ai.score',
      p.userId,
      async (trx, organizationId) => {
        await trx
          .insertInto('learner_ai_results')
          .values({
            session_id: p.sessionId,
            user_id: p.userId,
            organization_id: organizationId,
            scenario_id: p.scenarioId,
            scenario_title: p.scenarioTitle,
            overall_score: p.overallScore,
            passed: p.passed,
            program_id: p.context.programId ?? null,
            evaluated_at: evaluatedAt,
          })
          .onConflict((oc) =>
            oc
              .column('session_id')
              .doUpdateSet({
                overall_score: sql`excluded.overall_score`,
                passed: sql`excluded.passed`,
                scenario_title: sql`excluded.scenario_title`,
                evaluated_at: sql`excluded.evaluated_at`,
              })
              .where('learner_ai_results.evaluated_at', '<', evaluatedAt),
          )
          .execute();
      },
    );
  }
}
