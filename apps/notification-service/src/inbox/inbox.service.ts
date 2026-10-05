import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { notification } from '@a5/contracts';
import { NotFoundError } from '@a5/nest-kit';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { NotificationsRepository, toNotificationDto } from './notifications.repository.js';

/** The caller's own notifications. Nobody can read another person's inbox. */
@Injectable()
export class InboxService {
  constructor(
    private readonly repo: NotificationsRepository,
    private readonly realtime: RealtimePublisher,
  ) {}

  async list(p: Principal, q: notification.ListNotificationsQuery): Promise<notification.NotificationPage> {
    const [page, unreadCount] = await Promise.all([
      this.repo.list(p.userId, p.organizationId, { limit: q.limit, cursor: q.cursor, unread: q.unread, category: q.category }),
      this.repo.unreadCount(p.userId),
    ]);
    return { ...page, unreadCount };
  }

  async unreadCount(p: Principal): Promise<notification.UnreadCount> {
    return { count: await this.repo.unreadCount(p.userId) };
  }

  async markRead(p: Principal, id: string): Promise<notification.Notification> {
    const updated = await this.repo.markRead(p.userId, id);
    if (updated) {
      await this.realtime.unreadChanged(p.userId);
      return toNotificationDto(updated);
    }
    // Already read (idempotent) or not the caller's: do not disclose which.
    const existing = await this.repo.find(p.userId, id);
    if (!existing) throw new NotFoundError('Notification');
    return toNotificationDto(existing);
  }

  async markAllRead(p: Principal): Promise<notification.MarkAllReadResponse> {
    const updated = await this.repo.markAllRead(p.userId, p.organizationId);
    const unreadCount = await this.repo.unreadCount(p.userId);
    if (updated > 0) await this.realtime.unreadChanged(p.userId, unreadCount);
    return { updated, unreadCount };
  }
}
