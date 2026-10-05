import { Get, Post } from '@nestjs/common';
import type { z } from 'zod';
import type { Principal } from '@a5/auth';
import { ai } from '@a5/contracts';
import { ApiController, CurrentPrincipal, RequirePermissions, ZBody, ZParam, ZQuery, ZResponse } from '@a5/nest-kit';
import { ReviewService } from './review.service.js';

@ApiController('ai/review', 'ai-review')
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  /** Sessions of people in the caller's scope (trainees, managed teams or the organization). */
  @Get('sessions')
  @RequirePermissions('ai_sessions.view')
  @ZResponse(ai.reviewSessionPageSchema)
  list(@CurrentPrincipal() p: Principal, @ZQuery(ai.reviewSessionsQuerySchema) q: z.infer<typeof ai.reviewSessionsQuerySchema>) {
    return this.review.list(p, q);
  }

  @Get('sessions/:id')
  @RequirePermissions('ai_sessions.view')
  @ZResponse(ai.reviewSessionDetailSchema)
  detail(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.review.detail(p, id);
  }

  @Post('sessions/:id/reviews')
  @RequirePermissions('ai_sessions.view', 'ai_sessions.review')
  @ZResponse(ai.reviewSessionDetailSchema)
  addReview(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZBody(ai.createReviewRequestSchema) body: ai.CreateReviewRequest) {
    return this.review.addReview(p, id, body);
  }
}
