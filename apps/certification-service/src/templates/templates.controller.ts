import { Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@a5/auth';
import { certification } from '@a5/contracts';
import {
  ApiController,
  CurrentPrincipal,
  RequirePermissions,
  ZBody,
  ZParam,
  ZQuery,
  ZResponse,
} from '@a5/nest-kit';
import { PreviewService } from './preview.service.js';
import { TemplatesService } from './templates.service.js';

const c = certification;

@ApiController('certificate-templates')
export class TemplatesController {
  constructor(
    private readonly templates: TemplatesService,
    private readonly previews: PreviewService,
  ) {}

  @Get()
  @RequirePermissions('certificate_templates.view')
  @ZResponse(c.templateSummaryPageSchema)
  list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(c.listTemplatesQuerySchema) q: z.infer<typeof c.listTemplatesQuerySchema>,
  ) {
    return this.templates.list(p, { q: q.q, status: q.status, page: q.page, pageSize: q.pageSize });
  }

  @Get('starters')
  @RequirePermissions('certificate_templates.view')
  @ZResponse(z.object({ items: z.array(c.templateStarterSchema) }))
  starters() {
    return { items: this.templates.starters() };
  }

  @Get(':id')
  @RequirePermissions('certificate_templates.view')
  @ZResponse(c.templateDetailSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.templates.get(p, id);
  }

  @Get(':id/versions')
  @RequirePermissions('certificate_templates.view')
  @ZResponse(z.object({ items: z.array(c.templateVersionSchema) }))
  versions(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.templates.versions(p, id);
  }

  @Get(':id/versions/:versionId')
  @RequirePermissions('certificate_templates.view')
  @ZResponse(c.templateVersionDetailSchema)
  version(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('versionId') versionId: string,
  ) {
    return this.templates.version(p, id, versionId);
  }

  @Post()
  @RequirePermissions('certificate_templates.create')
  @ZResponse(c.templateDetailSchema)
  create(
    @CurrentPrincipal() p: Principal,
    @ZBody(c.createTemplateRequestSchema) body: z.infer<typeof c.createTemplateRequestSchema>,
  ) {
    return this.templates.create(p, body);
  }

  @Post(':id/clone')
  @RequirePermissions('certificate_templates.create')
  @ZResponse(c.templateDetailSchema)
  clone(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(c.cloneTemplateRequestSchema) body: { name: string },
  ) {
    return this.templates.clone(p, id, body.name);
  }

  @Patch(':id')
  @RequirePermissions('certificate_templates.update')
  @ZResponse(c.templateDetailSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(c.updateTemplateRequestSchema) body: z.infer<typeof c.updateTemplateRequestSchema>,
  ) {
    return this.templates.update(p, id, body);
  }

  @Put(':id/design')
  @RequirePermissions('certificate_templates.update')
  @ZResponse(c.templateDetailSchema)
  updateDesign(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(c.updateTemplateDesignRequestSchema)
    body: z.infer<typeof c.updateTemplateDesignRequestSchema>,
  ) {
    return this.templates.updateDesign(p, id, body.design, body.changeNote ?? null);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('certificate_templates.update')
  @ZResponse(c.templateDetailSchema)
  archive(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.templates.archive(p, id);
  }

  @Post(':id/default')
  @HttpCode(200)
  @RequirePermissions('certificate_templates.update')
  @ZResponse(c.templateDetailSchema)
  setDefault(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.templates.setDefault(p, id);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermissions('certificate_templates.update')
  @ZResponse(c.templateDetailSchema)
  assign(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(c.assignTemplateRequestSchema) body: { certificationIds: string[] },
  ) {
    return this.templates.assign(p, id, body.certificationIds);
  }

  @Post(':id/preview')
  @HttpCode(200)
  @RequirePermissions('certificate_templates.view')
  @ZResponse(c.templatePreviewSchema)
  preview(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(c.previewTemplateRequestSchema) body: z.infer<typeof c.previewTemplateRequestSchema>,
  ) {
    return this.previews.preview(p, id, body);
  }
}
