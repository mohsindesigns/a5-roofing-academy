import { Inject, Injectable } from '@nestjs/common';
import type { learning } from '@a5/contracts';
import { sql } from '@a5/database';
import {
  aiEvents,
  assessmentEvents,
  identityEvents,
  mediaEvents,
  type EventEnvelope,
  type EventPayload,
} from '@a5/events';
import { processOnce } from '@a5/messaging';
import { InjectDb, LOGGER, OnEvent } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { inAudience } from '../common/audience.js';
import type { Db, Trx } from '../database/index.js';
import type { EnrollmentRow } from '../engine/dto.js';
import { ProgressService } from '../engine/progress.service.js';
import { lessonIndex, ruleReferences, treeRules, type IndexedLesson, type ProgramTree } from '../engine/tree.js';
import { TreeService } from '../engine/tree.service.js';
import { EnrollmentsService } from '../enrollments/enrollments.service.js';
import { effectiveMinWatchPercent } from '../lesson-types/handlers/video.js';

interface Target {
  enrollment: EnrollmentRow;
  tree: ProgramTree;
  info: IndexedLesson;
}

const clampPercent = (n: number) => Math.max(0, Math.min(100, n));

/**
 * Consumes facts from media, assessment, AI and identity. Every handler runs inside
 * `processOnce`, so redelivered events have no effect, and every write is an upsert guarded by
 * timestamps or monotonic maxima, so out-of-order delivery is harmless.
 */
@Injectable()
export class LearningEventsConsumer {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly trees: TreeService,
    private readonly progress: ProgressService,
    private readonly enrollments: EnrollmentsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** The learner's enrollment (locked) and the published lesson an event refers to. */
  private async target(trx: Trx, userId: string, lessonId: string, organizationId: string | null): Promise<Target | null> {
    const lesson = await trx.selectFrom('lessons').select(['program_id', 'organization_id']).where('id', '=', lessonId).executeTakeFirst();
    if (!lesson || (organizationId && lesson.organization_id !== organizationId)) return null;
    const row = await trx.selectFrom('enrollments').select('id').where('program_id', '=', lesson.program_id).where('user_id', '=', userId).executeTakeFirst();
    if (!row) return null;
    const enrollment = await this.progress.lockEnrollment(trx, row.id);
    if (!enrollment || enrollment.status === 'withdrawn') return null;
    const tree = await this.trees.published(lesson.program_id, trx);
    const info = tree ? lessonIndex(tree).get(lessonId) : undefined;
    return tree && info ? { enrollment, tree, info } : null;
  }

  /**
   * New scores can unlock content (rules on assessment or AI scores): refresh the denormalised
   * progress of the learner's other enrollments whose rules depend on them.
   */
  private async refreshDependents(trx: Trx, userId: string, except: string | null, ref: { assessmentId?: string; scenarioId?: string }): Promise<void> {
    const rows = await trx
      .selectFrom('enrollments')
      .select(['id', 'program_id'])
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .orderBy('id')
      .execute();
    for (const row of rows) {
      if (row.id === except) continue;
      const tree = await this.trees.published(row.program_id, trx);
      if (!tree) continue;
      const refs = ruleReferences(treeRules(tree));
      const affected =
        (ref.assessmentId && (refs.assessmentIds.includes(ref.assessmentId) || refs.ruleTypes.has('program_assessments_score'))) ||
        (ref.scenarioId && (refs.scenarioIds.includes(ref.scenarioId) || refs.ruleTypes.has('ai_sessions_count') || refs.ruleTypes.has('ai_average_score')));
      if (!affected) continue;
      const enrollment = await this.progress.lockEnrollment(trx, row.id);
      if (enrollment) await this.progress.sync(trx, enrollment, tree);
    }
  }

  // ---------------------------------------------------------------- media

  @OnEvent(mediaEvents.videoProgressed)
  async onVideoProgressed(event: EventEnvelope): Promise<void> {
    await this.onVideo(event, 'learning.video-progressed');
  }

  @OnEvent(mediaEvents.videoCompleted)
  async onVideoCompleted(event: EventEnvelope): Promise<void> {
    await this.onVideo(event, 'learning.video-completed');
  }

