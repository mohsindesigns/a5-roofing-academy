import { Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@a5/auth';
import { assessment, okSchema } from '@a5/contracts';
import { ApiController, CurrentPrincipal, RequirePermissions, ZBody, ZParam, ZQuery, ZResponse } from '@a5/nest-kit';
import { BanksService } from './banks.service.js';

@ApiController('question-banks')
export class BanksController {
  constructor(private readonly banks: BanksService) {}

  @Get()
  @RequirePermissions('assessments.view')
  @ZResponse(assessment.questionBankPageSchema)
  list(@CurrentPrincipal() p: Principal, @ZQuery(assessment.listQuestionBanksQuerySchema) q: z.infer<typeof assessment.listQuestionBanksQuerySchema>) {
    return this.banks.list(p, q);
  }

  @Post()
  @RequirePermissions('assessments.create')
  @ZResponse(assessment.questionBankDetailSchema)
  create(@CurrentPrincipal() p: Principal, @ZBody(assessment.createQuestionBankRequestSchema) body: z.infer<typeof assessment.createQuestionBankRequestSchema>) {
    return this.banks.create(p, body);
  }

  @Get(':id')
  @RequirePermissions('assessments.view')
  @ZResponse(assessment.questionBankDetailSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.banks.get(p, id);
  }

  @Patch(':id')
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.questionBankDetailSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(assessment.updateQuestionBankRequestSchema) body: z.infer<typeof assessment.updateQuestionBankRequestSchema>,
  ) {
    return this.banks.update(p, id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.questionBankDetailSchema)
  archive(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.banks.setArchived(p, id, true);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.questionBankDetailSchema)
  restore(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.banks.setArchived(p, id, false);
  }

  @Delete(':id')
  @RequirePermissions('assessments.update')
  @ZResponse(okSchema)
  async remove(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    await this.banks.delete(p, id);
    return { ok: true as const };
  }

  // ---------------------------------------------------------------- categories

  @Get(':id/categories')
  @RequirePermissions('assessments.view')
  @ZResponse(z.object({ items: z.array(assessment.questionCategorySchema) }))
  async categories(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    const bank = await this.banks.get(p, id);
    return { items: bank.categories };
  }

  @Post(':id/categories')
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.questionCategorySchema)
  createCategory(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(assessment.createCategoryRequestSchema) body: z.infer<typeof assessment.createCategoryRequestSchema>,
  ) {
    return this.banks.createCategory(p, id, body);
  }

  @Patch(':id/categories/:categoryId')
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.questionCategorySchema)
  updateCategory(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('categoryId') categoryId: string,
    @ZBody(assessment.updateCategoryRequestSchema) body: z.infer<typeof assessment.updateCategoryRequestSchema>,
  ) {
    return this.banks.updateCategory(p, id, categoryId, body);
  }

  @Delete(':id/categories/:categoryId')
  @RequirePermissions('assessments.update')
  @ZResponse(okSchema)
  async deleteCategory(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZParam('categoryId') categoryId: string) {
    await this.banks.deleteCategory(p, id, categoryId);
    return { ok: true as const };
  }

  // ---------------------------------------------------------------- competencies

  @Get(':id/competencies')
  @RequirePermissions('assessments.view')
  @ZResponse(z.object({ items: z.array(assessment.competencySchema) }))
  async competencies(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    const bank = await this.banks.get(p, id);
    return { items: bank.competencies };
  }

  @Post(':id/competencies')
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.competencySchema)
  createCompetency(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(assessment.createCompetencyRequestSchema) body: z.infer<typeof assessment.createCompetencyRequestSchema>,
  ) {
    return this.banks.createCompetency(p, id, body);
  }

  @Patch(':id/competencies/:competencyId')
  @RequirePermissions('assessments.update')
  @ZResponse(assessment.competencySchema)
  updateCompetency(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('competencyId') competencyId: string,
    @ZBody(assessment.updateCompetencyRequestSchema) body: z.infer<typeof assessment.updateCompetencyRequestSchema>,
  ) {
    return this.banks.updateCompetency(p, id, competencyId, body);
  }

  @Delete(':id/competencies/:competencyId')
  @RequirePermissions('assessments.update')
  @ZResponse(okSchema)
  async deleteCompetency(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZParam('competencyId') competencyId: string) {
    await this.banks.deleteCompetency(p, id, competencyId);
    return { ok: true as const };
  }
}
