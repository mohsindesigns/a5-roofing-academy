import { hostname } from 'node:os';
import type { Redis } from 'ioredis';
import { EventContractError, parseEnvelope, type EventEnvelope, type EventType } from '@a5/events';
import { runWithContext, type Logger } from '@a5/observability';
import type { RedisNamespace } from './redis.js';

export interface DeliveryInfo {
  streamId: string;
  stream: string;
  deliveryCount: number;
}

export type EventHandler = (event: EventEnvelope, delivery: DeliveryInfo) => Promise<void>;

export interface StreamConsumerOptions {
  redis: Redis;
  ns: RedisNamespace;
  /** Consumer group, normally the consuming service name. */
  group: string;
  /** Unprefixed stream names to read, e.g. `events:identity`. */
  streams: string[];
  logger: Logger;
  consumerName?: string;
  batchSize?: number;
  blockMs?: number;
  /** Pending entries idle for longer than this are reclaimed and retried. */
  claimIdleMs?: number;
  /** After this many deliveries an entry moves to the dead-letter stream. */
  maxDeliveries?: number;
}

type StreamEntry = [id: string, fields: string[]];

function fieldsToMap(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) out[fields[i]!] = fields[i + 1]!;
  return out;
}

/**
 * Redis Streams consumer-group reader with retry and dead-lettering.
 *
 * - New entries are read with XREADGROUP on a dedicated (blocking) connection.
 * - Failed entries stay pending; a reclaim loop inspects XPENDING, re-claims entries idle longer
 *   than `claimIdleMs` and retries them until `maxDeliveries`, then copies them to
 *   `<ns>:dlq:<group>` and acknowledges.
 * - Handlers must be idempotent (use the inbox) and tolerate reordering.
 */
export class StreamConsumer {
  private readonly handlers = new Map<string, EventHandler[]>();
  private reader: Redis | null = null;
  private running = false;
  private loops: Promise<void>[] = [];
  private readonly consumerName: string;
  private wakeSleepers: Array<() => void> = [];

  constructor(private readonly options: StreamConsumerOptions) {
    this.consumerName = options.consumerName ?? `${hostname()}-${process.pid}`;
  }

  on(type: EventType | (string & {}), handler: EventHandler): this {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
    return this;
  }

  get dlqKey(): string {
    return this.options.ns.key('dlq', this.options.group);
  }

  private streamKeys(): string[] {
    return this.options.streams.map((s) => this.options.ns.stream(s));
  }

