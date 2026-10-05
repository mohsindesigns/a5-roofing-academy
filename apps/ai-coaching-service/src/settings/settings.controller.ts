import { Get, Put } from '@nestjs/common';
import type { z } from 'zod';
import type { Principal } from '@a5/auth';
import { ai } from '@a5/contracts';
import { ApiController, CurrentPrincipal, RequirePermissions, ZBody, ZQuery, ZResponse } from '@a5/nest-kit';
import { UsageService } from '../usage/usage.service.js';
import { SettingsService } from './settings.service.js';

@ApiController('ai/settings', 'ai-settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermissions('ai_settings.manage')
  @ZResponse(ai.aiSettingsSchema)
  get(@CurrentPrincipal() p: Principal) {
    return this.settings.view(p);
  }

  @Put()
  @RequirePermissions('ai_settings.manage')
  @ZResponse(ai.aiSettingsSchema)
  update(@CurrentPrincipal() p: Principal, @ZBody(ai.updateAiSettingsRequestSchema) body: ai.UpdateAiSettingsRequest) {
    return this.settings.update(p, body);
  }
}

@ApiController('ai/usage', 'ai-usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  /** Tokens and estimated cost by day, model, provider and purpose (default: last 30 days). */
  @Get()
  @RequirePermissions('ai_usage.view')
  @ZResponse(ai.usageReportSchema)
  report(@CurrentPrincipal() p: Principal, @ZQuery(ai.usageQuerySchema) q: z.infer<typeof ai.usageQuerySchema>) {
    return this.usage.report(p, q);
  }
}
