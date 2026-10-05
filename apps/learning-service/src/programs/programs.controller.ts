import { Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@a5/auth';
import { learning } from '@a5/contracts';
import { ApiController, CurrentPrincipal, RequirePermissions, ZBody, ZParam, ZQuery, ZResponse } from '@a5/nest-kit';
import { ProgramsService } from './programs.service.js';
import { PublishService } from './publish.service.js';

type Out<T extends z.ZodType> = z.output<T>;

/** Program builder: catalogue, settings, publishing, versions, audiences and prerequisites. */
@ApiController('programs')
export class ProgramsController {
  constructor(
    private readonly programs: ProgramsService,
    private readonly publisher: PublishService,
  ) {}

  @Get()
  @RequirePermissions('programs.view')
  @ZResponse(learning.programPageSchema)
  list(@CurrentPrincipal() p: Principal, @ZQuery(learning.listProgramsQuerySchema) q: Out<typeof learning.listProgramsQuerySchema>) {
    return this.programs.list(p, { q: q.q, status: q.status, category: q.category, sort: q.sort, page: q.page, pageSize: q.pageSize });
  }

  @Post()
  @RequirePermissions('programs.create')
  @ZResponse(learning.programDetailSchema)
  create(@CurrentPrincipal() p: Principal, @ZBody(learning.createProgramRequestSchema) body: Out<typeof learning.createProgramRequestSchema>) {
    return this.programs.create(p, body);
  }

  @Get(':id')
  @RequirePermissions('programs.view')
  @ZResponse(learning.programDetailSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.programs.get(p, id);
  }

  @Patch(':id')
  @RequirePermissions('programs.update')
  @ZResponse(learning.programDetailSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(learning.updateProgramRequestSchema) body: Out<typeof learning.updateProgramRequestSchema>,
  ) {
    return this.programs.update(p, id, body);
  }

  @Post(':id/duplicate')
  @RequirePermissions('programs.create')
  @ZResponse(learning.programDetailSchema)
  duplicate(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(learning.duplicateProgramRequestSchema) body: Out<typeof learning.duplicateProgramRequestSchema>,
  ) {
    return this.programs.duplicate(p, id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('programs.archive')
  @ZResponse(learning.programDetailSchema)
  archive(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.programs.archive(p, id);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermissions('programs.archive')
  @ZResponse(learning.programDetailSchema)
  restore(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.programs.restore(p, id);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @RequirePermissions('programs.publish')
  @ZResponse(learning.publishResultSchema)
  publish(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(learning.publishProgramRequestSchema) body: Out<typeof learning.publishProgramRequestSchema>,
  ) {
    return this.publisher.publish(p, id, body.changeNote);
  }

  @Get(':id/versions')
  @RequirePermissions('programs.view')
  @ZResponse(z.object({ items: z.array(learning.programVersionSchema) }))
  async versions(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return { items: await this.programs.versions(p, id) };
  }

  @Get(':id/versions/:version')
  @RequirePermissions('programs.view')
  @ZResponse(learning.programVersionDetailSchema)
  version(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZParam('version', z.coerce.number().int().min(1)) version: number) {
    return this.programs.version(p, id, version);
  }

  @Put(':id/audiences')
  @RequirePermissions('programs.update')
  @ZResponse(learning.programDetailSchema)
  setAudiences(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(learning.setAudiencesRequestSchema) body: Out<typeof learning.setAudiencesRequestSchema>,
  ) {
    return this.programs.setAudiences(p, id, body.audiences);
  }

  @Put(':id/prerequisites')
  @RequirePermissions('programs.update')
  @ZResponse(learning.programDetailSchema)
  setPrerequisites(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(learning.setPrerequisitesRequestSchema) body: Out<typeof learning.setPrerequisitesRequestSchema>,
  ) {
    return this.programs.setPrerequisites(p, id, body.programIds);
  }

  @Get(':id/preview')
  @RequirePermissions('programs.view')
  @ZResponse(learning.outlineSchema)
  preview(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZQuery(learning.previewQuerySchema) q: Out<typeof learning.previewQuerySchema>) {
    return this.programs.preview(p, id, q.source);
  }
}
