import { Injectable } from '@nestjs/common';
import type { Selectable } from '@a5/database';
import type { learning } from '@a5/contracts';
import { learningEvents } from '@a5/events';
import { EventBus } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import type { ApprovalRequestsTable, LessonProgressData, Trx } from '../database/index.js';
import type { DbOrTrx } from '../database/index.js';
import type { EnrollmentRow, LessonProgressRow } from './dto.js';
import { FactsService } from './facts.service.js';
import { evaluateProgram, type LearnerFacts, type ProgramEval } from './progression.js';
import { lessonIndex, type IndexedLesson, type ProgramTree } from './tree.js';

export type ApprovalRow = Selectable<ApprovalRequestsTable>;

export interface SyncResult {
  enrollment: EnrollmentRow;
  ev: ProgramEval;
  facts: LearnerFacts;
  changed: boolean;
}

const clampPercent = (n: number) => Math.max(0, Math.min(100, Math.round(n * 100) / 100));

/** Merge progress details; scores and watch percentages only ever go up. */
function mergeData(current: LessonProgressData, incoming: LessonProgressData | undefined): LessonProgressData {
  if (!incoming) return current;
  const out: LessonProgressData = { ...current, ...incoming };
  for (const key of ['watchedPercent', 'bestScore'] as const) {
    const a = current[key];
    const b = incoming[key];
    if (typeof a === 'number' && typeof b === 'number') out[key] = Math.max(a, b);
  }
  return out;
}

/**
 * The progression core: records lesson activity and completion, keeps the enrollment's
 * denormalised progress in step and emits the resulting domain events — all inside the caller's
 * transaction. Every operation is idempotent so redelivered events are harmless.
 */
@Injectable()
export class ProgressService {
  constructor(
    private readonly events: EventBus,
    private readonly facts: FactsService,
  ) {}

  /** Lock an enrollment for the rest of the transaction (serializes progress updates per learner). */
  async lockEnrollment(trx: Trx, enrollmentId: string): Promise<EnrollmentRow | undefined> {
    return trx.selectFrom('enrollments').selectAll().where('id', '=', enrollmentId).forUpdate().executeTakeFirst();
  }

  async evaluate(db: DbOrTrx, tree: ProgramTree, enrollment: EnrollmentRow, now: Date = new Date()): Promise<{ facts: LearnerFacts; ev: ProgramEval }> {
    const facts = await this.facts.load(db, tree, { userId: enrollment.user_id, enrollment }, now);
    return { facts, ev: evaluateProgram(tree, facts) };
  }

  private ref(enrollment: EnrollmentRow) {
    return { enrollmentId: enrollment.id, programId: enrollment.program_id, userId: enrollment.user_id };
  }

  private emitOptions(enrollment: EnrollmentRow) {
    return { organizationId: enrollment.organization_id, subject: { type: 'enrollment', id: enrollment.id } };
  }

  private lesson(tree: ProgramTree, lessonId: string): IndexedLesson {
    const info = lessonIndex(tree).get(lessonId);
    if (!info) throw new Error(`Lesson ${lessonId} is not part of published program ${tree.programId}`);
    return info;
  }

  private async progressRow(trx: Trx, enrollmentId: string, lessonId: string): Promise<LessonProgressRow | undefined> {
    return trx
      .selectFrom('lesson_progress')
      .selectAll()
      .where('enrollment_id', '=', enrollmentId)
      .where('lesson_id', '=', lessonId)
      .executeTakeFirst();
  }

