import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { z } from 'zod';
import { createDatabase, migrateToLatest, type Database } from '@a5/database';
import { buildEvent, streamFor, type EventDefinition, type EventEnvelope } from '@a5/events';
import { RedisNamespace, StreamPublisher, createRedis, type Redis } from '@a5/messaging';
import {
  TEST_INTERNAL_SECRET,
  closeApp,
  createTestApp,
  principalHeaders,
  testLogger,
} from '@a5/nest-kit/testing';
import { uuidv7 } from '@a5/observability';
import {
  getDefaultRole,
  scopeRank,
  type DataScope,
  type PermissionKey,
  type PermissionMap,
} from '@a5/permissions';
import { ORGANIZATION, PEOPLE, TEAMS, TRAINER_ASSIGNMENTS, type PersonKey } from '@a5/seed-data';
import {
  TEST_REDIS_URL,
  createTestDatabase,
  testRedisNamespace,
  waitFor,
  type TestDatabase,
} from '@a5/testing';
import { AppModule } from '../src/app.module.js';
import { loadNotificationConfig, type NotificationConfig } from '../src/config.js';
import { migrations } from '../src/database/migrations/index.js';
import type { NotificationDatabase } from '../src/database/schema.js';
import { MemoryTransport } from '../src/email/transports.js';
import { seedNotification } from '../src/seed/seed-notification.js';

export const APP_URL = 'https://academy.a5roofing.example';

export interface HarnessOptions {
  role?: 'api' | 'worker' | 'all';
  env?: Record<string, string>;
  /** Share an existing database / Redis namespace (multi-instance tests). */
  database?: { url: string };
  namespace?: string;
  seed?: boolean;
}

export interface NotificationHarness {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  db: Database<NotificationDatabase>['db'];
  redis: Redis;
  ns: RedisNamespace;
  namespace: string;
  databaseUrl: string;
  config: NotificationConfig;
  transport: MemoryTransport;
  /** Build an event envelope (not published). */
  event<T extends string, S extends z.ZodType>(
    def: EventDefinition<T, S>,
    payload: z.input<S>,
    meta?: Partial<EventMetaInput>,
  ): EventEnvelope;
  /** Append an event to its producer's Redis stream, as the outbox relay would. */
  publish(event: EventEnvelope): Promise<void>;
  /** Principal headers for a seeded person with their default role permissions and scope. */
  as(
    person: PersonKey,
    overrides?: { permissions?: PermissionKey[] },
  ): Promise<Record<string, string>>;
  /** Start listening on an ephemeral port (for real HTTP streaming). */
  listen(): Promise<string>;
  close(): Promise<void>;
}

export interface EventMetaInput {
  id: string;
  organizationId: string | null;
  actor: EventEnvelope['actor'];
  occurredAt: Date;
}

export function permissionsOf(person: PersonKey): PermissionMap {
  const map: PermissionMap = {};
  for (const roleKey of PEOPLE[person].roles) {
    const role = getDefaultRole(roleKey);
    for (const key of role.permissions) {
      const current = map[key];
      map[key] =
        current && scopeRank(current) >= scopeRank(role.dataScope)
          ? current
          : (role.dataScope as DataScope);
    }
  }
  return map;
}

export async function headersFor(
  person: PersonKey,
  overrides: { permissions?: PermissionKey[] } = {},
): Promise<Record<string, string>> {
  const p = PEOPLE[person];
  return principalHeaders({
    userId: p.id,
    organizationId: ORGANIZATION.id,
    displayName: `${p.firstName} ${p.lastName}`,
    roles: [...p.roles],
    permissions: overrides.permissions ?? permissionsOf(person),
    scope: 'organization',
    managedTeamIds: TEAMS.filter((t) => (t.managers as readonly string[]).includes(person)).map(
      (t) => t.id,
    ),
    managedUserIds: TRAINER_ASSIGNMENTS.filter((a) => a.trainer === person).flatMap((a) =>
      a.trainees.map((k) => PEOPLE[k].id),
    ),
  });
}

