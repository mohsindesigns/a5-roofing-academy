import { Get, HttpCode, Post } from '@nestjs/common';
import type { z } from 'zod';
import type { Principal } from '@a5/auth';
import { assessment } from '@a5/contracts';
import {
  ApiController,
  CurrentPrincipal,
  RequirePermissions,
  ZBody,
  ZParam,
  ZQuery,
  ZResponse,
} from '@a5/nest-kit';
import { ReviewService } from './review.service.js';

@ApiController('attempts', 'attempt review')
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  /** Attempts within the reviewer's data scope. */
  @Get()
  @RequirePermissions('assessment_attempts.view')
  @ZResponse(assessment.reviewAttemptPageSchema)
  list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(assessment.listAttemptsQuerySchema)
    q: z.infer<typeof assessment.listAttemptsQuerySchema>,
  ) {
    return this.review.list(p, q);
  }

  /** Full attempt with answers, answer keys, grading and overrides. */
  @Get(':id/review')
  @RequirePermissions('assessment_attempts.view')
  @ZResponse(assessment.reviewAttemptDetailSchema)
  detail(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.review.detail(p, id);
  }

  @Post(':id/grades')
  @HttpCode(200)
  @RequirePermissions('assessment_attempts.grade')
  @ZResponse(assessment.reviewAttemptDetailSchema)
  grade(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(assessment.gradeAnswersRequestSchema)
    body: z.infer<typeof assessment.gradeAnswersRequestSchema>,
  ) {
    return this.review.grade(p, id, body.grades);
  }

  @Post(':id/override')
  @HttpCode(200)
  @RequirePermissions('assessment_scores.override')
  @ZResponse(assessment.reviewAttemptDetailSchema)
  override(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(assessment.overrideScoreRequestSchema)
    body: z.infer<typeof assessment.overrideScoreRequestSchema>,
  ) {
    return this.review.override(p, id, body);
  }
}
