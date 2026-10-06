import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { certification } from '@a5/contracts';
import { likePattern, paginate, type Page } from '@a5/database';
import { DirectoryReader, userScopeCondition } from '@a5/directory';
import { certificationEvents } from '@a5/events';
import { ConflictError, EventBus, ForbiddenError, InjectDb, NotFoundError } from '@a5/nest-kit';
import type { Db } from '../database/index.js';
import { AccessService } from '../common/access.js';
import { personRef } from '../common/timeline.js';
import { EligibilityService } from '../eligibility/eligibility.service.js';

type ApprovalKind = 'manager' | 'trainer' | 'manual_review';

@Injectable()
export class ApprovalsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    private readonly access: AccessService,
    private readonly directory: DirectoryReader,
    private readonly eligibility: EligibilityService,
  ) {}

  private query() {
    return this.db
      .selectFrom('certificate_approvals as a')
      .innerJoin('certification_definitions as d', 'd.id', 'a.definition_id')
      .innerJoin('certification_candidates as c', 'c.id', 'a.candidate_id')
      .leftJoin('dir_users as u', 'u.id', 'a.user_id')
      .select([
        'a.id',
        'a.status',
        'a.kind',
        'a.requested_at',
        'a.decided_at',
        'a.decided_by',
        'a.decided_by_name',
        'a.comment',
        'a.user_id',
        'a.organization_id',
        'a.cycle',
        'd.id as definition_id',
        'd.name as definition_name',
        'd.code as definition_code',
        'c.certificate_id',
        'c.requirements',
        'c.met_count',
        'c.total_count',
        'u.display_name',
        'u.employee_id',
        'u.job_title',
      ]);
  }

  private dto(
    r: Awaited<ReturnType<ReturnType<ApprovalsService['query']>['executeTakeFirstOrThrow']>>,
  ): certification.Approval {
    return {
      id: r.id,
      status: r.status,
      kind: r.kind,
      requestedAt: r.requested_at.toISOString(),
      decidedAt: r.decided_at?.toISOString() ?? null,
      decidedBy: personRef(r.decided_by, r.decided_by_name),
      comment: r.comment,
      definition: { id: r.definition_id, name: r.definition_name, code: r.definition_code },
      user: {
        id: r.user_id,
        displayName: r.display_name ?? 'Unknown person',
        employeeId: r.employee_id,
        jobTitle: r.job_title,
      },
      progress: { metCount: r.met_count, totalCount: r.total_count, requirements: r.requirements },
      certificateId: r.certificate_id,
    };
  }

  /** Approval queue limited to the people the caller may approve (`certificate_approvals.decide`). */
  async list(
    p: Principal,
    f: {
      q?: string;
      status?: Array<'pending' | 'approved' | 'rejected' | 'cancelled'>;
      definitionId?: string;
      page: number;
      pageSize: number;
    },
  ): Promise<Page<certification.Approval>> {
    let q = this.query()
      .where('a.organization_id', '=', p.organizationId)
      .where(
        userScopeCondition(p.scopeFilter('certificate_approvals.decide'), {
          userColumn: 'a.user_id',
          orgColumn: 'a.organization_id',
        }),
      )
      .where('a.status', 'in', f.status?.length ? f.status : ['pending']);
    if (f.definitionId) q = q.where('a.definition_id', '=', f.definitionId);
    if (f.q)
      q = q.where((eb) =>
        eb.or([
          eb('u.display_name', 'ilike', likePattern(f.q!)),
          eb('u.employee_id', 'ilike', likePattern(f.q!)),
        ]),
      );
    const status = f.status?.length ? f.status : ['pending'];
    q =
      status.length === 1 && status[0] === 'pending'
        ? q.orderBy('a.requested_at').orderBy('a.id')
        : q.orderBy('a.requested_at', 'desc').orderBy('a.id');
    const page = await paginate(q, f);
    return { ...page, items: page.items.map((r) => this.dto(r)) };
  }

  /**
   * Who may decide: managers decide for people in their scope; trainer approvals need the person's
   * trainer (or organization-wide scope); manual review needs organization-wide scope.
   * Nobody approves their own certification.
   */
  private async assertCanDecide(
    p: Principal,
    approval: { user_id: string; organization_id: string; kind: ApprovalKind },
  ): Promise<void> {
    await this.access.assertAdmits(
      p,
      'certificate_approvals.decide',
      { userId: approval.user_id, organizationId: approval.organization_id },
      'Approval request',
    );
    if (approval.user_id === p.userId)
      throw new ForbiddenError('You cannot decide your own certification. Ask another approver.');
    const scope = p.scopeOf('certificate_approvals.decide');
    const wide = scope === 'organization' || scope === 'platform';
    if (approval.kind === 'manual_review' && !wide) {
      throw new ForbiddenError(
        'Manual review needs an administrator with organization-wide approval access.',
      );
    }
    if (approval.kind === 'trainer' && !wide) {
      const trainers = await this.directory.trainersOf(approval.user_id);
      if (!trainers.includes(p.userId))
        throw new ForbiddenError(
          'Only this person’s trainer or an administrator can approve this certification.',
        );
    }
  }

  async get(p: Principal, id: string): Promise<certification.Approval> {
    const row = await this.query()
      .where('a.id', '=', id)
      .where('a.organization_id', '=', p.organizationId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Approval request');
    await this.access.assertAdmits(
      p,
      'certificate_approvals.decide',
      { userId: row.user_id, organizationId: row.organization_id },
      'Approval request',
    );
    return this.dto(row);
  }

  async decide(
    p: Principal,
    id: string,
    input: { decision: 'approved' | 'rejected'; comment?: string | null },
  ): Promise<certification.Approval> {
    const existing = await this.query()
      .where('a.id', '=', id)
      .where('a.organization_id', '=', p.organizationId)
      .executeTakeFirst();
    if (!existing) throw new NotFoundError('Approval request');
    await this.assertCanDecide(p, existing);
    const now = new Date();
    await this.db.transaction().execute(async (trx) => {
      const approval = await trx
        .selectFrom('certificate_approvals')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (approval.status !== 'pending') {
        throw new ConflictError(
          'ALREADY_DECIDED',
          `This request was already ${approval.status}${approval.decided_by_name ? ` by ${approval.decided_by_name}` : ''}.`,
        );
      }
      const def = await trx
        .selectFrom('certification_definitions')
        .select(['name'])
        .where('id', '=', approval.definition_id)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('certificate_approvals')
        .set({
          status: input.decision,
          decided_at: now,
          decided_by: p.userId,
          decided_by_name: p.displayName,
          comment: input.comment ?? null,
        })
        .where('id', '=', id)
        .execute();
      if (input.decision === 'rejected') {
        await trx
          .updateTable('certification_candidates')
          .set({ status: 'rejected', rejected_at: now })
          .where('id', '=', approval.candidate_id)
          .where('status', '<>', 'issued')
          .execute();
      }
      await this.events.emit(
        trx,
        certificationEvents.approvalDecided,
        {
          approvalId: id,
          definitionId: approval.definition_id,
          definitionName: def.name,
          userId: approval.user_id,
          decision: input.decision,
          decidedBy: p.userId,
          comment: input.comment ?? null,
        },
        { organizationId: approval.organization_id, subject: { type: 'certificate_approval', id } },
      );
      await this.events.audit(trx, {
        action:
          input.decision === 'approved'
            ? 'certificate_approval.approved'
            : 'certificate_approval.rejected',
        resourceType: 'certificate_approval',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { status: 'pending' },
        after: {
          status: input.decision,
          userId: approval.user_id,
          definitionId: approval.definition_id,
        },
        reason: input.comment ?? null,
      });
    });
    // Approved: the evaluation now sees the approval, then issues automatically or marks the person approved.
    if (input.decision === 'approved')
      await this.eligibility.evaluate(existing.definition_id, existing.user_id);
    return this.get(p, id);
  }
}
