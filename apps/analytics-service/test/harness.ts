import 'reflect-metadata';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { claimInbox, createDatabase, migrateToLatest, type Database } from '@a5/database';
import { applyDirectoryTeam, applyDirectoryUnit, applyDirectoryUser } from '@a5/directory';
import { buildEvent, type EventDefinition, type EventEnvelope } from '@a5/events';
import { createRedis, RedisNamespace, type Redis } from '@a5/messaging';
import { TEST_INTERNAL_SECRET, closeApp, createTestApp, principalHeaders, testLogger } from '@a5/nest-kit/testing';
import { getDefaultRole, type PermissionMap, type SystemRoleKey } from '@a5/permissions';
import {
  ORGANIZATION,
  PEOPLE,
  SEED_NOW,
  TEAMS,
  directoryTeams,
  directoryUnits,
  directoryUsers,
  type PersonKey,
} from '@a5/seed-data';
import { TEST_REDIS_URL, createTestDatabase, testRedisNamespace, type TestDatabase } from '@a5/testing';
import type { z } from 'zod';
import { stableId } from '../src/common/ids.js';
import { AppModule } from '../src/app.module.js';
import { AnalyticsClock } from '../src/common/clock.js';
import { loadAnalyticsConfig, type AnalyticsConfig } from '../src/config.js';
import type { Db, Trx } from '../src/database/index.js';
import { migrations } from '../src/database/migrations/index.js';
import type { AnalyticsDatabase } from '../src/database/schema.js';
import { applyFactEvent } from '../src/facts/apply-event.js';
import { FactWriter } from '../src/facts/fact-writer.js';
import { seedAnalytics } from '../src/seed/seed-analytics.js';

export const ORG_ID = ORGANIZATION.id;

export interface HarnessOptions {
  /** Seed the academy journeys (default false). */
  seed?: boolean;
  /** Load the directory projection without facts (default true; implied by `seed`). */
  directory?: boolean;
  /** `all` also starts the event consumer and BullMQ workers. */
  role?: 'api' | 'all';
  /** Pin "now" (default: the seed reference time). */
  now?: Date | null;
  env?: Record<string, string>;
  /** Leave the database in place (set KEEP_TEST_DB=1 while profiling; its name is on the harness). */
  keepDatabase?: boolean;
}

export interface AnalyticsHarness {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  db: Db;
  redis: Redis;
  ns: RedisNamespace;
  config: AnalyticsConfig;
  clock: AnalyticsClock;
  writer: FactWriter;
  storageRoot: string;
  databaseName: string;
  /** Principal headers for a seeded person acting with a system role's permissions and scope. */
  as(person: PersonKey, role?: SystemRoleKey): Promise<Record<string, string>>;
  /** Principal headers for an arbitrary permission map. */
  custom(userId: string, permissions: PermissionMap, extra?: { managedTeamIds?: string[]; managedUserIds?: string[] }): Promise<Record<string, string>>;
  /** Apply events through the same code path as the consumers (inbox claim included). */
  apply(...events: EventEnvelope[]): Promise<void>;
  close(): Promise<void>;
}

const ROLE_OF: Partial<Record<PersonKey, SystemRoleKey>> = {
  priya: 'super_admin',
  grant: 'admin',
  shelby: 'training_admin',
  hector: 'trainer',
  ruth: 'auditor',
  danielle: 'manager',
  andre: 'manager',
  luis: 'manager',
  meilin: 'manager',
};

/** Permissions of a system role, every one at the role's data scope (how identity grants them). */
export function rolePermissions(role: SystemRoleKey): PermissionMap {
  const def = getDefaultRole(role);
  return Object.fromEntries(def.permissions.map((p) => [p, def.dataScope]));
}

function managedTeams(person: PersonKey): string[] {
  return TEAMS.filter((t) => (t.managers as readonly string[]).includes(person)).map((t) => t.id);
}

function managedUsers(person: PersonKey): string[] {
  // Direct reports / assigned trainees (trainers); team members are covered by the team ids.
  const assigned: Record<string, PersonKey[]> = {
    hector: ['naomi', 'isaiah', 'ethan', 'devon', 'caleb'],
    shelby: ['marcus', 'tyler', 'kayla', 'jordan', 'jasmine', 'colton', 'darius'],
  };
  return (assigned[person] ?? []).map((k) => PEOPLE[k].id);
}