  async ensureGroups(): Promise<void> {
    for (const key of this.streamKeys()) {
      try {
        // Start from the beginning so a new consumer builds its projections from history.
        await this.options.redis.xgroup('CREATE', key, this.options.group, '0', 'MKSTREAM');
      } catch (err) {
        if (!String(err).includes('BUSYGROUP')) throw err;
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.ensureGroups();
    this.running = true;
    this.reader = this.options.redis.duplicate();
    this.loops = [this.readLoop(), this.reclaimLoop()];
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    // Disconnecting interrupts a blocking XREADGROUP immediately; sleepers are woken.
    this.reader?.disconnect();
    for (const wake of this.wakeSleepers.splice(0)) wake();
    await Promise.allSettled(this.loops);
    this.reader = null;
  }

  private async readLoop(): Promise<void> {
    const keys = this.streamKeys();
    const block = this.options.blockMs ?? 5_000;
    const count = this.options.batchSize ?? 50;
    while (this.running) {
      try {
        const result = (await this.reader!.xreadgroup(
          'GROUP',
          this.options.group,
          this.consumerName,
          'COUNT',
          count,
          'BLOCK',
          block,
          'STREAMS',
          ...keys,
          ...keys.map(() => '>'),
        )) as Array<[string, StreamEntry[]]> | null;
        if (!result) continue;
        for (const [stream, entries] of result) {
          for (const [id, fields] of entries) {
            await this.process(stream, id, fields, 1);
          }
        }
      } catch (err) {
        if (!this.running) return;
        this.options.logger.error({ err }, 'stream read failed');
        await this.sleep(1_000);
      }
    }
  }

  private async reclaimLoop(): Promise<void> {
    const idle = this.options.claimIdleMs ?? 30_000;
    const interval = Math.max(250, Math.floor(idle / 2));
    while (this.running) {
      await this.sleep(interval);
      if (!this.running) return;
      try {
        await this.reclaimOnce();
      } catch (err) {
        this.options.logger.error({ err }, 'stream reclaim failed');
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakeSleepers = this.wakeSleepers.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeSleepers.push(done);
    });
  }

  /** Retry or dead-letter pending entries. Exposed for tests. */
  async reclaimOnce(): Promise<void> {
    const { redis, group } = this.options;
    const idle = this.options.claimIdleMs ?? 30_000;
    const max = this.options.maxDeliveries ?? 5;
    for (const key of this.streamKeys()) {
      const pending = (await redis.xpending(key, group, 'IDLE', idle, '-', '+', 100)) as Array<
        [id: string, consumer: string, idleMs: number, deliveries: number]
      >;
      for (const [id, , , deliveries] of pending) {
        if (deliveries >= max) {
          const entries = (await redis.xrange(key, id, id)) as StreamEntry[];
          await this.deadLetter(key, id, entries[0]?.[1] ?? [], `exceeded ${max} deliveries`);
          continue;
        }
        const claimed = (await redis.xclaim(key, group, this.consumerName, idle, id)) as StreamEntry[];
        for (const [claimedId, fields] of claimed) {
          if (!fields) {
            // Entry was trimmed from the stream; nothing left to process.
            await redis.xack(key, group, claimedId);
            continue;
          }
          await this.process(key, claimedId, fields, deliveries + 1);
        }
      }
    }
  }

  private async process(stream: string, id: string, fields: string[], deliveryCount: number): Promise<void> {
    const { redis, group, logger } = this.options;
    const map = fieldsToMap(fields);
    let event: EventEnvelope | null;
    try {
      event = parseEnvelope(JSON.parse(map.envelope ?? 'null'));
    } catch (err) {
      // Contract violations will never succeed on retry.
      await this.deadLetter(stream, id, fields, err instanceof EventContractError ? err.message : String(err));
      return;
    }
    const handlers = event ? this.handlers.get(event.type) : undefined;
    if (!event || !handlers?.length) {
      await redis.xack(stream, group, id);
      return;
    }
    const ctx = {
      requestId: event.id,
      correlationId: event.correlationId ?? event.id,
      causationId: event.id,
      organizationId: event.organizationId,
    };
    try {
      await runWithContext(ctx, async () => {
        for (const handler of handlers) await handler(event, { streamId: id, stream, deliveryCount });
      });
      await redis.xack(stream, group, id);
    } catch (err) {
      logger.warn(
        { err, eventId: event.id, type: event.type, deliveryCount },
        'event handler failed; will retry',
      );
    }
  }

  private async deadLetter(stream: string, id: string, fields: string[], reason: string): Promise<void> {
    const { redis, group, logger } = this.options;
    await redis
      .multi()
      .xadd(this.dlqKey, 'MAXLEN', '~', 100_000, '*', ...fields, 'sourceStream', stream, 'sourceId', id, 'error', reason, 'failedAt', new Date().toISOString())
      .xack(stream, group, id)
      .exec();
    logger.error({ stream, streamId: id, reason }, 'event moved to dead-letter stream');
  }

  /** Re-publish dead-lettered entries to their source streams. Returns the number replayed. */
  async replayDeadLetters(limit = 100): Promise<number> {
    const { redis } = this.options;
    const entries = (await redis.xrange(this.dlqKey, '-', '+', 'COUNT', limit)) as StreamEntry[];
    for (const [dlqId, fields] of entries) {
      const map = fieldsToMap(fields);
      if (map.sourceStream && map.envelope) {
        await redis.xadd(map.sourceStream, '*', 'id', map.id ?? '', 'type', map.type ?? '', 'envelope', map.envelope);
      }
      await redis.xdel(this.dlqKey, dlqId);
    }
    return entries.length;
  }
}
