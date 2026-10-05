import { Get, Put } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@a5/auth';
import { certification } from '@a5/contracts';
import { ApiController, CurrentPrincipal, RequireAnyPermission, RequirePermissions, ZBody, ZResponse } from '@a5/nest-kit';
import { SettingsService } from './settings.service.js';

@ApiController('certification-settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequireAnyPermission('settings.view', 'certifications.view')
  @ZResponse(certification.certificationSettingsSchema)
  get(@CurrentPrincipal() p: Principal) {
    return this.settings.get(p);
  }

  @Put()
  @RequirePermissions('settings.update')
  @ZResponse(certification.certificationSettingsSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZBody(certification.updateCertificationSettingsRequestSchema) body: z.infer<typeof certification.updateCertificationSettingsRequestSchema>,
  ) {
    return this.settings.update(p, body);
  }
}
