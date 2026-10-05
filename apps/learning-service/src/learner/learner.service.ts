import { Inject, Injectable } from '@nestjs/common';
import { signLessonGrant, type Principal } from '@a5/auth';
import type { learning } from '@a5/contracts';
import { sql, type Selectable } from '@a5/database';
import { DirectoryReader } from '@a5/directory';
import { ConflictError, EventBus, InjectDb, NotFoundError, PreconditionError } from '@a5/nest-kit';
import { getContext, uuidv7 } from '@a5/observability';
import { inAudience } from '../common/audience.js';
import { displayNames, personRef } from '../common/people.js';
import { sha256 } from '../common/text.js';
import { LEARNING_CONFIG, type LearningConfig } from '../config.js';
import type { AcknowledgmentsTable, AssignmentSubmissionsTable, Db, LessonNotesTable, Trx } from '../database/index.js';
import { enrollmentProgressDto, iso, lessonProgressDto, type EnrollmentRow, type LessonProgressRow } from '../engine/dto.js';
import { ProgressService } from '../engine/progress.service.js';
import { toOutline, type LessonEval, type ProgramEval } from '../engine/progression.js';
import { lessonIndex, orderedLessons, phaseRef, type IndexedLesson, type ProgramTree } from '../engine/tree.js';
import { TreeService } from '../engine/tree.service.js';
import { EnrollmentsService } from '../enrollments/enrollments.service.js';
import { normalizeName } from '../lesson-types/handlers/acknowledgment.js';
import { countWords } from '../lesson-types/handlers/assignment.js';
import { lessonTypes } from '../lesson-types/registry.js';
import type { ProgressView } from '../lesson-types/types.js';

type NoteRow = Selectable<LessonNotesTable>;
type SubmissionRow = Selectable<AssignmentSubmissionsTable>;
type AckRow = Selectable<AcknowledgmentsTable>;

interface OwnLesson {
  enrollment: EnrollmentRow;
  tree: ProgramTree;
  info: IndexedLesson;
}

function noteDto(n: NoteRow): learning.Note {
  return {
    id: n.id,
    lessonId: n.lesson_id,
    body: n.body,
    videoTimestampSeconds: n.video_timestamp_seconds,
    createdAt: n.created_at.toISOString(),
    updatedAt: n.updated_at.toISOString(),
  };
}

function ackDto(a: AckRow): learning.Acknowledgment {
  return { id: a.id, lessonId: a.lesson_id, typedName: a.typed_name, statementHash: a.statement_hash, acknowledgedAt: a.acknowledged_at.toISOString() };
}

function progressView(row: LessonProgressRow | undefined): ProgressView | null {
  return row ? { status: row.status, percent: Number(row.percent), startedAt: row.started_at, data: row.data ?? {} } : null;
}

