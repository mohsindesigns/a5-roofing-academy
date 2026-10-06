import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { QueueFactory } from '@a5/messaging';
import { LOGGER, runsWorkers } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { MEDIA_CONFIG, type MediaConfig } from '../config.js';
import { ProgressStore } from './progress-store.js';
import { WatchBuffer } from './watch-buffer.js';

export const PROGRESS_FLUSH_QUEUE = 'media.progress-flush';

const BATCH = 200;
const PARALLEL = 8;
/** Bound one run so a backlog (or a failing database) never produces an endless job. */
const MAX_KEYS_PER_RUN = 20_000;

/** Write-behind: persists dirty watch buffers to PostgreSQL on a schedule (default every 30 s). */
@Injectable()
export class ProgressFlushWorker implements OnApplicationBootstrap {
  constructor(
    @Inject(MEDIA_CONFIG) private readonly config: MediaConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly queues: QueueFactory,
    private readonly buffer: WatchBuffer,
    private readonly store: ProgressStore,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!runsWorkers(this.config)) return;
    this.queues.worker(PROGRESS_FLUSH_QUEUE, async () => this.flushDirty(), { concurrency: 1 });
    await this.queues
      .queue(PROGRESS_FLUSH_QUEUE, {
        attempts: 1,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      })
      .upsertJobScheduler(
        'flush-watch-progress',
        { every: this.config.media.progressFlushIntervalSeconds * 1000 },
        { name: 'flush-watch-progress', data: {} },
      );
  }

  async flushDirty(): Promise<{ flushed: number; failed: number }> {
    let flushed = 0;
    let failed = 0;
    while (flushed + failed < MAX_KEYS_PER_RUN) {
      const keys = await this.buffer.popDirty(BATCH);
      if (keys.length === 0) break;
      for (let i = 0; i < keys.length; i += PARALLEL) {
        await Promise.all(
          keys.slice(i, i + PARALLEL).map(async (key) => {
            try {
              await this.store.flushKey(key, { alreadyPopped: true });
              flushed++;
            } catch (err) {
              failed++;
              this.logger.error({ err, key }, 'watch progress flush failed; will retry');
            }
          }),
        );
      }
      if (failed > 0) break;
    }
    if (flushed || failed) this.logger.debug({ flushed, failed }, 'watch progress flushed');
    return { flushed, failed };
  }
}
