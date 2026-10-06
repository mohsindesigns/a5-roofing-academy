import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { QueueFactory } from '@a5/messaging';
import { InjectDb, LOGGER, runsWorkers } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { CERTIFICATION_CONFIG, type CertificationConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { EligibilityService } from '../eligibility/eligibility.service.js';
import { IssuanceService } from '../issuance/issuance.service.js';
import { PdfService } from '../issuance/pdf.service.js';
import { LifecycleService } from './lifecycle.service.js';
import { QUEUES, type PdfJobData } from './queues.js';

/**
 * Background work: the PDF worker, the daily lifecycle and reminder schedulers and the sweeper that
 * recovers certificates stuck without a PDF and evaluations that were marked but not yet processed.
 * Workers only start in `worker`/`all` roles.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly queues: QueueFactory,
    private readonly pdf: PdfService,
    private readonly lifecycle: LifecycleService,
    private readonly eligibility: EligibilityService,
    private readonly issuance: IssuanceService,
    @Inject(CERTIFICATION_CONFIG) private readonly config: CertificationConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!runsWorkers(this.config)) return;
    this.queues.worker<PdfJobData>(
      QUEUES.pdf,
      async (job) => {
        try {
          const outcome = await this.pdf.generate(job.data.certificateId);
          return { outcome };
        } catch (err) {
          const attempts = job.opts.attempts ?? 1;
          await this.pdf.recordFailure(
            job.data.certificateId,
            err,
            job.attemptsMade + 1 >= attempts,
          );
          throw err;
        }
      },
      { concurrency: this.config.certification.pdfConcurrency },
    );
    this.queues.worker(QUEUES.expiry, async () => this.lifecycle.runDaily(), { concurrency: 1 });
    this.queues.worker(
      QUEUES.reminders,
      async () => ({ reminders: await this.lifecycle.sendReminders() }),
      { concurrency: 1 },
    );
    try {
      await this.queues
        .queue(QUEUES.expiry)
        .upsertJobScheduler(
          'daily',
          { pattern: this.config.certification.lifecycleCron, tz: 'UTC' },
          { name: 'run', data: {} },
        );
      await this.queues
        .queue(QUEUES.reminders)
        .upsertJobScheduler(
          'daily',
          { pattern: this.config.certification.remindersCron, tz: 'UTC' },
          { name: 'run', data: {} },
        );
    } catch (err) {
      this.logger.error({ err }, 'could not register certification schedulers');
    }
    this.timer = setInterval(() => void this.sweep(), this.config.certification.sweepIntervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sweeper pass; also callable on demand (tests, admin tooling). */
  async sweep(now = new Date()): Promise<{ pdfRequeued: number; evaluated: number }> {
    if (this.sweeping) return { pdfRequeued: 0, evaluated: 0 };
    this.sweeping = true;
    try {
      const evaluated = await this.eligibility.processDirty({ limit: 200 });
      const cutoff = new Date(
        now.getTime() - this.config.certification.pdfStuckAfterSeconds * 1000,
      );
      const stuck = await this.db
        .selectFrom('issued_certificates')
        .select('id')
        .where('pdf_status', '=', 'pending')
        .where('created_at', '<=', cutoff)
        .orderBy('created_at')
        .limit(100)
        .execute();
      let pdfRequeued = 0;
      for (const row of stuck) {
        if (await this.requeue(row.id)) pdfRequeued++;
      }
      return { pdfRequeued, evaluated };
    } catch (err) {
      this.logger.error({ err }, 'certification sweep failed');
      return { pdfRequeued: 0, evaluated: 0 };
    } finally {
      this.sweeping = false;
    }
  }

  /** Re-enqueue unless the job is still alive; a finished job holding the id is replaced. */
  private async requeue(certificateId: string): Promise<boolean> {
    const queue = this.queues.queue<PdfJobData>(QUEUES.pdf);
    const existing = await queue.getJob(certificateId);
    if (existing) {
      const state = await existing.getState();
      if (
        state === 'active' ||
        state === 'waiting' ||
        state === 'delayed' ||
        state === 'prioritized' ||
        state === 'waiting-children'
      )
        return false;
      await existing.remove().catch(() => undefined);
    }
    await this.issuance.enqueuePdf(certificateId);
    return true;
  }
}
