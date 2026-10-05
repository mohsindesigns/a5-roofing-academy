import { Inject, Injectable } from '@nestjs/common';
import type { notification } from '@a5/contracts';
import { RealtimeBus } from '@a5/messaging';
import { LOGGER } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { NotificationsRepository } from '../inbox/notifications.repository.js';

/** Messages on the `rt:user:{id}` channel, consumed by whichever instance holds the user's stream. */
export type RealtimeNotificationMessage =
  | { type: 'notification.created'; data: { notification: notification.Notification; unreadCount: number } }
  | { type: 'notification.unread'; data: { unreadCount: number } };

/**
 * Pushes inbox changes to connected browsers through Redis pub/sub. Best effort: the inbox in
 * PostgreSQL is the source of truth, and clients refresh counts when they reconnect.
 */
@Injectable()
export class RealtimePublisher {
  constructor(
    private readonly bus: RealtimeBus,
    private readonly repo: NotificationsRepository,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async notificationsCreated(items: Array<{ userId: string; notification: notification.Notification }>): Promise<void> {
    if (items.length === 0) return;
    try {
      const counts = await this.repo.unreadCounts(items.map((i) => i.userId));
      await Promise.all(
        items.map((i) =>
          this.bus.publishToUser(i.userId, {
            type: 'notification.created',
            data: { notification: i.notification, unreadCount: counts.get(i.userId) ?? 0 },
          } satisfies RealtimeNotificationMessage),
        ),
      );
    } catch (err) {
      this.logger.warn({ err, count: items.length }, 'real-time push failed; notifications remain in the inbox');
    }
  }

  async unreadChanged(userId: string, unreadCount?: number): Promise<void> {
    try {
      const count = unreadCount ?? (await this.repo.unreadCount(userId));
      await this.bus.publishToUser(userId, { type: 'notification.unread', data: { unreadCount: count } } satisfies RealtimeNotificationMessage);
    } catch (err) {
      this.logger.warn({ err, userId }, 'real-time unread update failed');
    }
  }
}
