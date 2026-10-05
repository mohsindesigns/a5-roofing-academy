import type { Redis } from 'ioredis';
import type { EventEnvelope } from '@a5/events';
import type { RedisNamespace } from './redis.js';

export interface PublishItem {
  stream: string;
  envelope: EventEnvelope;
}

/** Appends events to Redis streams with approximate trimming. */
export class StreamPublisher {
  constructor(
    private readonly redis: Redis,
    private readonly ns: RedisNamespace,
    private readonly maxLen = 1_000_000,
  ) {}

  async publish(items: PublishItem[]): Promise<void> {
    if (items.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const { stream, envelope } of items) {
      pipeline.xadd(
        this.ns.stream(stream),
        'MAXLEN',
        '~',
        this.maxLen,
        '*',
        'id',
        envelope.id,
        'type',
        envelope.type,
        'envelope',
        JSON.stringify(envelope),
      );
    }
    const results = await pipeline.exec();
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0];
  }
}