  private async onVideo(event: EventEnvelope, handler: string): Promise<void> {
    const payload = event.payload as EventPayload<'video.progressed'>;
    if (payload.contextType !== 'lesson') return;
    await processOnce(this.db, handler, event, async (trx) => {
      const target = await this.target(trx, payload.userId, payload.contextId, event.organizationId);
      if (!target || target.info.lesson.type !== 'video') return;
      const config = target.info.lesson.config as learning.VideoLessonConfig;
      if (config.mediaAssetId !== payload.assetId) {
        this.logger.info({ eventId: event.id, lessonId: payload.contextId }, 'ignoring watch progress for a video no longer used by the lesson');
        return;
      }
      const at = new Date(event.occurredAt);
      const watched = clampPercent(payload.watchedPercent);
      const { enrollment, tree } = target;
      if (config.completion === 'auto' && watched >= effectiveMinWatchPercent(config, tree.settings)) {
        await this.progress.completeLesson(trx, { enrollment, tree, lessonId: payload.contextId, source: 'video', at, data: { watchedPercent: watched } });
      } else {
        await this.progress.recordActivity(trx, { enrollment, tree, lessonId: payload.contextId, at, percent: watched, data: { watchedPercent: watched } });
      }
    });
  }

  // ---------------------------------------------------------------- assessment

  @OnEvent(assessmentEvents.attemptGraded)
  async onAttemptGraded(event: EventEnvelope): Promise<void> {
    const e = event.payload as EventPayload<'assessment.attempt.graded'>;
    await processOnce(this.db, 'learning.assessment-graded', event, async (trx) => {
      const gradedAt = new Date(e.gradedAt);
      // Per-attempt row: re-grades and overrides of the same attempt replace it (newest wins).
      await trx
        .insertInto('learner_assessment_attempts')
        .values({
          attempt_id: e.attemptId,
          organization_id: event.organizationId,
          user_id: e.userId,
          assessment_id: e.assessmentId,
          assessment_title: e.assessmentTitle,
          kind: e.kind,
          attempt_number: e.attemptNumber,
          score_percent: e.scorePercent,
          passed: e.passed,
          passing_percent: e.passingPercent,
          lesson_id: e.context.lessonId ?? null,
          graded_at: gradedAt,
        })
        .onConflict((oc) =>
          oc
            .column('attempt_id')
            .doUpdateSet((eb) => ({
              score_percent: eb.ref('excluded.score_percent'),
              passed: eb.ref('excluded.passed'),
              passing_percent: eb.ref('excluded.passing_percent'),
              assessment_title: eb.ref('excluded.assessment_title'),
              graded_at: eb.ref('excluded.graded_at'),
            }))
            .where('learner_assessment_attempts.graded_at', '<=', gradedAt),
        )
        .execute();
      await sql`
        insert into learner_assessment_scores
          (user_id, assessment_id, organization_id, assessment_title, kind, best_score, last_score, passed, attempts, last_attempt_at)
        select user_id, assessment_id,
          (array_agg(organization_id order by graded_at desc))[1],
          (array_agg(assessment_title order by graded_at desc))[1],
          (array_agg(kind order by graded_at desc))[1],
          max(score_percent),
          (array_agg(score_percent order by graded_at desc))[1],
          bool_or(passed),
          count(*),
          max(graded_at)
        from learner_assessment_attempts
        where user_id = ${e.userId} and assessment_id = ${e.assessmentId}
        group by user_id, assessment_id
        on conflict (user_id, assessment_id) do update set
          organization_id = excluded.organization_id,
          assessment_title = excluded.assessment_title,
          kind = excluded.kind,
          best_score = excluded.best_score,
          last_score = excluded.last_score,
          passed = excluded.passed,
          attempts = excluded.attempts,
          last_attempt_at = excluded.last_attempt_at
      `.execute(trx);

      let completedEnrollment: string | null = null;
      if (e.context.lessonId) {
        const target = await this.target(trx, e.userId, e.context.lessonId, event.organizationId);
        const config = target?.info.lesson.config as learning.AssessmentLessonConfig | undefined;
        if (target && (target.info.lesson.type === 'quiz' || target.info.lesson.type === 'final_assessment') && config?.assessmentId === e.assessmentId) {
          const { enrollment, tree } = target;
          const data = { attemptId: e.attemptId, lastScore: e.scorePercent, bestScore: e.scorePercent };
          if (e.passed) {
            await this.progress.completeLesson(trx, { enrollment, tree, lessonId: e.context.lessonId, source: 'assessment', at: gradedAt, data });
          } else {
            await this.progress.recordActivity(trx, { enrollment, tree, lessonId: e.context.lessonId, at: gradedAt, data });
            await this.progress.sync(trx, enrollment, tree);
          }
          completedEnrollment = enrollment.id;
        }
      }
      await this.refreshDependents(trx, e.userId, completedEnrollment, { assessmentId: e.assessmentId });
    });
  }

  // ---------------------------------------------------------------- AI coaching

