import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createDatabase, migrateToLatest, sql, type Database } from '@a5/database';
import {
  auditEvents,
  buildEvent,
  streamFor,
  type AuditRecord,
  type EventEnvelope,
  type Producer,
} from '@a5/events';
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
import { ORGANIZATION, PEOPLE, TEAMS, type PersonKey } from '@a5/seed-data';
import {
  TEST_REDIS_URL,
  createTestDatabase,
  testRedisNamespace,
  waitFor,
  type TestDatabase,
} from '@a5/testing';
import { AppModule } from '../src/app.module.js';
import { loadAuditConfig, type AuditConfig } from '../src/config.js';
import { migrations } from '../src/database/migrations/index.js';
import type { AuditDatabase } from '../src/database/schema.js';
import { seedAudit } from '../src/seed/seed-audit.js';

export const OTHER_ORG = '0190a3b2-0000-7000-8000-00000000f0f0';

export interface HarnessOptions {
  role?: 'api' | 'worker' | 'all';
  env?: Record<string, string>;
  /** Seed the A5 administrative history (default false). */
  seed?: boolean;
}

export interface TestEntry {
  id?: string;
  organizationId?: string | null;
  occurredAt?: Date;
  actorType?: 'user' | 'service' | 'system';
  actorId?: string | null;
  actorDisplay?: string | null;
  action?: string;
  resourceType?: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  correlationId?: string | null;
  service?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditHarness {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  db: Database<AuditDatabase>['db'];
  redis: Redis;
  ns: RedisNamespace;
  namespace: string;
  databaseUrl: string;
  config: AuditConfig;
  /** An `audit.recorded` envelope as the given service would publish it. */
  event(producer: Producer, record: AuditRecord, meta?: Partial<EventMeta>): EventEnvelope;
  /** Append to the producer's Redis stream, as the outbox relay would. */
  publish(event: EventEnvelope): Promise<void>;
  /** Insert entries directly (bypassing the event pipeline) and return their ids. */
  insert(entries: TestEntry[]): Promise<string[]>;
  as(person: PersonKey): Promise<Record<string, string>>;
  listen(): Promise<string>;
  close(): Promise<void>;
}

export interface EventMeta {
  id: string;
  organizationId: string | null;
  actor: EventEnvelope['actor'];
  occurredAt: Date;
  correlationId: string | null;
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
  extra: { permissions?: PermissionKey[] } = {},
): Promise<Record<string, string>> {
  const p = PEOPLE[person];
  return principalHeaders({
    userId: p.id,
    organizationId: ORGANIZATION.id,
    displayName: `${p.firstName} ${p.lastName}`,
    roles: [...p.roles],
    permissions: extra.permissions ?? permissionsOf(person),
    managedTeamIds: TEAMS.filter((t) => (t.managers as readonly string[]).includes(person)).map(
      (t) => t.id,
    ),
  });
}

export async function createAuditHarness(
  name: string,
  options: HarnessOptions = {},
): Promise<AuditHarness> {
  const tdb: TestDatabase = await createTestDatabase(`audit_${name}`);
  const namespace = testRedisNamespace(`audit-${name}`);
  const config = loadAuditConfig({
    NODE_ENV: 'test',
    DATABASE_URL: tdb.url,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_NAMESPACE: namespace,
    INTERNAL_AUTH_SECRET: TEST_INTERNAL_SECRET,
    LOG_LEVEL: 'silent',
    SERVICE_ROLE: options.role ?? 'all',
    ...options.env,
  });
  const database = createDatabase<AuditDatabase>({ url: tdb.url, poolMax: 6 });
  await migrateToLatest(database.db as never, migrations);
  if (options.seed) await seedAudit(database.db);

  const app = await createTestApp(AppModule.register(config, testLogger()), config);
  const redis = createRedis(TEST_REDIS_URL);
  const ns = new RedisNamespace(namespace);
  const publisher = new StreamPublisher(redis, ns);
  let address: string | null = null;

  return {
    app,
    http: request(app.getHttpServer()),
    db: database.db,
    redis,
    ns,
    namespace,
    databaseUrl: tdb.url,
    config,
    event(producer, record, meta = {}) {
      return buildEvent(auditEvents.recorded, record, {
        id: meta.id ?? uuidv7(),
        producer,
        organizationId: meta.organizationId === undefined ? ORGANIZATION.id : meta.organizationId,
        actor: meta.actor ?? { type: 'user', id: PEOPLE.grant.id },
        occurredAt: meta.occurredAt,
        correlationId: meta.correlationId ?? null,
      }) as EventEnvelope;
    },
    async publish(event) {
      await publisher.publish([{ stream: streamFor(event.producer), envelope: event }]);
    },
    async insert(entries) {
      const ids: string[] = [];
      for (let i = 0; i < entries.length; i += 500) {
        const rows = entries.slice(i, i + 500).map((e) => {
          const occurredAt = e.occurredAt ?? new Date();
          const id = e.id ?? uuidv7(occurredAt.getTime());
          ids.push(id);
          return {
            id,
            organization_id: e.organizationId === undefined ? ORGANIZATION.id : e.organizationId,
            occurred_at: occurredAt,
            actor_type: e.actorType ?? ('user' as const),
            actor_id: e.actorId === undefined ? PEOPLE.grant.id : e.actorId,
            actor_display: e.actorDisplay === undefined ? 'Grant Holloway' : e.actorDisplay,
            action: e.action ?? 'user.updated',
            resource_type: e.resourceType ?? 'user',
            resource_id: e.resourceId === undefined ? PEOPLE.marcus.id : e.resourceId,
            before: e.before === undefined ? null : JSON.stringify(e.before),
            after: e.after === undefined ? null : JSON.stringify(e.after),
            reason: e.reason ?? null,
            ip: e.ip ?? null,
            user_agent: e.userAgent ?? null,
            request_id: e.requestId ?? null,
            correlation_id: e.correlationId ?? null,
            service: e.service ?? 'identity-service',
            metadata: JSON.stringify(e.metadata ?? {}),
          };
        });
        await database.db.insertInto('audit_logs').values(rows).execute();
      }
      return ids;
    },
    as: headersFor,
    async listen() {
      if (!address) {
        await app.listen(0, '127.0.0.1');
        address = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      }
      return address;
    },
    async close() {
      await closeApp(app);
      const keys = await redis.keys(`${namespace}*`);
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
      await database.destroy();
      await tdb.drop();
    },
  };
}

/** Wait until a row with this id was stored. */
export async function stored(h: AuditHarness, id: string) {
  return waitFor(
    async () => h.db.selectFrom('audit_logs').selectAll().where('id', '=', id).executeTakeFirst(),
    {
      timeoutMs: 10_000,
      message: `audit entry ${id}`,
    },
  );
}

export async function count(h: AuditHarness, where = sql<boolean>`true`): Promise<number> {
  const rows = await sql<{
    n: number;
  }>`select count(*)::int as n from audit_logs where ${where}`.execute(h.db);
  return rows.rows[0]!.n;
}
