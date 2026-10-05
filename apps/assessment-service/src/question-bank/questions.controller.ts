import { Get, HttpCode, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@a5/auth';
import { assessment } from '@a5/contracts';
import { ApiController, CurrentPrincipal, RequirePermissions, ZBody, ZParam, ZQuery, ZResponse } from '@a5/nest-kit';
import { QuestionsService } from './questions.service.js';

@ApiController('questions')
export class QuestionsController {
  constructor(private readonly questions: QuestionsService) {}

  @Get()
  @RequirePermissions('assessments.view')
  @ZResponse(assessment.questionPageSchema)
  list(@CurrentPrincipal() p: Principal, @ZQuery(assessment.listQuestionsQuerySchema) q: z.infer<typeof assessment.listQuestionsQuerySchema>) {
    return this.questions.list(p, q);
  }

  /** Creates the question with version 1. */
  @Post()
  @RequirePermissions('assessments.create')
  @ZResponse(assessment.questionDetailSchema)
  create(@CurrentPrincipal() p: Principal, @ZBody(assessment.createQuestionRequestSchema) body: z.infer<typeof assessment.createQuestionRequestSchema>) {
    return this.questions.create(p, body);
  }

  @Get(':id')
  @RequirePermissions('assessments.view')
  @ZResponse(assessment.questionDetailSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.questions.get(p, id);
  }

  /** Saves a new immutable version (no-op when the content is unchanged). */
  @Put(':id')
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.questionDetailSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(assessment.updateQuestionRequestSchema) body: z.infer<typeof assessment.updateQuestionRequestSchema>,
  ) {
    return this.questions.update(p, id, body);
  }

  @Get(':id/versions')
  @RequirePermissions('assessments.view')
  @ZResponse(assessment.questionVersionListSchema)
  async versions(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return { items: await this.questions.versions(p, id) };
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.questionDetailSchema)
  archive(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.questions.setArchived(p, id, true);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.questionDetailSchema)
  restore(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.questions.setArchived(p, id, false);
  }

  @Get(':id/preview')
  @RequirePermissions('assessments.view')
  @ZResponse(assessment.questionPreviewSchema)
  preview(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZQuery(assessment.questionPreviewQuerySchema) q: { versionId?: string }) {
    return this.questions.preview(p, id, q.versionId);
  }

  /** Grade a sample answer against the question (nothing is stored). */
  @Post(':id/preview/check')
  @HttpCode(200)
  @RequirePermissions('assessments.view')
  @ZResponse(assessment.checkAnswerResultSchema)
  check(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(assessment.checkAnswerRequestSchema) body: z.infer<typeof assessment.checkAnswerRequestSchema>,
  ) {
    return this.questions.check(p, id, body);
  }
}
