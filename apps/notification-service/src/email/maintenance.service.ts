import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { sql } from '@a5/database';
import { QueueFactory } from '@a5/messaging';
import { InjectDb, LOGGER, runsWorkers } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { NOTIFICATION_CONFIG, type NotificationConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { EMAIL_QUEUE, EmailDispatcher, emailJobId } from './email.dispatcher.js';

export const MAINTENANCE_QUEUE = 'notification.maintenance';
/** Queued deliveries older than this without progress are re-enqueued. */
const STALE_QUEUED_MINUTES = 2;
/** Security emails not delivered within this window are abandoned (their links are short-lived). */
const SEALED_TTL_HOURS = 24;
const BATCH = 500;

export interface MaintenanceResult {
  requeued: number;
  abandoned: number;
  expiredSealed: number;
  deletedNotifications: number;
  deletedDeliveries: number;
}

/**
 * Periodic housekeeping, scheduled through BullMQ so exactly one worker runs it per interval:
 * recovers email jobs lost between commit and enqueue, abandons undeliverable security emails
 * and applies retention.
 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly queues: QueueFactory,
    private readonly email: EmailDispatcher,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!runsWorkers(this.config)) return;
    this.queues.worker(MAINTENANCE_QUEUE, () => this.runOnce(), { concurrency: 1 });
    try {
      await this.queues
        .queue(MAINTENANCE_QUEUE)
        .upsertJobScheduler('notification-maintenance', { every: this.config.maintenanceIntervalMs }, { name: 'sweep', opts: { attempts: 1 } });
    } catch (err) {
      this.logger.error({ err }, 'could not schedule notification maintenance');
    }
  }

  async runOnce(): Promise<MaintenanceResult> {
    const expiredSealed = await this.expireSealed();
    const { requeued, abandoned } = await this.requeueStale();
    const { notifications, deliveries } = await this.applyRetention();
    const result = { requeued, abandoned, expiredSealed, deletedNotifications: notifications, deletedDeliveries: deliveries };
    if (requeued || abandoned || expiredSealed || notifications || deliveries) this.logger.info(result, 'notification maintenance');
    return result;
  }

  private async expireSealed(): Promise<number> {
    const result = await this.db
      .updateTable('email_deliveries')
      .set({
        status: 'failed',
        failed_at: sql<Date>`now()`,
        sealed_content: null,
        last_error: `Not delivered within ${SEALED_TTL_HOURS} hours; the link inside has been discarded. Request a new one.`,
      })
      .where('status', '=', 'queued')
      .where('sensitive', '=', true)
      .where('scheduled_at', '<', sql<Date>`now() - make_interval(hours => ${SEALED_TTL_HOURS})`)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0n);
  }

  private async requeueStale(): Promise<{ requeued: number; abandoned: number }> {
    const stale = await this.db
      .selectFrom('email_deliveries')
      .select(['id', 'scheduled_at'])
      .where('status', '=', 'queued')
      .where('scheduled_at', '<', sql<Date>`now() - make_interval(mins => ${STALE_QUEUED_MINUTES})`)
      .orderBy('scheduled_at')
      .limit(BATCH)
      .execute();
    const queue = this.queues.queue(EMAIL_QUEUE);
    let requeued = 0;
    let abandoned = 0;
    for (const row of stale) {
      const job = await queue.getJob(emailJobId(row.id));
      const state = job ? await job.getState() : null;
      if (state === 'failed') {
        // The final attempt failed but its status update was lost: record the outcome.
        await this.db
          .updateTable('email_deliveries')
          .set({ status: 'failed', failed_at: sql<Date>`now()`, sealed_content: null, last_error: (job?.failedReason ?? 'Delivery failed').slice(0, 1000) })
          .where('id', '=', row.id)
          .where('status', '=', 'queued')
          .execute();
        abandoned++;
      } else if (!job) {
        await this.email.enqueue(row.id);
        requeued++;
      }
    }
    return { requeued, abandoned };
  }

  private async applyRetention(): Promise<{ notifications: number; deliveries: number }> {
    const days = this.config.retentionDays;
    const n = await sql<{ count: number }>`
      with doomed as (
        select id from notifications
        where read_at < now() - make_interval(days => ${days})
        limit 5000
      )
      delete from notifications where id in (select id from doomed)
    `.execute(this.db);
    const d = await sql<{ count: number }>`
      with doomed as (
        select id from email_deliveries
        where status <> 'queued' and created_at < now() - make_interval(days => ${days})
        limit 5000
      )
      delete from email_deliveries where id in (select id from doomed)
    `.execute(this.db);
    return { notifications: Number(n.numAffectedRows ?? 0n), deliveries: Number(d.numAffectedRows ?? 0n) };
  }
}