/** Self-service learning for the signed-in person (`/learning/me/...`). */
@Injectable()
export class LearnerService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly trees: TreeService,
    private readonly progress: ProgressService,
    private readonly enrollments: EnrollmentsService,
    private readonly events: EventBus,
    private readonly directory: DirectoryReader,
    @Inject(LEARNING_CONFIG) private readonly config: LearningConfig,
  ) {}

  // ---------------------------------------------------------------- lookups

  private assertUsable(enrollment: EnrollmentRow, programStatus: string): void {
    if (programStatus === 'archived') {
      throw new PreconditionError('PROGRAM_ARCHIVED', 'This program was retired. Your completed work is kept in your training record.');
    }
    if (enrollment.status === 'withdrawn') {
      throw new PreconditionError('ENROLLMENT_WITHDRAWN', 'You were withdrawn from this program. Ask your manager to enroll you again.');
    }
  }

  private async ownEnrollment(p: Principal, programId: string, db: Db | Trx = this.db): Promise<{ enrollment: EnrollmentRow; tree: ProgramTree }> {
    const row = await db
      .selectFrom('enrollments as e')
      .innerJoin('programs as pr', 'pr.id', 'e.program_id')
      .selectAll('e')
      .select('pr.status as program_status')
      .where('e.program_id', '=', programId)
      .where('e.user_id', '=', p.userId)
      .where('e.organization_id', '=', p.organizationId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Enrollment');
    const { program_status, ...enrollment } = row;
    this.assertUsable(enrollment, program_status);
    const tree = await this.trees.published(programId, db);
    if (!tree) throw new NotFoundError('Program');
    return { enrollment, tree };
  }

  private async ownLesson(p: Principal, lessonId: string, db: Db | Trx = this.db): Promise<OwnLesson> {
    const lesson = await db
      .selectFrom('lessons')
      .select('program_id')
      .where('id', '=', lessonId)
      .where('organization_id', '=', p.organizationId)
      .executeTakeFirst();
    if (!lesson) throw new NotFoundError('Lesson');
    const { enrollment, tree } = await this.ownEnrollment(p, lesson.program_id, db);
    const info = lessonIndex(tree).get(lessonId);
    if (!info) throw new NotFoundError('Lesson');
    return { enrollment, tree, info };
  }

  /** Lock the learner's enrollment and evaluate the lesson inside a transaction. */
  private async lockedLesson(trx: Trx, p: Principal, lessonId: string) {
    const own = await this.ownLesson(p, lessonId, trx);
    const enrollment = (await this.progress.lockEnrollment(trx, own.enrollment.id))!;
    const { ev } = await this.progress.evaluate(trx, own.tree, enrollment);
    const evaluation = ev.lessons.get(lessonId)!;
    return { ...own, enrollment, ev, evaluation };
  }

  private assertUnlocked(evaluation: LessonEval): void {
    if (evaluation.state === 'locked') {
      const unmet = evaluation.requirements.filter((r) => !r.satisfied).map((r) => r.description);
      throw new PreconditionError('LESSON_LOCKED', `This lesson is locked. ${unmet.join('. ')}${unmet.length ? '.' : ''}`.trim(), {
        requirements: evaluation.requirements,
      });
    }
  }

  private async progressRow(db: Db | Trx, enrollmentId: string, lessonId: string) {
    return db.selectFrom('lesson_progress').selectAll().where('enrollment_id', '=', enrollmentId).where('lesson_id', '=', lessonId).executeTakeFirst();
  }

  // ---------------------------------------------------------------- dashboard

  private summarize(enrollment: EnrollmentRow, tree: ProgramTree, ev: ProgramEval, now: Date): learning.MyEnrollment {
    const next = ev.nextLesson;
    return {
      ...enrollmentProgressDto(enrollment, now),
      program: {
        id: tree.programId,
        title: tree.title,
        summary: tree.summary,
        category: tree.category,
        coverMediaAssetId: tree.coverMediaAssetId,
        phaseLabel: tree.phaseLabel,
        phaseCount: tree.phases.length,
      },
      currentPhase: phaseRef(tree, ev.currentPhase?.phase.id ?? enrollment.current_phase_id),
      nextLesson: next
        ? {
            id: next.lesson.id,
            title: next.lesson.title,
            type: next.lesson.type,
            estimatedMinutes: next.lesson.estimatedMinutes,
            phaseTitle: next.phase.title,
            moduleTitle: next.module.title,
            state: next.state,
          }
        : null,
      estimatedRemainingMinutes: ev.remainingMinutes,
    };
  }

  private async mine(p: Principal) {
    const rows = await this.db
      .selectFrom('enrollments as e')
      .innerJoin('programs as pr', 'pr.id', 'e.program_id')
      .selectAll('e')
      .where('e.user_id', '=', p.userId)
      .where('e.organization_id', '=', p.organizationId)
      .where('e.status', 'in', ['active', 'completed'])
      .where('pr.status', '=', 'published')
      .orderBy(sql`case when e.status = 'active' then 0 else 1 end`)
      .orderBy(sql`e.last_activity_at desc nulls last`)
      .orderBy('e.enrolled_at', 'desc')
      .execute();
    const out: Array<{ enrollment: EnrollmentRow; tree: ProgramTree; ev: ProgramEval }> = [];
    for (const enrollment of rows) {
      const tree = await this.trees.published(enrollment.program_id);
      if (!tree) continue;
      const { ev } = await this.progress.evaluate(this.db, tree, enrollment);
      out.push({ enrollment, tree, ev });
    }
    return out;
  }

  async myEnrollments(p: Principal): Promise<learning.MyEnrollment[]> {
    const now = new Date();
    return (await this.mine(p)).map(({ enrollment, tree, ev }) => this.summarize(enrollment, tree, ev, now));
  }

  async continueLearning(p: Principal): Promise<learning.ContinueLearning> {
    for (const { enrollment, tree, ev } of await this.mine(p)) {
      if (enrollment.status !== 'active' || !ev.nextLesson) continue;
      const next = ev.nextLesson;
      return {
        item: {
          enrollmentId: enrollment.id,
          program: { id: tree.programId, title: tree.title },
          phase: phaseRef(tree, next.phase.id)!,
          module: { id: next.module.id, title: next.module.title },
          lesson: {
            id: next.lesson.id,
            title: next.lesson.title,
            type: next.lesson.type,
            estimatedMinutes: next.lesson.estimatedMinutes,
            state: next.state,
            percent: next.percent,
          },
          progressPercent: ev.percent,
        },
      };
    }
    return { item: null };
  }

  async outline(p: Principal, programId: string): Promise<learning.Outline> {
    const { enrollment, tree } = await this.ownEnrollment(p, programId);
    const { ev } = await this.progress.evaluate(this.db, tree, enrollment);
    return toOutline(tree, ev, enrollmentProgressDto(enrollment));
  }

  // ---------------------------------------------------------------- catalogue / self-enrollment

  private async audienceSubject(p: Principal) {
    const user = await this.db.selectFrom('dir_users').select(['role_keys', 'location_id', 'department_id', 'status']).where('id', '=', p.userId).executeTakeFirst();
    const teams = await this.db.selectFrom('dir_user_teams').select('team_id').where('user_id', '=', p.userId).execute();
    return {
      roleKeys: user?.role_keys ?? p.data.roles,
      teamIds: teams.map((t) => t.team_id),
      locationId: user?.location_id ?? null,
      departmentId: user?.department_id ?? null,
    };
  }

  /** Programs open for self-enrollment that the learner belongs to the audience of. */
  async catalog(p: Principal): Promise<learning.CatalogItem[]> {
    const programs = await this.db
      .selectFrom('programs')
      .select(['id'])
      .where('organization_id', '=', p.organizationId)
      .where('status', '=', 'published')
      .where(sql<boolean>`(settings->>'allowSelfEnrollment')::boolean is true`)
      .where((eb) => eb.or([eb('availability_ends_at', 'is', null), eb('availability_ends_at', '>', new Date())]))
      .where('id', 'not in', this.db.selectFrom('enrollments').select('program_id').where('user_id', '=', p.userId).where('status', 'in', ['active', 'completed']))
      .execute();
    if (programs.length === 0) return [];
    const subject = await this.audienceSubject(p);
    const audiences = await this.db
      .selectFrom('program_audiences')
      .select(['program_id', 'kind', 'ref'])
      .where(
        'program_id',
        'in',
        programs.map((x) => x.id),
      )
      .execute();
    const items: learning.CatalogItem[] = [];
    for (const { id } of programs) {
      const own = audiences.filter((a) => a.program_id === id);
      if (own.length && !inAudience(own, subject)) continue;
      const tree = await this.trees.published(id);
      if (!tree) continue;
      const lessons = orderedLessons(tree);
      items.push({
        id,
        title: tree.title,
        summary: tree.summary,
        category: tree.category,
        coverMediaAssetId: tree.coverMediaAssetId,
        phaseLabel: tree.phaseLabel,
        phaseCount: tree.phases.length,
        lessonCount: lessons.length,
        estimatedMinutes: tree.estimatedMinutes ?? lessons.reduce((n, l) => n + l.lesson.estimatedMinutes, 0),
      });
    }
    return items.sort((a, b) => a.title.localeCompare(b.title));
  }

  async selfEnroll(p: Principal, programId: string): Promise<learning.MyEnrollment> {
    const { program, tree } = await this.enrollments.enrollableProgram(p.organizationId, programId);
    if (!tree.settings.allowSelfEnrollment) {
      throw new PreconditionError('SELF_ENROLLMENT_DISABLED', 'This program is assigned by your manager. Ask them to enroll you.');
    }
    const audiences = await this.db.selectFrom('program_audiences').select(['kind', 'ref']).where('program_id', '=', programId).execute();
    if (audiences.length && !inAudience(audiences, await this.audienceSubject(p))) {
      throw new PreconditionError('NOT_IN_AUDIENCE', 'This program is meant for a different team or role. Ask your manager if you should take it.');
    }
    await this.db.transaction().execute((trx) =>
      this.enrollments.enrollUsers(trx, { program, tree, userIds: [p.userId], source: 'self', assignedBy: null, actorDisplay: p.displayName }),
    );
    const { enrollment } = await this.ownEnrollment(p, programId);
    const { ev } = await this.progress.evaluate(this.db, tree, enrollment);
    return this.summarize(enrollment, tree, ev, new Date());
  }

  // ---------------------------------------------------------------- lesson

  async lessonDetail(p: Principal, lessonId: string): Promise<learning.LessonDetail> {
    const { enrollment, tree, info } = await this.ownLesson(p, lessonId);
    const { ev } = await this.progress.evaluate(this.db, tree, enrollment);
    const evaluation = ev.lessons.get(lessonId)!;
    const lesson = info.lesson;
    const handler = lessonTypes.get(lesson.type);
    const locked = evaluation.state === 'locked';
    const [row, notes, approval, submission, ack] = await Promise.all([
      this.progressRow(this.db, enrollment.id, lessonId),
      this.db.selectFrom('lesson_notes').selectAll().where('user_id', '=', p.userId).where('lesson_id', '=', lessonId).orderBy('created_at').execute(),
      this.db.selectFrom('approval_requests').selectAll().where('enrollment_id', '=', enrollment.id).where('lesson_id', '=', lessonId).orderBy('requested_at', 'desc').limit(1).executeTakeFirst(),
      this.db.selectFrom('assignment_submissions').selectAll().where('enrollment_id', '=', enrollment.id).where('lesson_id', '=', lessonId).orderBy('submitted_at', 'desc').limit(1).executeTakeFirst(),
      this.db.selectFrom('acknowledgments').selectAll().where('enrollment_id', '=', enrollment.id).where('lesson_id', '=', lessonId).executeTakeFirst(),
    ]);
    const names = await displayNames(this.db, [approval?.decided_by, submission?.reviewed_by]);
    const check = handler.learnerCompletion(lesson.config, { settings: tree.settings, progress: progressView(row) });
    const index = ev.ordered.findIndex((l) => l.lesson.id === lessonId);
    return {
      enrollmentId: enrollment.id,
      program: { id: tree.programId, title: tree.title },
      phase: phaseRef(tree, info.phase.id)!,
      module: { id: info.module.id, title: info.module.title },
      lesson: {
        id: lesson.id,
        type: lesson.type,
        title: lesson.title,
        summary: lesson.summary,
        body: locked ? null : lesson.body,
        config: locked ? null : lesson.config,
        isRequired: lesson.isRequired,
        estimatedMinutes: lesson.estimatedMinutes,
        resources: locked ? [] : lesson.resources,
      },
      state: evaluation.state,
      requirements: evaluation.requirements,
      completion: {
        mode: handler.completion,
        canCompleteManually: !locked && evaluation.state !== 'completed' && check.allowed,
        hint: handler.completionHint(lesson.config, tree.settings),
      },
      progress: lessonProgressDto(lessonId, row),
      grant: locked ? null : await this.grant(enrollment, tree, info),
      notes: notes.map(noteDto),
      approval: approval
        ? {
            id: approval.id,
            kind: approval.kind,
            status: approval.status,
            requestedAt: approval.requested_at.toISOString(),
            decidedAt: iso(approval.decided_at),
            decidedBy: personRef(approval.decided_by, names, approval.decided_by_name),
            comment: approval.comment,
          }
        : null,
      submission: submission ? this.submissionDto(submission, names) : null,
      acknowledgment: ack ? ackDto(ack) : null,
      previousLessonId: index > 0 ? ev.ordered[index - 1]!.lesson.id : null,
      nextLessonId: index >= 0 && index < ev.ordered.length - 1 ? ev.ordered[index + 1]!.lesson.id : null,
    };
  }

  /** Signed capability for the service that hosts the lesson's resource. Never for locked lessons. */
  private async grant(enrollment: EnrollmentRow, tree: ProgramTree, info: IndexedLesson): Promise<learning.LessonGrantDto | null> {
    const spec = lessonTypes.get(info.lesson.type).grant(info.lesson.config, tree.settings);
    if (!spec) return null;
    const ttl = this.config.learning.grantTtlSeconds;
    const token = await signLessonGrant(
      {
        userId: enrollment.user_id,
        organizationId: enrollment.organization_id,
        programId: enrollment.program_id,
        enrollmentId: enrollment.id,
        lessonId: info.lesson.id,
        resource: spec.resource,
        policy: spec.policy,
      },
      this.config.internalAuthSecret,
      ttl,
    );
    return { token, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), resource: spec.resource, policy: spec.policy };
  }

  private submissionDto(s: SubmissionRow, names: Map<string, string>): learning.Submission {
    return {
      id: s.id,
      lessonId: s.lesson_id,
      body: s.body,
      wordCount: s.word_count,
      status: s.status,
      submittedAt: s.submitted_at.toISOString(),
      reviewedAt: iso(s.reviewed_at),
      reviewedBy: personRef(s.reviewed_by, names, s.reviewed_by_name),
      feedback: s.feedback,
    };
  }

  /** The learner opened the lesson. Emits lesson.started the first time. */
  async start(p: Principal, lessonId: string): Promise<learning.LessonProgress> {
    const row = await this.db.transaction().execute(async (trx) => {
      const { enrollment, tree, evaluation } = await this.lockedLesson(trx, p, lessonId);
      this.assertUnlocked(evaluation);
      const at = new Date();
      const { progress } = await this.progress.recordActivity(trx, { enrollment, tree, lessonId, at });
      await this.progress.sync(trx, enrollment, tree, { at });
      return progress;
    });
    return lessonProgressDto(lessonId, row);
  }

  /** "Mark complete" for lesson types that allow it (articles, documents, external links, manual videos). */
  async complete(p: Principal, lessonId: string): Promise<learning.CompleteLessonResult> {
    const result = await this.db.transaction().execute(async (trx) => {
      const { enrollment, tree, info, evaluation } = await this.lockedLesson(trx, p, lessonId);
      const row = await this.progressRow(trx, enrollment.id, lessonId);
      if (row?.status === 'completed') return { progress: row, enrollment };
      this.assertUnlocked(evaluation);
      const check = lessonTypes.get(info.lesson.type).learnerCompletion(info.lesson.config, { settings: tree.settings, progress: progressView(row) });
      if (!check.allowed) throw new PreconditionError('COMPLETION_NOT_ALLOWED', check.reason);
      const done = await this.progress.completeLesson(trx, { enrollment, tree, lessonId, source: 'learner' });
      return { progress: done.progress, enrollment: done.sync?.enrollment ?? enrollment };
    });
    return { progress: lessonProgressDto(lessonId, result.progress), enrollment: enrollmentProgressDto(result.enrollment) };
  }

  /** Acknowledge a statement by typing one's full name. Idempotent. */
  async acknowledge(p: Principal, lessonId: string, typedName: string): Promise<learning.Acknowledgment> {
    const ack = await this.db.transaction().execute(async (trx) => {
      const { enrollment, tree, info, evaluation } = await this.lockedLesson(trx, p, lessonId);
      if (info.lesson.type !== 'acknowledgment') throw new PreconditionError('WRONG_LESSON_TYPE', 'This lesson does not ask for an acknowledgment.');
      const existing = await trx.selectFrom('acknowledgments').selectAll().where('enrollment_id', '=', enrollment.id).where('lesson_id', '=', lessonId).executeTakeFirst();
      if (existing) return existing;
      this.assertUnlocked(evaluation);
      const person = await this.directory.getUser(p.userId);
      const fullName = person ? `${person.firstName} ${person.lastName}` : p.displayName;
      if (normalizeName(typedName) !== normalizeName(fullName)) {
        throw new PreconditionError('NAME_MISMATCH', `Type your full name exactly as it appears on your profile (${fullName}) to acknowledge the statement.`);
      }
      const statement = String(info.lesson.config.statement ?? '');
      const ctx = getContext();
      const at = new Date();
      const row = await trx
        .insertInto('acknowledgments')
        .values({
          id: uuidv7(),
          organization_id: enrollment.organization_id,
          user_id: p.userId,
          enrollment_id: enrollment.id,
          lesson_id: lessonId,
          statement_hash: sha256(statement),
          statement_text: statement,
          typed_name: typedName.trim().replace(/\s+/g, ' '),
          ip: ctx?.ip ?? null,
          user_agent: ctx?.userAgent ?? null,
          acknowledged_at: at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.progress.completeLesson(trx, { enrollment, tree, lessonId, source: 'acknowledgment', at });
      await this.events.audit(
        trx,
        {
          action: 'lesson.acknowledged',
          resourceType: 'acknowledgment',
          resourceId: row.id,
          actorDisplay: p.displayName,
          after: { lessonId, lessonTitle: info.lesson.title, statementHash: row.statement_hash },
        },
        { organizationId: enrollment.organization_id },
      );
      return row;
    });
    return ackDto(ack);
  }

  /** Submit an assignment response; opens a review request for a trainer or manager. */
  async submitAssignment(p: Principal, lessonId: string, body: string): Promise<{ submission: learning.Submission; approval: learning.LearnerApproval }> {
    const { submission, approval } = await this.db.transaction().execute(async (trx) => {
      const { enrollment, tree, info, evaluation } = await this.lockedLesson(trx, p, lessonId);
      if (info.lesson.type !== 'assignment') throw new PreconditionError('WRONG_LESSON_TYPE', 'This lesson does not take a written submission.');
      this.assertUnlocked(evaluation);
      if (evaluation.completed) throw new ConflictError('ALREADY_COMPLETED', 'Your submission for this assignment was already approved.');
      const pending = await trx
        .selectFrom('approval_requests')
        .select('id')
        .where('enrollment_id', '=', enrollment.id)
        .where('lesson_id', '=', lessonId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (pending) throw new ConflictError('SUBMISSION_PENDING', 'Your previous submission is waiting for review. You can resubmit if it is sent back.');
      const minWords = Number(info.lesson.config.minWords ?? 0);
      const words = countWords(body);
      if (words < minWords) {
        throw new PreconditionError('SUBMISSION_TOO_SHORT', `Write at least ${minWords} words. Your response has ${words}.`);
      }
      const at = new Date();
      const submission = await trx
        .insertInto('assignment_submissions')
        .values({
          id: uuidv7(),
          organization_id: enrollment.organization_id,
          user_id: p.userId,
          enrollment_id: enrollment.id,
          lesson_id: lessonId,
          body: body.trim(),
          word_count: words,
          status: 'submitted',
          submitted_at: at,
          reviewed_by: null,
          reviewed_by_name: null,
          reviewed_at: null,
          feedback: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.progress.recordActivity(trx, { enrollment, tree, lessonId, at });
      const approval = await this.progress.openApproval(trx, { kind: 'assignment_review', enrollment, tree, lessonId, submissionId: submission.id, at });
      return { submission, approval };
    });
    return {
      submission: this.submissionDto(submission, new Map()),
      approval: {
        id: approval.id,
        kind: approval.kind,
        status: approval.status,
        requestedAt: approval.requested_at.toISOString(),
        decidedAt: null,
        decidedBy: null,
        comment: null,
      },
    };
  }

  /** Ask for the manager sign-off again (e.g. after it was sent back). Idempotent while pending. */
  async requestApproval(p: Principal, lessonId: string, note: string | null | undefined): Promise<learning.LearnerApproval> {
    const approval = await this.db.transaction().execute(async (trx) => {
      const { enrollment, tree, info, evaluation } = await this.lockedLesson(trx, p, lessonId);
      if (info.lesson.type !== 'manager_approval') throw new PreconditionError('WRONG_LESSON_TYPE', 'This lesson does not need a manager sign-off.');
      this.assertUnlocked(evaluation);
      if (evaluation.completed) throw new ConflictError('ALREADY_COMPLETED', 'Your manager already signed off this step.');
      const pending = await trx
        .selectFrom('approval_requests')
        .selectAll()
        .where('enrollment_id', '=', enrollment.id)
        .where('lesson_id', '=', lessonId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (pending) return pending;
      await this.progress.recordActivity(trx, { enrollment, tree, lessonId });
      return this.progress.openApproval(trx, { kind: 'manager_approval', enrollment, tree, lessonId, note: note ?? null });
    });
    const names = await displayNames(this.db, [approval.decided_by]);
    return {
      id: approval.id,
      kind: approval.kind,
      status: approval.status,
      requestedAt: approval.requested_at.toISOString(),
      decidedAt: iso(approval.decided_at),
      decidedBy: personRef(approval.decided_by, names, approval.decided_by_name),
      comment: approval.comment,
    };
  }

  // ---------------------------------------------------------------- notes

  async notes(p: Principal, lessonId: string): Promise<learning.Note[]> {
    await this.ownLesson(p, lessonId);
    const rows = await this.db.selectFrom('lesson_notes').selectAll().where('user_id', '=', p.userId).where('lesson_id', '=', lessonId).orderBy('created_at').execute();
    return rows.map(noteDto);
  }

  async addNote(p: Principal, lessonId: string, input: { body: string; videoTimestampSeconds?: number | null }): Promise<learning.Note> {
    const { enrollment } = await this.ownLesson(p, lessonId);
    const count = await this.db
      .selectFrom('lesson_notes')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('user_id', '=', p.userId)
      .where('lesson_id', '=', lessonId)
      .executeTakeFirstOrThrow();
    if (Number(count.n) >= 200) throw new PreconditionError('TOO_MANY_NOTES', 'You have 200 notes on this lesson. Delete some before adding more.');
    const row = await this.db
      .insertInto('lesson_notes')
      .values({
        id: uuidv7(),
        organization_id: enrollment.organization_id,
        user_id: p.userId,
        lesson_id: lessonId,
        body: input.body,
        video_timestamp_seconds: input.videoTimestampSeconds ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return noteDto(row);
  }

  private async ownNote(p: Principal, noteId: string): Promise<NoteRow> {
    const note = await this.db.selectFrom('lesson_notes').selectAll().where('id', '=', noteId).where('user_id', '=', p.userId).executeTakeFirst();
    if (!note) throw new NotFoundError('Note');
    return note;
  }

  async updateNote(p: Principal, noteId: string, input: { body?: string; videoTimestampSeconds?: number | null }): Promise<learning.Note> {
    await this.ownNote(p, noteId);
    const row = await this.db
      .updateTable('lesson_notes')
      .set({
        ...(input.body !== undefined && { body: input.body }),
        ...(input.videoTimestampSeconds !== undefined && { video_timestamp_seconds: input.videoTimestampSeconds }),
      })
      .where('id', '=', noteId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return noteDto(row);
  }

  async deleteNote(p: Principal, noteId: string): Promise<void> {
    await this.ownNote(p, noteId);
    await this.db.deleteFrom('lesson_notes').where('id', '=', noteId).execute();
  }
}
