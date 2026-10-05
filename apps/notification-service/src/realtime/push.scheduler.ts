import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { QueueFactory } from '@a5/messaging';
import { LOGGER, SERVICE_CONFIG, runsWorkers, type ServiceRuntimeConfig } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { NotificationsRepository, toNotificationDto } from '../inbox/notifications.repository.js';
import { RealtimePublisher } from './realtime.publisher.js';

export const PUSH_QUEUE = 'notification.push';

/**
 * Real-time pushes for notifications from rules with a delay: they appear in the inbox at
 * `available_at` (the inbox query filters on it); this job announces them to open streams then.
 */
@Injectable()
export class DelayedPushScheduler implements OnModuleInit {
  constructor(
    private readonly queues: QueueFactory,
    private readonly repo: NotificationsRepository,
    private readonly realtime: RealtimePublisher,
    @Inject(SERVICE_CONFIG) private readonly config: ServiceRuntimeConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    if (!runsWorkers(this.config)) return;
    this.queues.worker<{ notificationId: string }>(PUSH_QUEUE, (job) => this.push(job.data.notificationId));
  }

  async schedule(notificationId: string, delayMs: number): Promise<void> {
    try {
      await this.queues.add(PUSH_QUEUE, 'push', { notificationId }, { jobId: `push-${notificationId}`, delay: Math.max(0, delayMs), attempts: 3 });
    } catch (err) {
      this.logger.warn({ err, notificationId }, 'could not schedule delayed push; the notification still appears in the inbox');
    }
  }

  async push(notificationId: string): Promise<void> {
    const row = await this.repo.findById(notificationId);
    if (!row || row.read_at) return;
    await this.realtime.notificationsCreated([{ userId: row.user_id, notification: toNotificationDto(row) }]);
  }
}
