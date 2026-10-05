import { Get, HttpCode, Post, Put } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { notification } from '@a5/contracts';
import { ApiController, CurrentPrincipal, ZBody, ZParam, ZQuery, ZResponse } from '@a5/nest-kit';
import { InboxService } from './inbox.service.js';
import { PreferencesService } from './preferences.service.js';

/** Every signed-in person has an inbox; no permission beyond authentication is required. */
@ApiController('notifications')
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly preferences: PreferencesService,
  ) {}

  @Get()
  @ZResponse(notification.notificationPageSchema)
  list(@CurrentPrincipal() p: Principal, @ZQuery(notification.listNotificationsQuerySchema) q: notification.ListNotificationsQuery) {
    return this.inbox.list(p, q);
  }

  @Get('unread-count')
  @ZResponse(notification.unreadCountSchema)
  unreadCount(@CurrentPrincipal() p: Principal) {
    return this.inbox.unreadCount(p);
  }

  @Post('read-all')
  @HttpCode(200)
  @ZResponse(notification.markAllReadResponseSchema)
  readAll(@CurrentPrincipal() p: Principal) {
    return this.inbox.markAllRead(p);
  }

  @Get('preferences')
  @ZResponse(notification.preferencesResponseSchema)
  getPreferences(@CurrentPrincipal() p: Principal) {
    return this.preferences.list(p);
  }

  @Put('preferences')
  @ZResponse(notification.preferencesResponseSchema)
  updatePreferences(
    @CurrentPrincipal() p: Principal,
    @ZBody(notification.updatePreferencesRequestSchema) body: notification.UpdatePreferencesRequest,
  ) {
    return this.preferences.update(p, body);
  }

  @Post(':id/read')
  @HttpCode(200)
  @ZResponse(notification.notificationSchema)
  markRead(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.inbox.markRead(p, id);
  }
}
