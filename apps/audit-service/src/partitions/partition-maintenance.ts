import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { QueueFactory } from '@a5/messaging';
import { InjectDb, LOGGER, runsWorkers } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { AUDIT_CONFIG, type AuditConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { ensureUpcomingPartitions } from './partitions.js';

export const PARTITION_QUEUE = 'audit.partitions';

/**
 * Keeps the next months' partitions in place. Runs once at startup of every worker and then on a
 * BullMQ job scheduler (one scheduler id, so exactly one worker handles each interval). Creating
 * a partition is idempotent and serialized by an advisory lock inside the database function.
 */
@Injectable()
export class PartitionMaintenance implements OnApplicationBootstrap {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly queues: QueueFactory,
    @Inject(AUDIT_CONFIG) private readonly config: AuditConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!runsWorkers(this.config)) return;
    this.queues.worker(PARTITION_QUEUE, () => this.ensure(), { concurrency: 1 });
    try {
      await this.queues
        .queue(PARTITION_QUEUE)
        .upsertJobScheduler(
          'audit-partitions',
          { every: this.config.partitions.intervalMs },
          { name: 'ensure', opts: { attempts: 3 } },
        );
    } catch (err) {
      this.logger.error({ err }, 'could not schedule audit partition maintenance');
    }
    try {
      await this.ensure();
    } catch (err) {
      this.logger.error(
        { err },
        'audit partition check failed at startup; events keep landing in the default partition',
      );
    }
  }

  /** Create missing partitions for the current and upcoming months. Returns the names created. */
  async ensure(now = new Date()): Promise<string[]> {
    const created = await ensureUpcomingPartitions(
      this.db as never,
      this.config.partitions.monthsAhead,
      now,
    );
    if (created.length) this.logger.info({ created }, 'audit partitions created');
    return created;
  }
}
