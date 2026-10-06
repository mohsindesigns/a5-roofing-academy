import { Delete, HttpCode, Patch, Post } from '@nestjs/common';
import type { z } from 'zod';
import type { Principal } from '@a5/auth';
import { learning } from '@a5/contracts';
import {
  ApiController,
  CurrentPrincipal,
  RequirePermissions,
  ZBody,
  ZParam,
  ZResponse,
} from '@a5/nest-kit';
import { StructureService } from './structure.service.js';

type Out<T extends z.ZodType> = z.output<T>;

/** Phases ("weeks") and modules of a program. Every route returns the refreshed builder view. */
@ApiController('programs')
export class StructureController {
  constructor(private readonly structure: StructureService) {}

  @Post(':id/phases')
  @RequirePermissions('lessons.create')
  @ZResponse(learning.programDetailSchema)
  createPhase(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(learning.createPhaseRequestSchema) body: Out<typeof learning.createPhaseRequestSchema>,
  ) {
    return this.structure.createPhase(p, id, body);
  }

  @Patch(':id/phases/:phaseId')
  @RequirePermissions('lessons.update')
  @ZResponse(learning.programDetailSchema)
  updatePhase(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('phaseId') phaseId: string,
    @ZBody(learning.updatePhaseRequestSchema) body: Out<typeof learning.updatePhaseRequestSchema>,
  ) {
    return this.structure.updatePhase(p, id, phaseId, body);
  }

  @Post(':id/phases/:phaseId/move')
  @HttpCode(200)
  @RequirePermissions('lessons.update')
  @ZResponse(learning.programDetailSchema)
  movePhase(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('phaseId') phaseId: string,
    @ZBody(learning.movePhaseRequestSchema) body: Out<typeof learning.movePhaseRequestSchema>,
  ) {
    return this.structure.movePhase(p, id, phaseId, body.position);
  }

  @Post(':id/phases/:phaseId/archive')
  @HttpCode(200)
  @RequirePermissions('lessons.update')
  @ZResponse(learning.programDetailSchema)
  archivePhase(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('phaseId') phaseId: string,
  ) {
    return this.structure.setPhaseArchived(p, id, phaseId, true);
  }

  @Post(':id/phases/:phaseId/restore')
  @HttpCode(200)
  @RequirePermissions('lessons.update')
  @ZResponse(learning.programDetailSchema)
  restorePhase(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('phaseId') phaseId: string,
  ) {
    return this.structure.setPhaseArchived(p, id, phaseId, false);
  }

  @Delete(':id/phases/:phaseId')
  @RequirePermissions('lessons.delete')
  @ZResponse(learning.deleteResultSchema)
  deletePhase(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('phaseId') phaseId: string,
  ) {
    return this.structure.deletePhase(p, id, phaseId);
  }

  @Post(':id/modules')
  @RequirePermissions('lessons.create')
  @ZResponse(learning.programDetailSchema)
  createModule(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(learning.createModuleRequestSchema) body: Out<typeof learning.createModuleRequestSchema>,
  ) {
    return this.structure.createModule(p, id, body);
  }

  @Patch(':id/modules/:moduleId')
  @RequirePermissions('lessons.update')
  @ZResponse(learning.programDetailSchema)
  updateModule(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('moduleId') moduleId: string,
    @ZBody(learning.updateModuleRequestSchema) body: Out<typeof learning.updateModuleRequestSchema>,
  ) {
    return this.structure.updateModule(p, id, moduleId, body);
  }

  @Post(':id/modules/:moduleId/move')
  @HttpCode(200)
  @RequirePermissions('lessons.update')
  @ZResponse(learning.programDetailSchema)
  moveModule(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('moduleId') moduleId: string,
    @ZBody(learning.moveModuleRequestSchema) body: Out<typeof learning.moveModuleRequestSchema>,
  ) {
    return this.structure.moveModule(p, id, moduleId, body);
  }

  @Post(':id/modules/:moduleId/archive')
  @HttpCode(200)
  @RequirePermissions('lessons.update')
  @ZResponse(learning.programDetailSchema)
  archiveModule(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('moduleId') moduleId: string,
  ) {
    return this.structure.setModuleArchived(p, id, moduleId, true);
  }

  @Post(':id/modules/:moduleId/restore')
  @HttpCode(200)
  @RequirePermissions('lessons.update')
  @ZResponse(learning.programDetailSchema)
  restoreModule(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('moduleId') moduleId: string,
  ) {
    return this.structure.setModuleArchived(p, id, moduleId, false);
  }

  @Delete(':id/modules/:moduleId')
  @RequirePermissions('lessons.delete')
  @ZResponse(learning.deleteResultSchema)
  deleteModule(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('moduleId') moduleId: string,
  ) {
    return this.structure.deleteModule(p, id, moduleId);
  }
}
