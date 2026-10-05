import { Get, HttpCode, Patch, Post } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { notification } from '@a5/contracts';
import { ApiController, CurrentPrincipal, RequirePermissions, ZBody, ZParam, ZQuery, ZResponse } from '@a5/nest-kit';
import { TemplatesService } from './templates.service.js';

@ApiController('notification-templates')
@RequirePermissions('notifications.manage')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @ZResponse(notification.templateListSchema)
  list(@CurrentPrincipal() p: Principal, @ZQuery(notification.listTemplatesQuerySchema) q: notification.ListTemplatesQuery) {
    return this.templates.list(p, q);
  }

  @Get(':id')
  @ZResponse(notification.notificationTemplateSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.templates.get(p, id);
  }

  @Patch(':id')
  @ZResponse(notification.notificationTemplateSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(notification.updateTemplateRequestSchema) body: notification.UpdateTemplateRequest,
  ) {
    return this.templates.update(p, id, body);
  }

  /** Render with sample data (optionally unsaved subject/body) to see the result before saving. */
  @Post(':id/preview')
  @HttpCode(200)
  @ZResponse(notification.templatePreviewSchema)
  preview(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(notification.previewTemplateRequestSchema) body: notification.PreviewTemplateRequest,
  ) {
    return this.templates.preview(p, id, body);
  }

  @Post(':id/reset')
  @HttpCode(200)
  @ZResponse(notification.notificationTemplateSchema)
  reset(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.templates.reset(p, id);
  }
}
