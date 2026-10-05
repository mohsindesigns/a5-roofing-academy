import { BeforeApplicationShutdown, Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Principal } from '@a5/auth';
import type { notification } from '@a5/contracts';
import { RealtimeBus, type RealtimeMessage } from '@a5/messaging';
import { AppError, LOGGER } from '@a5/nest-kit';
import { uuidv7, type Logger } from '@a5/observability';
import { NOTIFICATION_CONFIG, type NotificationConfig } from '../config.js';
import { NotificationsRepository } from '../inbox/notifications.repository.js';
import type { RealtimeNotificationMessage } from './realtime.publisher.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A client that stops reading is dropped rather than buffered without bound; it reconnects with Last-Event-ID. */
const MAX_BUFFERED_BYTES = 512 * 1024;
const REPLAY_LIMIT = 100;

interface Connection {
  id: string;
  userId: string;
  res: Response;
  heartbeat: NodeJS.Timeout | null;
  unsubscribe: (() => Promise<void>) | null;
  closed: boolean;
}

/**
 * Server-sent event streams of a user's notifications. Each instance subscribes to the user's
 * Redis channel while a stream is open, so pushes reach the browser whichever instance created
 * the notification.
 */
@Injectable()
export class NotificationStreamService implements BeforeApplicationShutdown {
  private readonly connections = new Set<Connection>();

  constructor(
    private readonly bus: RealtimeBus,
    private readonly repo: NotificationsRepository,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Number of open streams on this instance (optionally for one user). */
  count(userId?: string): number {
    if (!userId) return this.connections.size;
    let n = 0;
    for (const c of this.connections) if (c.userId === userId) n++;
    return n;
  }

  async open(principal: Principal, req: Request, res: Response): Promise<void> {
    const userId = principal.userId;
    if (this.count(userId) >= this.config.sse.maxConnectionsPerUser) {
      throw new AppError(429, 'TOO_MANY_STREAMS', 'Too many open notification streams. Close other Academy tabs and try again.');
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.flushHeaders();

    const conn: Connection = { id: uuidv7(), userId, res, heartbeat: null, unsubscribe: null, closed: false };
    this.connections.add(conn);
    res.on('close', () => this.close(conn));

    // Messages that arrive while the initial state is written are queued, so the last `unread`
    // event the client sees is never older than what it already received.
    let ready = false;
    const pending: RealtimeMessage[] = [];
    const deliver = (message: RealtimeMessage) => {
      if (conn.closed) return;
      if (ready) this.forward(conn, message);
      else pending.push(message);
    };

    try {
      const unsubscribe = await this.bus.subscribeUser(userId, deliver);
      conn.unsubscribe = unsubscribe;
      if (conn.closed) {
        await unsubscribe();
        return;
      }
      this.write(conn, `retry: 5000\n\n`);
      const lastEventId = req.header('last-event-id');
      if (lastEventId && UUID.test(lastEventId)) {
        for (const n of await this.repo.listAfter(userId, lastEventId, REPLAY_LIMIT)) this.writeNotification(conn, n);
      }
      this.writeUnread(conn, await this.repo.unreadCount(userId));
      ready = true;
      for (const message of pending.splice(0)) this.forward(conn, message);
      conn.heartbeat = setInterval(() => this.write(conn, `: heartbeat ${new Date().toISOString()}\n\n`), this.config.sse.heartbeatMs);
      conn.heartbeat.unref();
    } catch (err) {
      this.logger.warn({ err, userId }, 'notification stream setup failed');
      this.close(conn);
    }
  }

  private forward(conn: Connection, message: RealtimeMessage): void {
    const m = message as RealtimeNotificationMessage;
    if (m.type === 'notification.created' && m.data?.notification) {
      this.writeNotification(conn, m.data.notification);
      this.writeUnread(conn, m.data.unreadCount);
    } else if (m.type === 'notification.unread' && typeof m.data?.unreadCount === 'number') {
      this.writeUnread(conn, m.data.unreadCount);
    }
  }

  private writeNotification(conn: Connection, n: notification.Notification): void {
    this.write(conn, `id: ${n.id}\nevent: notification\ndata: ${JSON.stringify(n)}\n\n`);
  }

  private writeUnread(conn: Connection, count: number): void {
    this.write(conn, `event: unread\ndata: ${JSON.stringify({ count })}\n\n`);
  }

  private write(conn: Connection, chunk: string): void {
    if (conn.closed || conn.res.writableEnded) return;
    if (conn.res.writableLength > MAX_BUFFERED_BYTES) {
      this.logger.warn({ userId: conn.userId }, 'notification stream client is not reading; closing the stream');
      this.close(conn);
      return;
    }
    conn.res.write(chunk);
  }

  private close(conn: Connection): void {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.heartbeat) clearInterval(conn.heartbeat);
    this.connections.delete(conn);
    conn.unsubscribe?.().catch((err: unknown) => this.logger.warn({ err }, 'failed to unsubscribe notification stream'));
    if (!conn.res.writableEnded) conn.res.end();
  }

  /** End open streams so the HTTP server can close; browsers reconnect to another instance. */
  beforeApplicationShutdown(): void {
    for (const conn of [...this.connections]) this.close(conn);
  }
}