  @OnEvent(aiEvents.scoreGenerated)
  async onAiScore(event: EventEnvelope): Promise<void> {
    const e = event.payload as EventPayload<'ai.score.generated'>;
    await processOnce(this.db, 'learning.ai-score', event, async (trx) => {
      const evaluatedAt = new Date(e.evaluatedAt);
      await trx
        .insertInto('learner_ai_sessions')
        .values({
          session_id: e.sessionId,
          organization_id: event.organizationId,
          user_id: e.userId,
          scenario_id: e.scenarioId,
          scenario_title: e.scenarioTitle,
          score: e.overallScore,
          passed: e.passed,
          passing_score: e.passingScore,
          lesson_id: e.context.lessonId ?? null,
          evaluated_at: evaluatedAt,
        })
        .onConflict((oc) =>
          oc
            .column('session_id')
            .doUpdateSet((eb) => ({
              score: eb.ref('excluded.score'),
              passed: eb.ref('excluded.passed'),
              passing_score: eb.ref('excluded.passing_score'),
              scenario_title: eb.ref('excluded.scenario_title'),
              evaluated_at: eb.ref('excluded.evaluated_at'),
            }))
            .where('learner_ai_sessions.evaluated_at', '<=', evaluatedAt),
        )
        .execute();
      await sql`
        insert into learner_ai_scores
          (user_id, scenario_id, organization_id, scenario_title, best_score, last_score, passed, sessions, last_session_at)
        select user_id, scenario_id,
          (array_agg(organization_id order by evaluated_at desc))[1],
          (array_agg(scenario_title order by evaluated_at desc))[1],
          max(score),
          (array_agg(score order by evaluated_at desc))[1],
          bool_or(passed),
          count(*),
          max(evaluated_at)
        from learner_ai_sessions
        where user_id = ${e.userId} and scenario_id = ${e.scenarioId}
        group by user_id, scenario_id
        on conflict (user_id, scenario_id) do update set
          organization_id = excluded.organization_id,
          scenario_title = excluded.scenario_title,
          best_score = excluded.best_score,
          last_score = excluded.last_score,
          passed = excluded.passed,
          sessions = excluded.sessions,
          last_session_at = excluded.last_session_at
      `.execute(trx);

      let touched: string | null = null;
      if (e.context.lessonId) {
        const target = await this.target(trx, e.userId, e.context.lessonId, event.organizationId);
        const config = target?.info.lesson.config as learning.AiSimulationLessonConfig | undefined;
        if (target && (target.info.lesson.type === 'ai_simulation' || target.info.lesson.type === 'scenario') && config?.scenarioId === e.scenarioId) {
          const { enrollment, tree } = target;
          const data = { sessionId: e.sessionId, lastScore: e.overallScore, bestScore: e.overallScore };
          if (e.overallScore >= config.minScore) {
            await this.progress.completeLesson(trx, { enrollment, tree, lessonId: e.context.lessonId, source: 'ai_score', at: evaluatedAt, data });
          } else {
            await this.progress.recordActivity(trx, { enrollment, tree, lessonId: e.context.lessonId, at: evaluatedAt, data });
            await this.progress.sync(trx, enrollment, tree);
          }
          touched = enrollment.id;
        }
      }
      await this.refreshDependents(trx, e.userId, touched, { scenarioId: e.scenarioId });
    });
  }

  // ---------------------------------------------------------------- identity (automatic enrollment)

  /**
   * Programs with "auto-enroll audience" switched on enroll matching people as soon as they appear
   * in (or move into) the audience. People who were enrolled before (including withdrawn) are left
   * alone so an administrator's withdrawal sticks.
   */
  @OnEvent(identityEvents.directoryUserUpserted)
  async onDirectoryUser(event: EventEnvelope): Promise<void> {
    const { user } = event.payload as EventPayload<'directory.user.upserted'>;
    if (user.status !== 'active' && user.status !== 'invited') return;
    await processOnce(this.db, 'learning.auto-enroll', event, async (trx) => {
      const programs = await trx
        .selectFrom('programs')
        .selectAll()
        .where('organization_id', '=', user.organizationId)
        .where('status', '=', 'published')
        .where(sql<boolean>`(settings->>'autoEnrollAudience')::boolean is true`)
        .where((eb) => eb.or([eb('availability_ends_at', 'is', null), eb('availability_ends_at', '>', new Date())]))
        .where('id', 'not in', trx.selectFrom('enrollments').select('program_id').where('user_id', '=', user.id))
        .execute();
      for (const program of programs) {
        const audiences = await trx.selectFrom('program_audiences').select(['kind', 'ref']).where('program_id', '=', program.id).execute();
        if (!inAudience(audiences, user)) continue;
        const tree = await this.trees.published(program.id, trx);
        if (!tree) continue;
        await this.enrollments.enrollUsers(trx, {
          program,
          tree,
          userIds: [user.id],
          source: 'rule',
          assignedBy: null,
          actorDisplay: 'Automatic enrollment',
        });
        this.logger.info({ programId: program.id, userId: user.id }, 'auto-enrolled by program audience');
      }
    });
  }
}
