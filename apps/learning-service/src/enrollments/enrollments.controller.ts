import { Get, HttpCode, Post, Put } from '@nestjs/common';
import type { z } from 'zod';
import type { Principal } from '@a5/auth';
import { learning } from '@a5/contracts';
import {
  ApiController,
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermissions,
  ZBody,
  ZParam,
  ZQuery,
  ZResponse,
} from '@a5/nest-kit';
import { EnrollmentsService } from './enrollments.service.js';

type Out<T extends z.ZodType> = z.output<T>;

/** Assignments and their progress, limited to the caller's data scope. */
@ApiController('enrollments')
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @Get()
  @RequirePermissions('enrollments.view')
  @ZResponse(learning.enrollmentPageSchema)
  list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(learning.listEnrollmentsQuerySchema) q: Out<typeof learning.listEnrollmentsQuerySchema>,
  ) {
    return this.enrollments.list(p, {
      q: q.q,
      programId: q.programId,
      teamId: q.teamId,
      userId: q.userId,
      status: q.status,
      overdue: q.overdue,
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  /** Bulk enroll. Idempotent: active enrollments are unchanged, withdrawn ones are reactivated. */
  @Post()
  @HttpCode(200)
  @RequirePermissions('programs.assign')
  @ZResponse(learning.bulkEnrollResultSchema)
  enroll(
    @CurrentPrincipal() p: Principal,
    @ZBody(learning.enrollRequestSchema) body: Out<typeof learning.enrollRequestSchema>,
  ) {
    return this.enrollments.enroll(p, body);
  }

  @Get(':id')
  @RequirePermissions('enrollments.view')
  @ZResponse(learning.enrollmentDetailSchema)
  detail(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.enrollments.detail(p, id);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @RequirePermissions('enrollments.manage')
  @ZResponse(learning.enrollmentDetailSchema)
  withdraw(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(learning.withdrawEnrollmentRequestSchema)
    body: Out<typeof learning.withdrawEnrollmentRequestSchema>,
  ) {
    return this.enrollments.withdraw(p, id, body.reason);
  }

  @Put(':id/due-date')
  @RequireAnyPermission('programs.assign', 'enrollments.manage')
  @ZResponse(learning.enrollmentDetailSchema)
  setDueDate(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(learning.setDueDateRequestSchema) body: Out<typeof learning.setDueDateRequestSchema>,
  ) {
    return this.enrollments.setDueDate(p, id, body.dueAt);
  }

  @Post(':id/lessons/:lessonId/complete')
  @HttpCode(200)
  @RequirePermissions('enrollments.manage')
  @ZResponse(learning.enrollmentDetailSchema)
  completeOnBehalf(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('lessonId') lessonId: string,
    @ZBody(learning.overrideCompletionRequestSchema)
    body: Out<typeof learning.overrideCompletionRequestSchema>,
  ) {
    return this.enrollments.completeOnBehalf(p, id, lessonId, body.reason);
  }
}
