import pg from 'pg';
import { OUTBOX_NOTIFY_CHANNEL, sql, type Kysely, type OutboxSchema } from '@a5/database';
import type { EventEnvelope } from '@a5/events';
import type { Logger } from '@a5/observability';
import type { StreamPublisher } from './publisher.js';

export interface OutboxRelayOptions {
  db: Kysely<OutboxSchema>;
  /** Connection string used for a dedicated LISTEN connection. */
  databaseUrl: string;
  publisher: StreamPublisher;
  logger: Logger;
  batchSize?: number;
  pollIntervalMs?: number;
  /** Published rows older than this are deleted. */
  retentionHours?: number;
}

/**
 * Moves committed outbox rows to Redis streams. Wakes on NOTIFY and also polls, so a missed
 * notification only delays delivery. Several relays can run concurrently (SKIP LOCKED).
 * Delivery is at-least-once; consumers deduplicate through their inbox.
 */
export class OutboxRelay {
  private listener: pg.Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private draining: Promise<void> | null = null;
  private wake = false;
  private lastPrune = 0;

  constructor(private readonly options: OutboxRelayOptions) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.listener = new pg.Client({ connectionString: this.options.databaseUrl });
      this.listener.on('notification', () => this.trigger());
      this.listener.on('error', (err) => {
        this.options.logger.warn({ err }, 'outbox listener connection error; falling back to polling');
      });
      await this.listener.connect();
      await this.listener.query(`listen ${OUTBOX_NOTIFY_CHANNEL}`);
    } catch (err) {
      this.options.logger.warn({ err }, 'outbox LISTEN unavailable; polling only');
      this.listener = null;
    }
    const interval = this.options.pollIntervalMs ?? 1_000;
    this.timer = setInterval(() => this.trigger(), interval);
    this.trigger();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.draining;
    await this.listener?.end().catch(() => undefined);
    this.listener = null;
  }

  /** Coalesces concurrent wake-ups into one drain loop. */
  trigger(): void {
    if (!this.running) return;
    if (this.draining) {
      this.wake = true;
      return;
    }
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (this.wake && this.running) {
        this.wake = false;
        this.trigger();
      }
    });
  }

  private async drain(): Promise<void> {
    try {
      let published: number;
      do {
        published = await this.relayBatch();
      } while (published > 0 && this.running);
      await this.pruneIfDue();
    } catch (err) {
      this.options.logger.error({ err }, 'outbox relay batch failed');
    }
  }

  /** Publish one batch. Returns the number of events published. Exposed for tests. */
  async relayBatch(): Promise<number> {
    const { db, publisher } = this.options;
    const limit = this.options.batchSize ?? 100;
    return db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('outbox_events')
        .select(['id', 'stream', 'envelope'])
        .where('published_at', 'is', null)
        .orderBy('created_at')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => r.id);
      try {
        await publisher.publish(
          rows.map((r) => ({ stream: r.stream, envelope: r.envelope as EventEnvelope })),
        );
      } catch (err) {
        await trx
          .updateTable('outbox_events')
          .set((eb) => ({ attempts: eb('attempts', '+', 1), last_error: String(err) }))
          .where('id', 'in', ids)
          .execute();
        this.options.logger.error({ err, count: ids.length }, 'failed to publish outbox events');
        return 0;
      }
      await trx
        .updateTable('outbox_events')
        .set({ published_at: sql<Date>`now()`, last_error: null })
        .where('id', 'in', ids)
        .execute();
      return rows.length;
    });
  }

  private async pruneIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPrune < 10 * 60_000) return;
    this.lastPrune = now;
    const hours = this.options.retentionHours ?? 24 * 7;
    await this.options.db
      .deleteFrom('outbox_events')
      .where('published_at', '<', sql<Date>`now() - make_interval(hours => ${hours})`)
      .execute();
  }
}
