import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { sql } from '@a5/database';
import { QueueFactory, type Job, type JobData } from '@a5/messaging';
import { InjectDb, LOGGER, runsWorkers } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { NOTIFICATION_CONFIG, type NotificationConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { ContentSealer } from './sealer.js';
import { EMAIL_TRANSPORT, type EmailTransport } from './transports.js';

export const EMAIL_QUEUE = 'notification.email';

export interface EmailJob {
  deliveryId: string;
}

export interface SealedEmailContent {
  text: string;
  html: string;
}

/** Deterministic job id: re-enqueueing a delivery collapses onto the existing job. */
export function emailJobId(deliveryId: string): string {
  return `email-${deliveryId}`;
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 1000);
}

/**
 * Sends queued email deliveries through the configured transport. `email_deliveries` is the
 * durable record (an outbox of its own): a row is written in the event transaction, the job only
 * carries its id, and the maintenance sweep re-enqueues rows whose job was lost.
 */
@Injectable()
export class EmailDispatcher implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly queues: QueueFactory,
    private readonly sealer: ContentSealer,
    @Inject(EMAIL_TRANSPORT) private readonly transport: EmailTransport,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    if (!runsWorkers(this.config)) return;
    this.queues.worker<EmailJob>(EMAIL_QUEUE, (job) => this.process(job), {
      concurrency: this.config.email.concurrency,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.transport.close?.();
  }

  async enqueue(deliveryId: string, delayMs = 0): Promise<void> {
    await this.queues.add<EmailJob>(
      EMAIL_QUEUE,
      'send',
      { deliveryId },
      {
        jobId: emailJobId(deliveryId),
        attempts: this.config.email.maxAttempts,
        backoff: { type: 'exponential', delay: this.config.email.backoffMs },
        delay: Math.max(0, delayMs),
      },
    );
  }

  /** Enqueue after commit; failures are logged and recovered by the maintenance sweep. */
  async enqueueMany(items: Array<{ id: string; scheduledAt: Date }>): Promise<void> {
    const now = Date.now();
    for (const item of items) {
      try {
        await this.enqueue(item.id, item.scheduledAt.getTime() - now);
      } catch (err) {
        this.logger.warn(
          { err, deliveryId: item.id },
          'could not enqueue email; the maintenance sweep will retry',
        );
      }
    }
  }

  async process(job: Job<JobData<EmailJob>>): Promise<'sent' | 'skipped'> {
    const { deliveryId } = job.data;
    const row = await this.db
      .selectFrom('email_deliveries')
      .selectAll()
      .where('id', '=', deliveryId)
      .executeTakeFirst();
    if (!row || row.status !== 'queued') return 'skipped';

    let content: SealedEmailContent;
    if (row.sensitive) {
      if (!row.sealed_content) {
        await this.fail(
          deliveryId,
          'The message content is no longer available. Request a new link.',
        );
        return 'skipped';
      }
      try {
        content = this.sealer.unseal<SealedEmailContent>(row.sealed_content);
      } catch (err) {
        await this.fail(
          deliveryId,
          `Sealed content could not be opened (${errorMessage(err)}). Request a new link.`,
        );
        return 'skipped';
      }
    } else {
      content = { text: row.body_text ?? '', html: row.body_html ?? '' };
    }

    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    try {
      const result = await this.transport.send({
        from: this.config.email.from,
        replyTo: this.config.email.replyTo,
        to: row.to_address,
        toName: row.to_name,
        subject: row.subject,
        text: content.text,
        html: content.html,
        headers: { 'X-A5-Delivery-Id': row.id, 'X-A5-Notification-Type': row.notification_type },
      });
      await this.db
        .updateTable('email_deliveries')
        .set({
          status: 'sent',
          attempts: sql<number>`attempts + 1`,
          last_attempt_at: sql<Date>`now()`,
          sent_at: sql<Date>`now()`,
          provider_message_id: result.messageId,
          last_error: null,
          sealed_content: null,
        })
        .where('id', '=', deliveryId)
        .where('status', '=', 'queued')
        .execute();
      return 'sent';
    } catch (err) {
      await this.db
        .updateTable('email_deliveries')
        .set({
          attempts: sql<number>`attempts + 1`,
          last_attempt_at: sql<Date>`now()`,
          last_error: errorMessage(err),
          ...(finalAttempt
            ? { status: 'failed' as const, failed_at: sql<Date>`now()`, sealed_content: null }
            : {}),
        })
        .where('id', '=', deliveryId)
        .where('status', '=', 'queued')
        .execute();
      // Rethrow so BullMQ retries with backoff; the final failure is copied to notification.email.dlq.
      throw err;
    }
  }

  private async fail(deliveryId: string, error: string): Promise<void> {
    await this.db
      .updateTable('email_deliveries')
      .set({
        status: 'failed',
        failed_at: sql<Date>`now()`,
        last_error: error,
        sealed_content: null,
      })
      .where('id', '=', deliveryId)
      .where('status', '=', 'queued')
      .execute();
    this.logger.warn({ deliveryId, error }, 'email delivery abandoned');
  }
}