/** Build a validated event envelope with a deterministic id. */
export function evt<T extends string, S extends z.ZodType>(
  def: EventDefinition<T, S>,
  payload: z.input<S>,
  occurredAt: string | Date,
  key: string,
): EventEnvelope {
  return buildEvent(def, payload, {
    id: stableId('test-event', def.type, key),
    producer: def.producer,
    organizationId: ORG_ID,
    actor: { type: 'system', id: null },
    occurredAt: new Date(occurredAt),
  });
}

export async function loadDirectory(db: Db): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const dir = trx as unknown as Parameters<typeof applyDirectoryUser>[0];
    for (const unit of directoryUnits()) await applyDirectoryUnit(dir, unit, 1);
    for (const team of directoryTeams()) await applyDirectoryTeam(dir, team, 1);
    for (const user of directoryUsers()) await applyDirectoryUser(dir, user, 1);
  });
}

export async function createAnalyticsHarness(name: string, options: HarnessOptions = {}): Promise<AnalyticsHarness> {
  const tdb: TestDatabase = await createTestDatabase(`analytics_${name}`);
  const namespace = testRedisNamespace(`analytics-${name}`);
  const storageRoot = await mkdtemp(join(tmpdir(), 'a5-analytics-test-'));
  const config = loadAnalyticsConfig({
    NODE_ENV: 'test',
    DATABASE_URL: tdb.url,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_NAMESPACE: namespace,
    INTERNAL_AUTH_SECRET: TEST_INTERNAL_SECRET,
    LOG_LEVEL: 'silent',
    SERVICE_ROLE: options.role ?? 'api',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_ROOT: storageRoot,
    STORAGE_SIGNING_SECRET: 'test-storage-signing-secret-0123456789abcdef',
    REPORT_FILES_PUBLIC_URL: 'http://localhost:4000/api/v1/reports/files',
    ...options.env,
  });
  const database: Database<AnalyticsDatabase> = createDatabase<AnalyticsDatabase>({ url: tdb.url, poolMax: 6 });
  await migrateToLatest(database.db as never, migrations);
  if (options.seed) await seedAnalytics(database.db, { timezone: config.analytics.timezone });
  else if (options.directory !== false) await loadDirectory(database.db);

  const app = await createTestApp(AppModule.register(config, testLogger()), config);
  const clock = app.get(AnalyticsClock);
  if (options.now !== null) clock.pin(options.now ?? SEED_NOW);
  const redis = createRedis(TEST_REDIS_URL);
  const writer = new FactWriter({ timezone: config.analytics.timezone });

  return {
    app,
    http: request(app.getHttpServer()),
    db: database.db,
    redis,
    ns: new RedisNamespace(namespace),
    config,
    clock,
    writer,
    storageRoot,
    databaseName: tdb.name,
    as(person, role) {
      const key = role ?? ROLE_OF[person] ?? 'sales_rep';
      return principalHeaders({
        userId: PEOPLE[person].id,
        organizationId: ORG_ID,
        displayName: `${PEOPLE[person].firstName} ${PEOPLE[person].lastName}`,
        roles: [key],
        permissions: rolePermissions(key),
        managedTeamIds: managedTeams(person),
        managedUserIds: managedUsers(person),
      });
    },
    custom(userId, permissions, extra = {}) {
      return principalHeaders({ userId, organizationId: ORG_ID, permissions, ...extra });
    },
    async apply(...events) {
      await database.db.transaction().execute(async (trx) => {
        for (const event of events) {
          const claimed = await claimInbox(trx as never, event.id, `analytics.${event.type}`, event.type);
          if (claimed) await applyFactEvent(writer, trx as Trx, event);
        }
      });
    },
    async close() {
      await closeApp(app);
      const keys = await redis.keys(`${namespace}*`);
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
      await database.destroy();
      if (!(options.keepDatabase ?? process.env.KEEP_TEST_DB === '1')) await tdb.drop();
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}
