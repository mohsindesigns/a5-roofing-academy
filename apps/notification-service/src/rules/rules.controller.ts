import { Get, HttpCode, Patch, Post } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { notification } from '@a5/contracts';
import { ApiController, CurrentPrincipal, RequirePermissions, ZBody, ZParam, ZQuery, ZResponse } from '@a5/nest-kit';
import { RulesService } from './rules.service.js';

@ApiController('notification-rules')
@RequirePermissions('notifications.manage')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get()
  @ZResponse(notification.ruleListSchema)
  list(@CurrentPrincipal() p: Principal, @ZQuery(notification.listRulesQuerySchema) q: notification.ListRulesQuery) {
    return this.rules.list(p, q);
  }

  @Get(':id')
  @ZResponse(notification.notificationRuleSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.rules.get(p, id);
  }

  @Patch(':id')
  @ZResponse(notification.notificationRuleSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(notification.updateRuleRequestSchema) body: notification.UpdateRuleRequest,
  ) {
    return this.rules.update(p, id, body);
  }

  @Post(':id/enable')
  @HttpCode(200)
  @ZResponse(notification.notificationRuleSchema)
  enable(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.rules.setEnabled(p, id, true);
  }

  @Post(':id/disable')
  @HttpCode(200)
  @ZResponse(notification.notificationRuleSchema)
  disable(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.rules.setEnabled(p, id, false);
  }
}
