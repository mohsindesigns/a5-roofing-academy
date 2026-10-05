import { Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import type { z } from 'zod';
import type { Principal } from '@a5/auth';
import { learning } from '@a5/contracts';
import { ApiController, CurrentPrincipal, RequirePermissions, ZBody, ZParam, ZResponse } from '@a5/nest-kit';
import { StructureService } from './structure.service.js';

type Out<T extends z.ZodType> = z.output<T>;

/** Lesson editor: content, type configuration, unlock rule, order and resources. */
@ApiController('lessons')
export class LessonsController {
  constructor(private readonly structure: StructureService) {}

  @Post()
  @RequirePermissions('lessons.create')
  @ZResponse(learning.adminLessonSchema)
  create(@CurrentPrincipal() p: Principal, @ZBody(learning.createLessonRequestSchema) body: Out<typeof learning.createLessonRequestSchema>) {
    return this.structure.createLesson(p, body);
  }

  @Get(':id')
  @RequirePermissions('programs.view')
  @ZResponse(learning.adminLessonSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.structure.lesson(p, id);
  }

  @Patch(':id')
  @RequirePermissions('lessons.update')
  @ZResponse(learning.adminLessonSchema)
  update(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZBody(learning.updateLessonRequestSchema) body: Out<typeof learning.updateLessonRequestSchema>) {
    return this.structure.updateLesson(p, id, body);
  }

  @Post(':id/move')
  @HttpCode(200)
  @RequirePermissions('lessons.update')
  @ZResponse(learning.programDetailSchema)
  move(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZBody(learning.moveLessonRequestSchema) body: Out<typeof learning.moveLessonRequestSchema>) {
    return this.structure.moveLesson(p, id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('lessons.update')
  @ZResponse(learning.adminLessonSchema)
  archive(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.structure.setLessonArchived(p, id, true);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermissions('lessons.update')
  @ZResponse(learning.adminLessonSchema)
  restore(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.structure.setLessonArchived(p, id, false);
  }

  @Post(':id/duplicate')
  @RequirePermissions('lessons.create')
  @ZResponse(learning.adminLessonSchema)
  duplicate(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.structure.duplicateLesson(p, id);
  }

  @Delete(':id')
  @RequirePermissions('lessons.delete')
  @ZResponse(learning.deleteResultSchema)
  remove(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.structure.deleteLesson(p, id);
  }

  @Get(':id/resources')
  @RequirePermissions('programs.view')
  @ZResponse(learning.lessonResourceListSchema)
  async resources(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return { items: await this.structure.resources(p, id) };
  }

  @Post(':id/resources')
  @RequirePermissions('lessons.update')
  @ZResponse(learning.lessonResourceListSchema)
  async addResource(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(learning.lessonResourceRequestSchema) body: Out<typeof learning.lessonResourceRequestSchema>,
  ) {
    return { items: await this.structure.addResource(p, id, body) };
  }

  @Patch(':id/resources/:resourceId')
  @RequirePermissions('lessons.update')
  @ZResponse(learning.lessonResourceListSchema)
  async updateResource(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('resourceId') resourceId: string,
    @ZBody(learning.updateLessonResourceRequestSchema) body: Out<typeof learning.updateLessonResourceRequestSchema>,
  ) {
    return { items: await this.structure.updateResource(p, id, resourceId, body) };
  }

  @Delete(':id/resources/:resourceId')
  @RequirePermissions('lessons.update')
  @ZResponse(learning.lessonResourceListSchema)
  async deleteResource(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZParam('resourceId') resourceId: string) {
    return { items: await this.structure.deleteResource(p, id, resourceId) };
  }
}