  /**
   * Record that the learner worked on a lesson without completing it (opened it, watched part of
   * a video, failed an attempt). Emits lesson.started the first time.
   */
  async recordActivity(
    trx: Trx,
    input: { enrollment: EnrollmentRow; tree: ProgramTree; lessonId: string; at?: Date; percent?: number; data?: LessonProgressData },
  ): Promise<{ started: boolean; progress: LessonProgressRow }> {
    const at = input.at ?? new Date();
    const { lesson } = this.lesson(input.tree, input.lessonId);
    const existing = await this.progressRow(trx, input.enrollment.id, lesson.id);
    let progress: LessonProgressRow;
    let started = false;
    if (!existing) {
      progress = await trx
        .insertInto('lesson_progress')
        .values({
          id: uuidv7(),
          enrollment_id: input.enrollment.id,
          lesson_id: lesson.id,
          user_id: input.enrollment.user_id,
          status: 'in_progress',
          percent: clampPercent(input.percent ?? 0),
          started_at: at,
          completed_at: null,
          completion_source: null,
          completed_by: null,
          data: input.data ?? {},
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      started = true;
      await this.events.emit(
        trx,
        learningEvents.lessonStarted,
        { ...this.ref(input.enrollment), lessonId: lesson.id, lessonType: lesson.type },
        this.emitOptions(input.enrollment),
      );
    } else {
      const data = mergeData(existing.data ?? {}, input.data);
      const percent = existing.status === 'completed' ? 100 : Math.max(Number(existing.percent), clampPercent(input.percent ?? 0));
      progress = await trx
        .updateTable('lesson_progress')
        .set({
          status: existing.status === 'completed' ? 'completed' : 'in_progress',
          percent,
          data,
          started_at: existing.started_at ?? at,
        })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    await trx
      .updateTable('enrollments')
      .set((eb) => ({
        started_at: eb.fn.coalesce('started_at', eb.val(at)),
        last_activity_at: eb.fn('greatest', [eb.fn.coalesce('last_activity_at', eb.val(at)), eb.val(at)]),
      }))
      .where('id', '=', input.enrollment.id)
      .execute();
    return { started, progress };
  }

  /**
   * Complete a lesson. Returns `changed: false` when it was already complete (idempotent), in
   * which case nothing is written and no events are emitted.
   */
  async completeLesson(
    trx: Trx,
    input: {
      enrollment: EnrollmentRow;
      tree: ProgramTree;
      lessonId: string;
      source: learning.CompletionSource;
      at?: Date;
      completedBy?: string | null;
      data?: LessonProgressData;
    },
  ): Promise<{ changed: boolean; progress: LessonProgressRow; sync: SyncResult | null }> {
    const at = input.at ?? new Date();
    const { lesson, module, phase } = this.lesson(input.tree, input.lessonId);
    const existing = await this.progressRow(trx, input.enrollment.id, lesson.id);
    if (existing?.status === 'completed') return { changed: false, progress: existing, sync: null };

    const values = {
      status: 'completed' as const,
      percent: 100,
      completed_at: at,
      completion_source: input.source,
      completed_by: input.completedBy ?? null,
    };
    const progress = existing
      ? await trx
          .updateTable('lesson_progress')
          .set({ ...values, started_at: existing.started_at ?? at, data: mergeData(existing.data ?? {}, input.data) })
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto('lesson_progress')
          .values({
            id: uuidv7(),
            enrollment_id: input.enrollment.id,
            lesson_id: lesson.id,
            user_id: input.enrollment.user_id,
            started_at: at,
            data: input.data ?? {},
            ...values,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
    // A lesson finished without an explicit start (graded attempt, manager override) still starts first.
    if (!existing) {
      await this.events.emit(
        trx,
        learningEvents.lessonStarted,
        { ...this.ref(input.enrollment), lessonId: lesson.id, lessonType: lesson.type },
        this.emitOptions(input.enrollment),
      );
    }

    await this.events.emit(
      trx,
      learningEvents.lessonCompleted,
      {
        ...this.ref(input.enrollment),
        phaseId: phase.id,
        moduleId: module.id,
        lessonId: lesson.id,
        lessonType: lesson.type,
        lessonTitle: lesson.title,
        required: lesson.isRequired,
        source: input.source,
        completedAt: at.toISOString(),
      },
      this.emitOptions(input.enrollment),
    );
    const sync = await this.sync(trx, input.enrollment, input.tree, { at, activity: true, forceProgressEvent: true });
    return { changed: true, progress, sync };
  }

  /**
   * Recompute the enrollment's denormalised progress from the facts and emit what changed:
   * enrollment.progressed, phase.completed (exactly once per phase), program.completed (on the
   * transition to completed) and approval.requested for manager sign-offs the learner reached.
   */
  async sync(
    trx: Trx,
    enrollment: EnrollmentRow,
    tree: ProgramTree,
    opts: { at?: Date; activity?: boolean; forceProgressEvent?: boolean } = {},
  ): Promise<SyncResult> {
    const at = opts.at ?? new Date();
    const { facts, ev } = await this.evaluate(trx, tree, enrollment);
    const active = enrollment.status !== 'withdrawn';

    if (active) {
      for (const phase of ev.phases) {
        if (!phase.complete || facts.phaseCompletedAt.has(phase.phase.id)) continue;
        const inserted = await trx
          .insertInto('phase_completions')
          .values({ enrollment_id: enrollment.id, phase_id: phase.phase.id, completed_at: at })
          .onConflict((oc) => oc.columns(['enrollment_id', 'phase_id']).doNothing())
          .executeTakeFirst();
        if ((inserted.numInsertedOrUpdatedRows ?? 0n) > 0n) {
          facts.phaseCompletedAt.set(phase.phase.id, at);
          phase.completedAt = at;
          await this.events.emit(
            trx,
            learningEvents.phaseCompleted,
            { ...this.ref(enrollment), phaseId: phase.phase.id, phaseTitle: phase.phase.title, completedAt: at.toISOString() },
            this.emitOptions(enrollment),
          );
        }
      }
    }

    const completesNow = active && ev.complete && enrollment.status === 'active';
    const next = {
      progress_percent: ev.percent,
      required_total: ev.requiredTotal,
      required_completed: ev.requiredCompleted,
      current_lesson_id: ev.currentLesson?.lesson.id ?? null,
      current_phase_id: ev.currentPhase?.phase.id ?? null,
    };
    const changed =
      Number(enrollment.progress_percent) !== next.progress_percent ||
      enrollment.required_total !== next.required_total ||
      enrollment.required_completed !== next.required_completed ||
      enrollment.current_lesson_id !== next.current_lesson_id ||
      enrollment.current_phase_id !== next.current_phase_id ||
      completesNow;

    const updated = await trx
      .updateTable('enrollments')
      .set((eb) => ({
        ...next,
        ...(completesNow ? { status: 'completed' as const, completed_at: at } : {}),
        ...(opts.activity
          ? {
              started_at: eb.fn.coalesce('started_at', eb.val(at)),
              last_activity_at: eb.fn('greatest', [eb.fn.coalesce('last_activity_at', eb.val(at)), eb.val(at)]),
            }
          : {}),
      }))
      .where('id', '=', enrollment.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (active && (changed || opts.forceProgressEvent)) {
      await this.events.emit(
        trx,
        learningEvents.enrollmentProgressed,
        {
          ...this.ref(enrollment),
          progressPercent: ev.percent,
          requiredCompleted: ev.requiredCompleted,
          requiredTotal: ev.requiredTotal,
          currentPhaseId: next.current_phase_id,
        },
        this.emitOptions(enrollment),
      );
    }
    if (completesNow) {
      await this.events.emit(
        trx,
        learningEvents.programCompleted,
        { ...this.ref(enrollment), programTitle: tree.title, completedAt: at.toISOString() },
        this.emitOptions(enrollment),
      );
    }

    if (active) {
      const reached = ev.ordered.filter((l) => l.lesson.type === 'manager_approval' && !l.completed && l.state !== 'locked');
      if (reached.length) {
        const existing = await trx
          .selectFrom('approval_requests')
          .select('lesson_id')
          .where('enrollment_id', '=', enrollment.id)
          .where(
            'lesson_id',
            'in',
            reached.map((l) => l.lesson.id),
          )
          .execute();
        const opened = new Set(existing.map((r) => r.lesson_id));
        for (const l of reached) {
          if (!opened.has(l.lesson.id)) {
            await this.openApproval(trx, { kind: 'manager_approval', enrollment: updated, tree, lessonId: l.lesson.id, at });
          }
        }
      }
    }
    return { enrollment: updated, ev, facts, changed };
  }

  /** Open an approval request (one pending per learner and lesson) and notify approvers. */
  async openApproval(
    trx: Trx,
    input: {
      kind: learning.ApprovalKind;
      enrollment: EnrollmentRow;
      tree: ProgramTree;
      lessonId: string;
      submissionId?: string | null;
      note?: string | null;
      at?: Date;
    },
  ): Promise<ApprovalRow> {
    const { lesson } = this.lesson(input.tree, input.lessonId);
    const approval = await trx
      .insertInto('approval_requests')
      .values({
        id: uuidv7(),
        organization_id: input.enrollment.organization_id,
        kind: input.kind,
        status: 'pending',
        enrollment_id: input.enrollment.id,
        program_id: input.enrollment.program_id,
        lesson_id: lesson.id,
        user_id: input.enrollment.user_id,
        submission_id: input.submissionId ?? null,
        request_note: input.note ?? null,
        requested_at: input.at ?? new Date(),
        decided_by: null,
        decided_by_name: null,
        decided_at: null,
        comment: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.events.emit(
      trx,
      learningEvents.approvalRequested,
      {
        ...this.ref(input.enrollment),
        approvalId: approval.id,
        lessonId: lesson.id,
        lessonTitle: lesson.title,
        programTitle: input.tree.title,
        kind: input.kind,
      },
      { organizationId: input.enrollment.organization_id, subject: { type: 'approval', id: approval.id } },
    );
    return approval;
  }
}
