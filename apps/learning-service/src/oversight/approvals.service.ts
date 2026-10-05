import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { learning } from '@a5/contracts';
import { paginate, sql, type Page, type SqlBool } from '@a5/database';
import { learningEvents } from '@a5/events';
import { ConflictError, EventBus, ForbiddenError, InjectDb, NotFoundError, PreconditionError } from '@a5/nest-kit';
import type { PermissionKey } from '@a5/permissions';
import { approvalSummaries } from '../common/approvals.js';
import { ScopeService } from '../common/scope.service.js';
import type { Db } from '../database/index.js';
import { ProgressService } from '../engine/progress.service.js';
import { lessonIndex } from '../engine/tree.js';
import { TreeService } from '../engine/tree.service.js';

/**
 * Who may decide: manager sign-offs need `approvals.decide`; assignment reviews accept
 * `approvals.decide` (managers) or `assessment_attempts.grade` (trainers grade written work).
 * Both are evaluated with the permission's data scope.
 */
const DECIDERS: Record<learning.ApprovalKind, PermissionKey[]> = {
  manager_approval: ['approvals.decide'],
  assignment_review: ['approvals.decide', 'assessment_attempts.grade'],
};

export interface ApprovalListFilters {
  status: learning.ApprovalStatus;
  kind?: learning.ApprovalKind;
  programId?: string;
  page: number;
  pageSize: number;
}

@Injectable()
export class ApprovalsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly events: EventBus,
    private readonly trees: TreeService,
    private readonly progress: ProgressService,
  ) {}

  async list(p: Principal, f: ApprovalListFilters): Promise<Page<learning.ApprovalSummary>> {
    const cols = { userColumn: 'a.user_id', orgColumn: 'a.organization_id' };
    const visible = sql<SqlBool>`(
      (a.kind = 'manager_approval' and ${this.scope.condition(p, DECIDERS.manager_approval, cols)})
      or (a.kind = 'assignment_review' and ${this.scope.condition(p, DECIDERS.assignment_review, cols)})
    )`;
    let query = this.db
      .selectFrom('approval_requests as a')
      .innerJoin('enrollments as e', 'e.id', 'a.enrollment_id')
      .selectAll('a')
      .where(visible)
      .where('a.user_id', '!=', p.userId)
      .where('e.status', '!=', 'withdrawn')
      .where('a.status', '=', f.status);
    if (f.kind) query = query.where('a.kind', '=', f.kind);
    if (f.programId) query = query.where('a.program_id', '=', f.programId);
    query = f.status === 'pending' ? query.orderBy('a.requested_at', 'asc') : query.orderBy('a.decided_at', 'desc');
    const page = await paginate(query.orderBy('a.id'), { page: f.page, pageSize: f.pageSize });
    return { ...page, items: await approvalSummaries(this.db, page.items) };
  }

  /** Approve (completes the lesson) or reject (learner can try again) a pending request. */
  async decide(p: Principal, id: string, input: { decision: 'approved' | 'rejected'; comment?: string | null }): Promise<learning.ApprovalSummary> {
    const approval = await this.db.selectFrom('approval_requests').selectAll().where('id', '=', id).where('organization_id', '=', p.organizationId).executeTakeFirst();
    if (!approval) throw new NotFoundError('Approval request');
    await this.scope.assertAdmits(p, DECIDERS[approval.kind], { userId: approval.user_id, organizationId: approval.organization_id }, 'Approval request');
    if (approval.user_id === p.userId) throw new ForbiddenError('You cannot decide on your own training. Ask your manager.');
    if (approval.status !== 'pending') throw new ConflictError('ALREADY_DECIDED', 'This request was already decided.');

    const tree = await this.trees.published(approval.program_id);
    if (!tree) throw new PreconditionError('PROGRAM_UNAVAILABLE', 'The program is no longer published.');
    const lesson = lessonIndex(tree).get(approval.lesson_id);

    await this.db.transaction().execute(async (trx) => {
      const enrollment = await this.progress.lockEnrollment(trx, approval.enrollment_id);
      if (!enrollment || enrollment.status === 'withdrawn') {
        throw new PreconditionError('ENROLLMENT_WITHDRAWN', 'This learner was withdrawn from the program. Re-enroll them before deciding.');
      }
      const decidedAt = new Date();
      const updated = await trx
        .updateTable('approval_requests')
        .set({ status: input.decision, decided_by: p.userId, decided_by_name: p.displayName, decided_at: decidedAt, comment: input.comment ?? null })
        .where('id', '=', id)
        .where('status', '=', 'pending')
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new ConflictError('ALREADY_DECIDED', 'This request was already decided.');
      if (approval.submission_id) {
        await trx
          .updateTable('assignment_submissions')
          .set({ status: input.decision, reviewed_by: p.userId, reviewed_by_name: p.displayName, reviewed_at: decidedAt, feedback: input.comment ?? null })
          .where('id', '=', approval.submission_id)
          .execute();
      }
      await this.events.emit(
        trx,
        learningEvents.approvalDecided,
        {
          enrollmentId: enrollment.id,
          programId: enrollment.program_id,
          userId: enrollment.user_id,
          approvalId: id,
          lessonId: approval.lesson_id,
          lessonTitle: lesson?.lesson.title ?? 'Lesson',
          decision: input.decision,
          decidedBy: p.userId,
          comment: input.comment ?? null,
          kind: approval.kind,
        },
        { organizationId: enrollment.organization_id, subject: { type: 'approval', id } },
      );
      if (input.decision === 'approved' && lesson) {
        await this.progress.completeLesson(trx, {
          enrollment,
          tree,
          lessonId: approval.lesson_id,
          source: 'approval',
          completedBy: p.userId,
          at: decidedAt,
        });
      } else if (input.decision === 'approved') {
        // The lesson was removed from the published program; record the decision only.
        await this.progress.sync(trx, enrollment, tree, { at: decidedAt });
      }
      await this.events.audit(trx, {
        action: `approval.${input.decision}`,
        resourceType: 'approval_request',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { status: 'pending' },
        after: { status: input.decision, kind: approval.kind, lessonId: approval.lesson_id, learnerId: approval.user_id },
        reason: input.comment ?? null,
      });
    });
    const row = await this.db.selectFrom('approval_requests').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    return (await approvalSummaries(this.db, [row]))[0]!;
  }
}
