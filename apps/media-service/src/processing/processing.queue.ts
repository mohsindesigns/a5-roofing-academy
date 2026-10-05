import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDb, LOGGER, runsWorkers } from '@a5/nest-kit';
import { QueueFactory } from '@a5/messaging';
import type { Logger } from '@a5/observability';
import { MEDIA_CONFIG, type MediaConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { MediaProcessor } from './media-processor.js';

export const MEDIA_PROCESS_QUEUE = 'media.process';
export const MEDIA_MAINTENANCE_QUEUE = 'media.maintenance';

/** Uploads that were verified but never reached the queue (e.g. Redis outage) are re-enqueued. */
const STRANDED_AFTER_MS = 2 * 60_000;

@Injectable()
export class ProcessingQueue {
  constructor(private readonly queues: QueueFactory) {}

  /** Idempotent: the job id is the asset id, so duplicates collapse. */
  async enqueue(assetId: string): Promise<void> {
    await this.queues.add(
      MEDIA_PROCESS_QUEUE,
      'process',
      { assetId },
      { jobId: assetId, attempts: 4, backoff: { type: 'exponential', delay: 15_000 } },
    );
  }
}

/** Registers the `media.process` worker and the maintenance sweep in worker processes. */
@Injectable()
export class ProcessingWorker implements OnApplicationBootstrap {
  constructor(
    @Inject(MEDIA_CONFIG) private readonly config: MediaConfig,
    @InjectDb() private readonly db: Db,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly queues: QueueFactory,
    private readonly queue: ProcessingQueue,
    private readonly processor: MediaProcessor,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!runsWorkers(this.config)) return;
    this.queues.worker<{ assetId: string }>(
      MEDIA_PROCESS_QUEUE,
      async (job) => {
        const attempts = job.opts.attempts ?? 1;
        return this.processor.process(job.data.assetId, { finalAttempt: job.attemptsMade + 1 >= attempts });
      },
      { concurrency: this.config.media.processing.concurrency },
    );
    this.queues.worker(MEDIA_MAINTENANCE_QUEUE, async () => ({ requeued: await this.requeueStranded() }), { concurrency: 1 });
    await this.queues
      .queue(MEDIA_MAINTENANCE_QUEUE)
      .upsertJobScheduler('requeue-stranded-uploads', { every: 5 * 60_000 }, { name: 'requeue-stranded-uploads', data: {} });
    this.logger.info({ concurrency: this.config.media.processing.concurrency }, 'media processing worker started');
  }

  async requeueStranded(): Promise<number> {
    const rows = await this.db
      .selectFrom('media_assets')
      .select('id')
      .where('status', '=', 'uploaded')
      .where('updated_at', '<', new Date(Date.now() - STRANDED_AFTER_MS))
      .orderBy('updated_at')
      .limit(500)
      .execute();
    for (const row of rows) await this.queue.enqueue(row.id);
    if (rows.length) this.logger.info({ count: rows.length }, 're-enqueued uploads waiting for processing');
    return rows.length;
  }
}
