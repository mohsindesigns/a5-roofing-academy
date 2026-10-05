import { Get, HttpCode, Post } from '@nestjs/common';
import type { z } from 'zod';
import type { Principal } from '@a5/auth';
import { learning } from '@a5/contracts';
import { ApiController, CurrentPrincipal, RequireAnyPermission, ZBody, ZParam, ZQuery, ZResponse } from '@a5/nest-kit';
import { ApprovalsService } from './approvals.service.js';

type Out<T extends z.ZodType> = z.output<T>;

/** Approval queue for manager sign-offs and assignment reviews. */
@ApiController('learning/approvals', 'learning')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequireAnyPermission('approvals.decide', 'assessment_attempts.grade')
  @ZResponse(learning.approvalPageSchema)
  list(@CurrentPrincipal() p: Principal, @ZQuery(learning.listApprovalsQuerySchema) q: Out<typeof learning.listApprovalsQuerySchema>) {
    return this.approvals.list(p, { status: q.status, kind: q.kind, programId: q.programId, page: q.page, pageSize: q.pageSize });
  }

  @Post(':id/decision')
  @HttpCode(200)
  @RequireAnyPermission('approvals.decide', 'assessment_attempts.grade')
  @ZResponse(learning.approvalSummarySchema)
  decide(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(learning.decideApprovalRequestSchema) body: Out<typeof learning.decideApprovalRequestSchema>,
  ) {
    return this.approvals.decide(p, id, body);
  }
}
