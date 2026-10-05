import { Get, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiProduces } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Principal } from '@a5/auth';
import { ApiController, CurrentPrincipal } from '@a5/nest-kit';
import { NotificationStreamService } from './stream.service.js';

@ApiController('notifications')
export class NotificationStreamController {
  constructor(private readonly streams: NotificationStreamService) {}

  /**
   * Server-sent events for the caller: `event: unread` (`{"count":n}`) on connect and on every
   * change, `event: notification` (id = notification id) for new notifications, and heartbeat
   * comments. Reconnects with `Last-Event-ID` replay what was missed.
   */
  @Get('stream')
  @ApiProduces('text/event-stream')
  @ApiOkResponse({ description: 'text/event-stream of unread counts and new notifications' })
  async stream(@CurrentPrincipal() p: Principal, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.streams.open(p, req, res);
  }
}
