import { Get, HttpCode, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@a5/auth';
import { certification } from '@a5/contracts';
import { ApiController, CurrentPrincipal, RequireAnyPermission, RequirePermissions, ZBody, ZParam, ZQuery, ZResponse } from '@a5/nest-kit';
import { DefinitionsService } from './definitions.service.js';

const c = certification;

@ApiController('certifications')
export class DefinitionsController {
  constructor(private readonly definitions: DefinitionsService) {}

  @Get()
  @RequirePermissions('certifications.view')
  @ZResponse(c.certificationSummaryPageSchema)
  list(@CurrentPrincipal() p: Principal, @ZQuery(c.listCertificationsQuerySchema) q: z.infer<typeof c.listCertificationsQuerySchema>) {
    return this.definitions.list(p, { q: q.q, status: q.status, page: q.page, pageSize: q.pageSize });
  }

  @Get(':id')
  @RequirePermissions('certifications.view')
  @ZResponse(c.certificationDetailSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.definitions.get(p, id);
  }

  @Post()
  @RequirePermissions('certifications.create')
  @ZResponse(c.certificationDetailSchema)
  create(@CurrentPrincipal() p: Principal, @ZBody(c.createCertificationRequestSchema) body: certification.CreateCertificationRequest) {
    return this.definitions.create(p, body);
  }

  @Patch(':id')
  @RequirePermissions('certifications.update')
  @ZResponse(c.certificationDetailSchema)
  update(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZBody(c.updateCertificationRequestSchema) body: certification.UpdateCertificationRequest) {
    return this.definitions.update(p, id, body);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermissions('certifications.update')
  @ZResponse(c.certificationDetailSchema)
  activate(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.definitions.activate(p, id);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('certifications.update')
  @ZResponse(c.certificationDetailSchema)
  archive(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.definitions.archive(p, id);
  }

  /** "6 / 8 requirements complete" for the caller, or for someone in scope with certificates.view. */
  @Get(':id/progress')
  @RequireAnyPermission('certificates.view_own', 'certificates.view')
  @ZResponse(c.progressSchema)
  progress(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZQuery(c.progressQuerySchema) q: { userId?: string }) {
    return this.definitions.progress(p, id, q.userId);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermissions('certifications.update')
  @ZResponse(c.progressSchema)
  reopen(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZBody(c.reopenCandidateRequestSchema) body: { userId: string; note?: string | null }) {
    return this.definitions.reopen(p, id, body.userId, body.note ?? null);
  }
}
