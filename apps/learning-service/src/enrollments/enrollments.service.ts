import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { learning } from '@a5/contracts';
import { likePattern, paginate, sql, type Page, type Selectable } from '@a5/database';
import { learningEvents } from '@a5/events';
import {
  ConflictError,
  EventBus,
  ForbiddenError,
  InjectDb,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import type { PermissionKey } from '@a5/permissions';
import { approvalSummaries } from '../common/approvals.js';
import { displayNames, learnerRefs, personRef } from '../common/people.js';
import { ScopeService } from '../common/scope.service.js';
import type { Db, ProgramsTable, Trx } from '../database/index.js';
import { enrollmentProgressDto, iso, type EnrollmentRow } from '../engine/dto.js';
import { ProgressService } from '../engine/progress.service.js';
import { phaseRef, type ProgramTree } from '../engine/tree.js';
import { TreeService } from '../engine/tree.service.js';

type ProgramRow = Selectable<ProgramsTable>;

export interface EnrollmentListFilters {
  q?: string;
  programId?: string;
  teamId?: string;
  userId?: string;
  status?: learning.EnrollmentStatus[];
  overdue?: boolean;
  sort?: string;
  page: number;
  pageSize: number;
}

const SORTS = {
  name: sql`u.display_name`,
  progress: sql`e.progress_percent`,
  lastActivity: sql`e.last_activity_at`,
  dueAt: sql`e.due_at`,
  enrolledAt: sql`e.enrolled_at`,
} as const;

const DAY = 86_400_000;

export interface EnrollUsersInput {
  program: ProgramRow;
  tree: ProgramTree;
  userIds: string[];
  source: learning.EnrollmentSource;
  assignedBy: string | null;
  actorDisplay: string | null;
  dueAt?: Date | null;
  at?: Date;
}

@Injectable()
export class EnrollmentsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    private readonly scope: ScopeService,
    private readonly trees: TreeService,
    private readonly progress: ProgressService,
  ) {}

  /** Published program in the caller's organization that accepts enrollments. */
  async enrollableProgram(
    organizationId: string,
    programId: string,
  ): Promise<{ program: ProgramRow; tree: ProgramTree }> {
    const program = await this.db
      .selectFrom('programs')
      .selectAll()
      .where('id', '=', programId)
      .where('organization_id', '=', organizationId)
      .executeTakeFirst();
    if (!program) throw new NotFoundError('Program');
    if (program.status === 'archived')
      throw new PreconditionError(
        'PROGRAM_ARCHIVED',
        'This program is archived. Restore it before enrolling people.',
      );
    const tree = await this.trees.published(programId);
    if (!tree || program.status !== 'published') {
      throw new PreconditionError('NOT_PUBLISHED', 'Publish the program before enrolling people.');
    }
    if (program.availability_ends_at && program.availability_ends_at < new Date()) {
      throw new PreconditionError(
        'PROGRAM_CLOSED',
        'This program is closed for new enrollments. Extend its availability window first.',
      );
    }
    return { program, tree };
  }

  /** Bulk enrollment by a manager or administrator (programs.assign, scoped). */
  async enroll(
    p: Principal,
    input: { programId: string; userIds: string[]; dueAt?: string | null },
  ): Promise<learning.BulkEnrollResult> {
    const userIds = [...new Set(input.userIds)];
    const { program, tree } = await this.enrollableProgram(p.organizationId, input.programId);
    const users = await this.db
      .selectFrom('dir_users')
      .select(['id', 'status', 'display_name'])
      .where('id', 'in', userIds)
      .where('organization_id', '=', p.organizationId)
      .execute();
    const filter = p.scopeFilter('programs.assign');
    const broad = filter.kind === 'organization' || filter.kind === 'platform';
    const known = new Set(users.map((u) => u.id));
    const unknown = userIds.filter((id) => !known.has(id));
    if (broad && unknown.length) {
      throw new ValidationError([
        {
          path: 'userIds',
          message: `${unknown.length === 1 ? 'One person was' : `${unknown.length} people were`} not found in your organization.`,
        },
      ]);
    }
    const outside: string[] = [...(broad ? [] : unknown)];
    for (const u of users) {
      if (
        !(await this.scope.admits(p, ['programs.assign'], {
          userId: u.id,
          organizationId: p.organizationId,
        }))
      )
        outside.push(u.id);
    }
    if (outside.length) {
      throw new ForbiddenError(
        'You can only enroll people on the teams you manage or who are assigned to you.',
        { userIds: outside },
      );
    }
    const deactivated = users.filter((u) => u.status === 'deactivated');
    if (deactivated.length) {
      throw new ValidationError([
        {
          path: 'userIds',
          message: `${deactivated.map((u) => u.display_name).join(', ')} ${deactivated.length === 1 ? 'is' : 'are'} deactivated and cannot be enrolled.`,
        },
      ]);
    }
    const dueAt =
      input.dueAt === undefined ? undefined : input.dueAt === null ? null : new Date(input.dueAt);
    if (dueAt && dueAt < new Date())
      throw new ValidationError([{ path: 'dueAt', message: 'Choose a due date in the future.' }]);

    return this.db.transaction().execute((trx) =>
      this.enrollUsers(trx, {
        program,
        tree,
        userIds,
        source: 'manual',
        assignedBy: p.userId,
        actorDisplay: p.displayName,
        dueAt,
      }),
    );
  }

  /**
   * Idempotent enrollment: new people are enrolled, withdrawn enrollments are reactivated and
   * active or completed enrollments are left unchanged.
   */
  async enrollUsers(trx: Trx, input: EnrollUsersInput): Promise<learning.BulkEnrollResult> {
    const at = input.at ?? new Date();
    const defaultDue = input.tree.settings.defaultDueDays
      ? new Date(at.getTime() + input.tree.settings.defaultDueDays * DAY)
      : null;
    const dueAt = input.dueAt === undefined ? defaultDue : input.dueAt;
    const result: learning.BulkEnrollResult = {
      created: 0,
      reactivated: 0,
      unchanged: 0,
      items: [],
    };

    for (const userId of input.userIds) {
      const existing = await trx
        .selectFrom('enrollments')
        .selectAll()
        .where('program_id', '=', input.program.id)
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      let row: EnrollmentRow | undefined;
      let outcome: 'created' | 'reactivated' | 'unchanged';
      if (!existing) {
        row = await trx
          .insertInto('enrollments')
          .values({
            id: uuidv7(),
            organization_id: input.program.organization_id,
            program_id: input.program.id,
            user_id: userId,
            status: 'active',
            source: input.source,
            assigned_by: input.assignedBy,
            enrolled_at: at,
            due_at: dueAt,
            started_at: null,
            completed_at: null,
            withdrawn_at: null,
            withdrawn_by: null,
            withdrawal_reason: null,
            current_lesson_id: null,
            current_phase_id: null,
            last_activity_at: null,
          })
          .onConflict((oc) => oc.columns(['program_id', 'user_id']).doNothing())
          .returningAll()
          .executeTakeFirst();
        outcome = row ? 'created' : 'unchanged';
      } else if (existing.status === 'withdrawn') {
        row = await trx
          .updateTable('enrollments')
          .set({
            status: 'active',
            enrolled_at: at,
            due_at: dueAt,
            assigned_by: input.assignedBy,
            withdrawn_at: null,
            withdrawn_by: null,
            withdrawal_reason: null,
          })
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        outcome = 'reactivated';
      } else {
        outcome = 'unchanged';
      }

      if (row && outcome !== 'unchanged') {
        await this.events.emit(
          trx,
          learningEvents.enrolled,
          {
            enrollmentId: row.id,
            programId: row.program_id,
            userId,
            programTitle: input.tree.title,
            assignedBy: input.assignedBy,
            dueAt: iso(row.due_at),
            source: input.source,
          },
          { organizationId: row.organization_id, subject: { type: 'enrollment', id: row.id } },
        );
        await this.events.audit(
          trx,
          {
            action: outcome === 'created' ? 'enrollment.created' : 'enrollment.reactivated',
            resourceType: 'enrollment',
            resourceId: row.id,
            actorDisplay: input.actorDisplay,
            after: {
              programId: row.program_id,
              userId,
              source: input.source,
              dueAt: iso(row.due_at),
            },
          },
          { organizationId: row.organization_id },
        );
        const synced = await this.progress.sync(trx, row, input.tree, { at });
        row = synced.enrollment;
      }
      if (outcome === 'created') result.created++;
      else if (outcome === 'reactivated') result.reactivated++;
      else result.unchanged++;
      result.items.push({ userId, enrollmentId: (row ?? existing)?.id ?? '', outcome });
    }
    // A concurrent request may have created the enrollment between our check and insert.
    for (const item of result.items.filter((i) => !i.enrollmentId)) {
      const row = await trx
        .selectFrom('enrollments')
        .select('id')
        .where('program_id', '=', input.program.id)
        .where('user_id', '=', item.userId)
        .executeTakeFirstOrThrow();
      item.enrollmentId = row.id;
    }
    return result;
  }

  async list(p: Principal, f: EnrollmentListFilters): Promise<Page<learning.EnrollmentSummary>> {
    let query = this.db
      .selectFrom('enrollments as e')
      .innerJoin('programs as pr', 'pr.id', 'e.program_id')
      .leftJoin('dir_users as u', 'u.id', 'e.user_id')
      .selectAll('e')
      .select(['pr.title as program_title'])
      .where(
        this.scope.condition(p, 'enrollments.view', {
          userColumn: 'e.user_id',
          orgColumn: 'e.organization_id',
        }),
      );
    if (f.programId) query = query.where('e.program_id', '=', f.programId);
    if (f.userId) query = query.where('e.user_id', '=', f.userId);
    if (f.teamId)
      query = query.where(
        'e.user_id',
        'in',
        this.db.selectFrom('dir_user_teams').select('user_id').where('team_id', '=', f.teamId),
      );
    if (f.status?.length) query = query.where('e.status', 'in', f.status);
    if (f.overdue === true)
      query = query.where('e.status', '=', 'active').where('e.due_at', '<', new Date());
    if (f.overdue === false)
      query = query.where((eb) =>
        eb.or([
          eb('e.status', '!=', 'active'),
          eb('e.due_at', 'is', null),
          eb('e.due_at', '>=', new Date()),
        ]),
      );
    if (f.q) {
      const pattern = likePattern(f.q);
      query = query.where((eb) =>
        eb.or([
          eb('u.display_name', 'ilike', pattern),
          eb('u.email', 'ilike', pattern),
          eb('u.employee_id', 'ilike', pattern),
        ]),
      );
    }
    const desc = f.sort?.startsWith('-') ?? false;
    const key = (f.sort?.replace(/^-/, '') ?? 'name') as keyof typeof SORTS;
    query = query
      .orderBy(SORTS[key] ?? SORTS.name, sql.raw(desc ? 'desc nulls last' : 'asc nulls last'))
      .orderBy('e.id');
    const page = await paginate(query, { page: f.page, pageSize: f.pageSize });
    return { ...page, items: await this.summaries(page.items) };
  }

  private async summaries(
    rows: Array<EnrollmentRow & { program_title: string }>,
  ): Promise<learning.EnrollmentSummary[]> {
    const [learners, names] = await Promise.all([
      learnerRefs(
        this.db,
        rows.map((r) => r.user_id),
      ),
      displayNames(
        this.db,
        rows.map((r) => r.assigned_by),
      ),
    ]);
    const trees = new Map<string, ProgramTree | null>();
    for (const programId of new Set(rows.map((r) => r.program_id)))
      trees.set(programId, await this.trees.published(programId));
    const now = new Date();
    return rows.map((r) => {
      const tree = trees.get(r.program_id) ?? null;
      return {
        ...enrollmentProgressDto(r, now),
        learner: learners.get(r.user_id)!,
        program: { id: r.program_id, title: tree?.title ?? r.program_title },
        currentPhase: phaseRef(tree, r.current_phase_id),
        assignedBy: personRef(r.assigned_by, names),
        withdrawnAt: iso(r.withdrawn_at),
      };
    });
  }

  /** Load an enrollment the caller may see through one of the permissions; 404 otherwise. */
  async visible(
    p: Principal,
    id: string,
    permissions: readonly PermissionKey[],
  ): Promise<EnrollmentRow & { program_title: string }> {
    const row = await this.db
      .selectFrom('enrollments as e')
      .innerJoin('programs as pr', 'pr.id', 'e.program_id')
      .selectAll('e')
      .select('pr.title as program_title')
      .where('e.id', '=', id)
      .where('e.organization_id', '=', p.organizationId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Enrollment');
    await this.scope.assertAdmits(
      p,
      permissions,
      { userId: row.user_id, organizationId: row.organization_id },
      'Enrollment',
    );
    return row;
  }

  async detail(p: Principal, id: string): Promise<learning.EnrollmentDetail> {
    const row = await this.visible(p, id, ['enrollments.view']);
    return this.buildDetail(row);
  }

  private async buildDetail(
    row: EnrollmentRow & { program_title: string },
  ): Promise<learning.EnrollmentDetail> {
    const [summary] = await this.summaries([row]);
    const tree = await this.trees.published(row.program_id);
    const approvals = await this.db
      .selectFrom('approval_requests')
      .selectAll()
      .where('enrollment_id', '=', row.id)
      .orderBy('requested_at', 'desc')
      .execute();
    if (!tree) {
      return {
        ...summary!,
        withdrawalReason: row.withdrawal_reason,
        phases: [],
        lessons: [],
        approvals: await approvalSummaries(this.db, approvals),
      };
    }
    const { ev, facts } = await this.progress.evaluate(this.db, tree, row);
    return {
      ...summary!,
      withdrawalReason: row.withdrawal_reason,
      phases: ev.phases.map((ph) => ({
        id: ph.phase.id,
        title: ph.phase.title,
        label: ph.label,
        position: ph.index + 1,
        state: ph.state,
        percent: ph.percent,
        requiredTotal: ph.requiredTotal,
        requiredCompleted: ph.requiredCompleted,
        completedAt: iso(ph.completedAt),
      })),
      lessons: ev.ordered.map((l) => {
        const progress = facts.progress.get(l.lesson.id);
        return {
          lessonId: l.lesson.id,
          phaseId: l.phase.id,
          moduleId: l.module.id,
          title: l.lesson.title,
          type: l.lesson.type,
          isRequired: l.lesson.isRequired,
          state: l.state,
          status: progress?.status ?? 'not_started',
          percent: l.percent,
          startedAt: iso(progress?.startedAt),
          completedAt: iso(progress?.completedAt),
          completionSource: progress?.source ?? null,
        };
      }),
      approvals: await approvalSummaries(this.db, approvals),
    };
  }

  async withdraw(
    p: Principal,
    id: string,
    reason: string | null | undefined,
  ): Promise<learning.EnrollmentDetail> {
    const row = await this.visible(p, id, ['enrollments.manage']);
    if (row.status === 'withdrawn') return this.buildDetail(row);
    if (row.status === 'completed')
      throw new PreconditionError(
        'ENROLLMENT_COMPLETED',
        'This learner already completed the program, so the enrollment cannot be withdrawn.',
      );
    await this.db.transaction().execute(async (trx) => {
      const locked = await this.progress.lockEnrollment(trx, id);
      if (!locked || locked.status !== 'active')
        throw new ConflictError(
          'ENROLLMENT_CHANGED',
          'This enrollment changed while you were editing it. Reload and try again.',
        );
      await trx
        .updateTable('enrollments')
        .set({
          status: 'withdrawn',
          withdrawn_at: new Date(),
          withdrawn_by: p.userId,
          withdrawal_reason: reason ?? null,
        })
        .where('id', '=', id)
        .execute();
      await this.events.emit(
        trx,
        learningEvents.enrollmentWithdrawn,
        { enrollmentId: id, programId: row.program_id, userId: row.user_id },
        { organizationId: row.organization_id, subject: { type: 'enrollment', id } },
      );
      await this.events.audit(trx, {
        action: 'enrollment.withdrawn',
        resourceType: 'enrollment',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { status: row.status },
        after: { status: 'withdrawn' },
        reason: reason ?? null,
      });
    });
    return this.buildDetail(await this.visible(p, id, ['enrollments.manage']));
  }

  async setDueDate(
    p: Principal,
    id: string,
    dueAt: string | null,
  ): Promise<learning.EnrollmentDetail> {
    const row = await this.visible(p, id, ['programs.assign', 'enrollments.manage']);
    if (row.status === 'withdrawn')
      throw new PreconditionError(
        'ENROLLMENT_WITHDRAWN',
        'Re-enroll this person before changing the due date.',
      );
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('enrollments')
        .set({ due_at: dueAt ? new Date(dueAt) : null })
        .where('id', '=', id)
        .execute();
      await this.events.audit(trx, {
        action: 'enrollment.due_date_changed',
        resourceType: 'enrollment',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { dueAt: iso(row.due_at) },
        after: { dueAt },
      });
    });
    return this.buildDetail({
      ...(await this.visible(p, id, ['programs.assign', 'enrollments.manage'])),
    });
  }

  /** Manager override: complete a lesson on the learner's behalf, with a recorded reason. */
  async completeOnBehalf(
    p: Principal,
    id: string,
    lessonId: string,
    reason: string,
  ): Promise<learning.EnrollmentDetail> {
    const row = await this.visible(p, id, ['enrollments.manage']);
    if (row.user_id === p.userId)
      throw new ForbiddenError('You cannot complete lessons on your own behalf.');
    if (row.status === 'withdrawn')
      throw new PreconditionError(
        'ENROLLMENT_WITHDRAWN',
        'Re-enroll this person before recording progress.',
      );
    const tree = await this.trees.published(row.program_id);
    if (
      !tree ||
      !tree.phases.some((ph) => ph.modules.some((m) => m.lessons.some((l) => l.id === lessonId)))
    ) {
      throw new NotFoundError('Lesson');
    }
    await this.db.transaction().execute(async (trx) => {
      const locked = await this.progress.lockEnrollment(trx, id);
      if (!locked) throw new NotFoundError('Enrollment');
      const result = await this.progress.completeLesson(trx, {
        enrollment: locked,
        tree,
        lessonId,
        source: 'manager_override',
        completedBy: p.userId,
        data: { overrideReason: reason },
      });
      if (!result.changed)
        throw new ConflictError('ALREADY_COMPLETED', 'The learner already completed this lesson.');
      // An open sign-off or assignment review for this lesson is settled by the override.
      const open = await trx
        .updateTable('approval_requests')
        .set({
          status: 'approved',
          decided_by: p.userId,
          decided_by_name: p.displayName,
          decided_at: new Date(),
          comment: reason,
        })
        .where('enrollment_id', '=', id)
        .where('lesson_id', '=', lessonId)
        .where('status', '=', 'pending')
        .returningAll()
        .execute();
      for (const approval of open) {
        if (approval.submission_id) {
          await trx
            .updateTable('assignment_submissions')
            .set({
              status: 'approved',
              reviewed_by: p.userId,
              reviewed_by_name: p.displayName,
              reviewed_at: new Date(),
              feedback: reason,
            })
            .where('id', '=', approval.submission_id)
            .execute();
        }
        await this.events.emit(
          trx,
          learningEvents.approvalDecided,
          {
            enrollmentId: id,
            programId: row.program_id,
            userId: row.user_id,
            approvalId: approval.id,
            lessonId,
            lessonTitle: tree.phases
              .flatMap((ph) => ph.modules.flatMap((m) => m.lessons))
              .find((l) => l.id === lessonId)!.title,
            decision: 'approved',
            decidedBy: p.userId,
            comment: reason,
            kind: approval.kind,
          },
          { organizationId: row.organization_id, subject: { type: 'approval', id: approval.id } },
        );
      }
      await this.events.audit(trx, {
        action: 'lesson.completed_on_behalf',
        resourceType: 'enrollment',
        resourceId: id,
        actorDisplay: p.displayName,
        after: { lessonId, source: 'manager_override' },
        reason,
      });
    });
    return this.buildDetail(await this.visible(p, id, ['enrollments.manage']));
  }
}
