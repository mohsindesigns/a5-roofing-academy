import { Delete, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import type { z } from 'zod';
import type { Principal } from '@a5/auth';
import { assessment, okSchema } from '@a5/contracts';
import { ApiController, CurrentPrincipal, RequirePermissions, ZBody, ZParam, ZQuery, ZResponse } from '@a5/nest-kit';
import { AssessmentsService } from './assessments.service.js';
import { StatsService } from './stats.service.js';

@ApiController('assessments')
export class AssessmentsController {
  constructor(
    private readonly assessments: AssessmentsService,
    private readonly statistics: StatsService,
  ) {}

  @Get()
  @RequirePermissions('assessments.view')
  @ZResponse(assessment.assessmentPageSchema)
  list(@CurrentPrincipal() p: Principal, @ZQuery(assessment.listAssessmentsQuerySchema) q: z.infer<typeof assessment.listAssessmentsQuerySchema>) {
    return this.assessments.list(p, q);
  }

  @Post()
  @RequirePermissions('assessments.create')
  @ZResponse(assessment.assessmentDetailSchema)
  create(@CurrentPrincipal() p: Principal, @ZBody(assessment.createAssessmentRequestSchema) body: z.infer<typeof assessment.createAssessmentRequestSchema>) {
    return this.assessments.create(p, body);
  }

  @Get(':id')
  @RequirePermissions('assessments.view')
  @ZResponse(assessment.assessmentDetailSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.assessments.get(p, id);
  }

  @Patch(':id')
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.assessmentDetailSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(assessment.updateAssessmentRequestSchema) body: z.infer<typeof assessment.updateAssessmentRequestSchema>,
  ) {
    return this.assessments.update(p, id, body);
  }

  @Delete(':id')
  @RequirePermissions('assessments.update')
  @ZResponse(okSchema)
  async remove(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    await this.assessments.delete(p, id);
    return { ok: true as const };
  }

  @Post(':id/duplicate')
  @RequirePermissions('assessments.create')
  @ZResponse(assessment.assessmentDetailSchema)
  duplicate(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(assessment.duplicateAssessmentRequestSchema) body: z.infer<typeof assessment.duplicateAssessmentRequestSchema>,
  ) {
    return this.assessments.duplicate(p, id, body.title);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.assessmentDetailSchema)
  publish(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.assessments.publish(p, id);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.assessmentDetailSchema)
  archive(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.assessments.archive(p, id);
  }

  @Get(':id/validation')
  @RequirePermissions('assessments.view')
  @ZResponse(assessment.assessmentValidationSchema)
  validation(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.assessments.validation(p, id);
  }

  /** Draw a sample attempt with its answer key; nothing is stored. */
  @Post(':id/preview')
  @HttpCode(200)
  @RequirePermissions('assessments.view')
  @ZResponse(assessment.assessmentPreviewSchema)
  preview(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.assessments.preview(p, id);
  }

  @Get(':id/stats')
  @RequirePermissions('assessments.view')
  @ZResponse(assessment.assessmentStatsSchema)
  stats(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.statistics.stats(p, id);
  }

  // ---------------------------------------------------------------- items

  @Put(':id/items')
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.assessmentDetailSchema)
  replaceItems(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(assessment.replaceAssessmentItemsRequestSchema) body: z.infer<typeof assessment.replaceAssessmentItemsRequestSchema>,
  ) {
    return this.assessments.replaceItems(p, id, body.items);
  }

  @Post(':id/items')
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.assessmentDetailSchema)
  addItem(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(assessment.addAssessmentItemRequestSchema) body: z.infer<typeof assessment.addAssessmentItemRequestSchema>,
  ) {
    return this.assessments.addItem(p, id, body);
  }

  @Put(':id/items/:itemId')
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.assessmentDetailSchema)
  updateItem(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('itemId') itemId: string,
    @ZBody(assessment.updateAssessmentItemRequestSchema) body: z.infer<typeof assessment.updateAssessmentItemRequestSchema>,
  ) {
    return this.assessments.updateItem(p, id, itemId, body);
  }

  @Delete(':id/items/:itemId')
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.assessmentDetailSchema)
  deleteItem(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZParam('itemId') itemId: string) {
    return this.assessments.deleteItem(p, id, itemId);
  }
}
