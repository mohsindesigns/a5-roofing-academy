import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { QueueFactory, type Job } from '@a5/messaging';
import { InjectDb, LOGGER, runsWorkers } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { ANALYTICS_CONFIG, type AnalyticsConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { addDays, analyticsOrganizations, localDate, processDirtyDays, refreshRollups } from './rollup-builder.js';

export const ROLLUP_QUEUE = 'analytics.rollup';

type RollupJob =
  | { kind: 'dirty' }
  | { kind: 'full' }
  | { kind: 'refresh'; organizationId: string; from: string; to: string };

/**
 * Keeps `daily_rollups` current: a repeatable job rebuilds days flagged by the fact writers, a
 * nightly job rebuilds the trailing window (directory moves change team/location attribution),
 * and administrators can request a rebuild of any range on demand.
 */
@Injectable()
export class RollupService implements OnModuleInit {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(ANALYTICS_CONFIG) private readonly config: AnalyticsConfig,
    private readonly queues: QueueFactory,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onModuleInit() {
    if (!runsWorkers(this.config)) return;
    this.queues.worker<RollupJob>(ROLLUP_QUEUE, (job) => this.handle(job), { concurrency: 1 });
    const queue = this.queues.queue<RollupJob>(ROLLUP_QUEUE, { attempts: 3 });
    await queue.upsertJobScheduler(
      'analytics.rollup.dirty',
      { every: this.config.analytics.rollupIntervalMinutes * 60_000 },
      { name: 'dirty', data: { kind: 'dirty' } },
    );
    await queue.upsertJobScheduler(
      'analytics.rollup.nightly',
      { pattern: '17 3 * * *', tz: this.config.analytics.timezone },
      { name: 'full', data: { kind: 'full' } },
    );
  }

  private async handle(job: Job<RollupJob>): Promise<unknown> {
    const data = job.data;
    switch (data.kind) {
      case 'dirty':
        return processDirtyDays(this.db, this.config.analytics.timezone);
      case 'full':
        return this.refreshTrailing(this.config.analytics.rollupFullRefreshDays);
      case 'refresh':
        return { rows: await this.refresh(data.organizationId, data.from, data.to) };
    }
  }

  refresh(organizationId: string, from: string, to: string): Promise<number> {
    return refreshRollups(this.db, { organizationId, from, to, timezone: this.config.analytics.timezone });
  }

  async refreshTrailing(days: number, now = new Date()): Promise<{ organizations: number; rows: number }> {
    const to = localDate(now, this.config.analytics.timezone);
    const from = addDays(to, -(days - 1));
    let rows = 0;
    const orgs = await analyticsOrganizations(this.db);
    for (const org of orgs) rows += await this.refresh(org, from, to);
    this.logger.info({ organizations: orgs.length, rows, from, to }, 'analytics rollups rebuilt');
    return { organizations: orgs.length, rows };
  }

  /** Queue an on-demand rebuild; identical requests within the same minute collapse into one job. */
  async enqueueRefresh(organizationId: string, from: string, to: string): Promise<string> {
    const minute = Math.floor(Date.now() / 60_000);
    const jobId = `refresh.${organizationId}.${from}.${to}.${minute}`;
    await this.queues.add<RollupJob>(ROLLUP_QUEUE, 'refresh', { kind: 'refresh', organizationId, from, to }, { jobId, attempts: 3 });
    return jobId;
  }

  processDirty() {
    return processDirtyDays(this.db, this.config.analytics.timezone);
  }
}