export async function createNotificationHarness(
  name: string,
  options: HarnessOptions = {},
): Promise<NotificationHarness> {
  const tdb: TestDatabase | null = options.database
    ? null
    : await createTestDatabase(`notification_${name}`);
  const databaseUrl = options.database?.url ?? tdb!.url;
  const namespace = options.namespace ?? testRedisNamespace(`notification-${name}`);
  const config = loadNotificationConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_NAMESPACE: namespace,
    INTERNAL_AUTH_SECRET: TEST_INTERNAL_SECRET,
    LOG_LEVEL: 'silent',
    SERVICE_ROLE: options.role ?? 'all',
    PUBLIC_APP_URL: APP_URL,
    EMAIL_MAX_ATTEMPTS: '3',
    EMAIL_BACKOFF_MS: '20',
    SSE_HEARTBEAT_MS: '25000',
    ...options.env,
  });
  const database = createDatabase<NotificationDatabase>({ url: databaseUrl, poolMax: 4 });
  if (!options.database) {
    await migrateToLatest(database.db as never, migrations);
    if (options.seed !== false)
      await seedNotification(database.db, { demo: false, appUrl: APP_URL });
  }

  const transport = new MemoryTransport();
  const app = await createTestApp(
    AppModule.register(config, testLogger(), { emailTransport: transport }),
    config,
  );
  const redis = createRedis(TEST_REDIS_URL);
  const ns = new RedisNamespace(namespace);
  const publisher = new StreamPublisher(redis, ns);
  let server: ReturnType<NestExpressApplication['getHttpServer']> | null = null;

  return {
    app,
    http: request(app.getHttpServer()),
    db: database.db,
    redis,
    ns,
    namespace,
    databaseUrl,
    config,
    transport,
    event(def, payload, meta = {}) {
      return buildEvent(def, payload, {
        id: meta.id ?? uuidv7(),
        producer: def.producer,
        organizationId: meta.organizationId === undefined ? ORGANIZATION.id : meta.organizationId,
        actor: meta.actor ?? { type: 'system', id: null },
        occurredAt: meta.occurredAt,
      }) as EventEnvelope;
    },
    async publish(event) {
      await publisher.publish([{ stream: streamFor(event.producer), envelope: event }]);
    },
    as: headersFor,
    async listen() {
      if (!server) {
        await app.listen(0, '127.0.0.1');
        server = app.getHttpServer();
      }
      const { port } = server!.address() as AddressInfo;
      return `http://127.0.0.1:${port}`;
    },
    async close() {
      await closeApp(app);
      if (!options.namespace) {
        const keys = await redis.keys(`${namespace}*`);
        if (keys.length) await redis.del(...keys);
      }
      redis.disconnect();
      await database.destroy();
      await tdb?.drop();
    },
  };
}

/** Wait until the event was processed by the dispatch handler. */
export async function processed(
  h: NotificationHarness,
  eventId: string,
  handler = 'notification.dispatch',
): Promise<void> {
  await waitFor(
    async () =>
      h.db
        .selectFrom('inbox_events')
        .select('event_id')
        .where('event_id', '=', eventId)
        .where('handler', '=', handler)
        .executeTakeFirst(),
    { timeoutMs: 10_000, message: `event ${eventId} processed by ${handler}` },
  );
}

export async function notificationsOf(h: NotificationHarness, person: PersonKey) {
  return h.db
    .selectFrom('notifications')
    .selectAll()
    .where('user_id', '=', PEOPLE[person].id)
    .orderBy('available_at', 'desc')
    .execute();
}

export async function deliveriesTo(h: NotificationHarness, person: PersonKey) {
  return h.db
    .selectFrom('email_deliveries')
    .selectAll()
    .where('user_id', '=', PEOPLE[person].id)
    .orderBy('created_at', 'desc')
    .execute();
}

/** Minimal SSE reader over fetch: yields parsed events and comments. */
export interface SseMessage {
  event: string | null;
  id: string | null;
  data: string | null;
  comment: string | null;
}

export async function openStream(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { accept: 'text/event-stream', ...headers },
    signal: controller.signal,
  });
  const messages: SseMessage[] = [];
  let buffer = '';
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const msg: SseMessage = { event: null, id: null, data: null, comment: null };
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) msg.comment = line.slice(1).trim();
            else if (line.startsWith('event: ')) msg.event = line.slice(7);
            else if (line.startsWith('id: ')) msg.id = line.slice(4);
            else if (line.startsWith('data: '))
              msg.data = (msg.data ? `${msg.data}\n` : '') + line.slice(6);
          }
          messages.push(msg);
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    status: res.status,
    headers: res.headers,
    messages,
    async next(predicate: (m: SseMessage) => boolean, timeoutMs = 10_000): Promise<SseMessage> {
      return waitFor(() => messages.find(predicate), { timeoutMs, message: 'SSE message' });
    },
    async close() {
      controller.abort();
      await pump;
    },
  };
}
