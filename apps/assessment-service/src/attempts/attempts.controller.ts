import { Get, HttpCode, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
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
import { AttemptsService } from './attempts.service.js';

/** Learner entry point of an assessment opened from a lesson (or standalone). */
@ApiController('assessments', 'attempts')
export class LearnerAssessmentsController {
  constructor(private readonly attempts: AttemptsService) {}

  @Get(':id/intro')
  @RequirePermissions('assessments.take')
  @ZResponse(assessment.assessmentIntroSchema)
  intro(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZQuery(assessment.assessmentIntroQuerySchema) q: { grant?: string },
  ) {
    return this.attempts.intro(p, id, q.grant);
  }
}

@ApiController('attempts')
export class AttemptsController {
  constructor(private readonly attempts: AttemptsService) {}

  /** Starts an attempt (201) or resumes the learner's open attempt (200). */
  @Post()
  @RequirePermissions('assessments.take')
  @ZResponse(assessment.learnerAttemptSchema)
  async start(
    @CurrentPrincipal() p: Principal,
    @ZBody(assessment.startAttemptRequestSchema)
    body: z.infer<typeof assessment.startAttemptRequestSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { attempt, created } = await this.attempts.start(p, body);
    res.status(created ? 201 : 200);
    return attempt;
  }

  @Get('mine')
  @RequirePermissions('assessments.take')
  @ZResponse(assessment.myAttemptsSchema)
  async mine(
    @CurrentPrincipal() p: Principal,
    @ZQuery(assessment.myAttemptsQuerySchema) q: { assessmentId?: string },
  ) {
    return { items: await this.attempts.mine(p, q.assessmentId) };
  }

  /** The learner's own attempt, without answer keys. */
  @Get(':id')
  @RequirePermissions('assessments.take')
  @ZResponse(assessment.learnerAttemptSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.attempts.get(p, id);
  }

  /** Autosave one answer (idempotent; refused once the attempt is submitted or expired). */
  @Put(':id/answers/:attemptQuestionId')
  @RequirePermissions('assessments.take')
  @ZResponse(assessment.saveAnswerResultSchema)
  saveAnswer(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('attemptQuestionId') attemptQuestionId: string,
    @ZBody(assessment.saveAnswerRequestSchema)
    body: z.infer<typeof assessment.saveAnswerRequestSchema>,
  ) {
    return this.attempts.saveAnswer(p, id, attemptQuestionId, body);
  }

  /** Submit (idempotent: repeating it returns the same result). */
  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermissions('assessments.take')
  @ZResponse(assessment.attemptResultSchema)
  submit(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.attempts.submit(p, id);
  }

  /** Result honouring the assessment's reveal policies. */
  @Get(':id/result')
  @RequirePermissions('assessments.take')
  @ZResponse(assessment.attemptResultSchema)
  result(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.attempts.result(p, id);
  }
}
