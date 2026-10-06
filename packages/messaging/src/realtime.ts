import type { Redis } from 'ioredis';
import type { RedisNamespace } from './redis.js';

export interface RealtimeMessage {
  type: string;
  data: unknown;
}

/**
 * Cross-instance fan-out of real-time messages. Whichever instance holds a user's SSE connection
 * receives the message through Redis pub/sub.
 */
export class RealtimeBus {
  private subscriber: Redis | null = null;
  private readonly listeners = new Map<string, Set<(msg: RealtimeMessage) => void>>();

  constructor(
    private readonly redis: Redis,
    private readonly ns: RedisNamespace,
  ) {}

  private channel(userId: string): string {
    return this.ns.key('rt', 'user', userId);
  }

  async publishToUser(userId: string, message: RealtimeMessage): Promise<void> {
    await this.redis.publish(this.channel(userId), JSON.stringify(message));
  }

  async subscribeUser(
    userId: string,
    listener: (msg: RealtimeMessage) => void,
  ): Promise<() => Promise<void>> {
    if (!this.subscriber) {
      this.subscriber = this.redis.duplicate();
      this.subscriber.on('message', (channel: string, raw: string) => {
        const set = this.listeners.get(channel);
        if (!set) return;
        const msg = JSON.parse(raw) as RealtimeMessage;
        for (const l of set) l(msg);
      });
    }
    const channel = this.channel(userId);
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.subscriber.subscribe(channel);
    }
    set.add(listener);
    return async () => {
      const current = this.listeners.get(channel);
      current?.delete(listener);
      if (current && current.size === 0) {
        this.listeners.delete(channel);
        await this.subscriber?.unsubscribe(channel);
      }
    };
  }

  async close(): Promise<void> {
    this.subscriber?.disconnect();
    this.subscriber = null;
    this.listeners.clear();
  }
}
