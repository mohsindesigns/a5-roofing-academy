import 'reflect-metadata';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { signLessonGrant, type LessonGrant } from '@a5/auth';
import { createDatabase, migrateToLatest, type Database } from '@a5/database';
import { QueueFactory, createRedis, type Redis } from '@a5/messaging';
import {
  TEST_INTERNAL_SECRET,
  closeApp,
  createTestApp,
  principalHeaders,
  serviceHeaders,
  testLogger,
} from '@a5/nest-kit/testing';
import {
  DEFAULT_ROLES,
  type DataScope,
  type PermissionKey,
  type PermissionMap,
} from '@a5/permissions';
import { ORGANIZATION, PEOPLE, type PersonKey } from '@a5/seed-data';
import type { LocalDiskStorage } from '@a5/storage';
import {
  TEST_REDIS_URL,
  createTestDatabase,
  testRedisNamespace,
  type TestDatabase,
} from '@a5/testing';
import { AppModule, configureMediaApp } from '../src/app.module.js';
import type { MediaAppOverrides } from '../src/common/media-infra.module.js';
import { OBJECT_STORAGE, type Clock } from '../src/common/tokens.js';
import { loadMediaConfig, type MediaConfig } from '../src/config.js';
import { migrations } from '../src/database/migrations/index.js';
import type { MediaDatabase } from '../src/database/schema.js';

export const ORG = ORGANIZATION.id;
export const LESSON_ID = '0190a3b2-0000-7000-8000-0000000000f1';
export const OTHER_ORG = '0190a3b2-0000-7000-8000-00000000beef';
export const STORAGE_SECRET = 'test-storage-signing-secret-0123456789abcdef';
export const PUBLIC_ORIGIN = 'http://media.test';

/** Real time plus a controllable offset (telemetry wall-clock checks, token expiry). */
export class TestClock implements Clock {
  private offsetMs = 0;
  now(): number {
    return Date.now() + this.offsetMs;
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

export interface MediaHarness {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  db: Database<MediaDatabase>['db'];
  redis: Redis;
  config: MediaConfig;
  storage: LocalDiskStorage;
  storageRoot: string;
  clock: TestClock;
  namespace: string;
  /** Principal headers for a seeded person with the permissions of their default roles. */
  as(person: PersonKey): Promise<Record<string, string>>;
  /** Principal headers for someone in a different organization. */
  outsider(permissions?: PermissionKey[]): Promise<Record<string, string>>;
  service(): Promise<Record<string, string>>;
  grant(
    input: Partial<LessonGrant> & { userId: string; resource: LessonGrant['resource'] },
    ttlSeconds?: number,
  ): Promise<string>;
  /** Path + query of an absolute URL produced by the service (for supertest). */
  path(url: string): string;
  queues: QueueFactory;
  close(): Promise<void>;
}

export function permissionsOf(person: PersonKey): PermissionMap {
  const map: PermissionMap = {};
  const rank: Record<DataScope, number> = { own: 0, managed: 1, organization: 2, platform: 3 };
  for (const roleKey of PEOPLE[person].roles) {
    const role = DEFAULT_ROLES.find((r) => r.key === roleKey)!;
    for (const p of role.permissions) {
      const current = map[p];
      if (!current || rank[role.dataScope] > rank[current]) map[p] = role.dataScope;
    }
  }
  return map;
}

export interface HarnessOptions {
  role?: 'api' | 'worker' | 'all';
  env?: Record<string, string>;
  overrides?: Omit<MediaAppOverrides, 'clock'>;
}

export async function createMediaHarness(
  name: string,
  options: HarnessOptions = {},
): Promise<MediaHarness> {
  const tdb: TestDatabase = await createTestDatabase(`media_${name}`);
  const storageRoot = await mkdtemp(join(tmpdir(), 'a5-media-test-'));
  await mkdir(join(storageRoot, 'work'));
  const namespace = testRedisNamespace(`media-${name}`);
  const config = loadMediaConfig({
    NODE_ENV: 'test',
    DATABASE_URL: tdb.url,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_NAMESPACE: namespace,
    INTERNAL_AUTH_SECRET: TEST_INTERNAL_SECRET,
    LOG_LEVEL: 'silent',
    SERVICE_ROLE: options.role ?? 'api',
    PUBLIC_APP_URL: PUBLIC_ORIGIN,
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_ROOT: join(storageRoot, 'objects'),
    STORAGE_SIGNING_SECRET: STORAGE_SECRET,
    MEDIA_WORK_DIR: join(storageRoot, 'work'),
    ...options.env,
  });
  const database = createDatabase<MediaDatabase>({ url: tdb.url, poolMax: 4 });
  await migrateToLatest(database.db as never, migrations);

  const clock = new TestClock();
  const app = await createTestApp(
    AppModule.register(config, testLogger(), { ...options.overrides, clock }),
    config,
    configureMediaApp,
  );
  const redis = createRedis(TEST_REDIS_URL);

  return {
    app,
    http: request(app.getHttpServer()),
    db: database.db,
    redis,
    config,
    storage: app.get(OBJECT_STORAGE) as LocalDiskStorage,
    storageRoot,
    clock,
    namespace,
    queues: app.get(QueueFactory),
    as: (person) =>
      principalHeaders({
        userId: PEOPLE[person].id,
        organizationId: ORG,
        displayName: `${PEOPLE[person].firstName} ${PEOPLE[person].lastName}`,
        roles: [...PEOPLE[person].roles],
        permissions: permissionsOf(person),
      }),
    outsider: (permissions = ['media.view', 'media.upload', 'media.delete']) =>
      principalHeaders({
        userId: '0190a3b2-0000-7000-8000-00000000cafe',
        organizationId: OTHER_ORG,
        permissions,
        scope: 'organization',
      }),
    service: () => serviceHeaders('learning-service'),
    grant: (input, ttlSeconds) =>
      signLessonGrant(
        {
          organizationId: ORG,
          programId: '0190a3b2-0000-7000-8000-0000000000a1',
          enrollmentId: '0190a3b2-0000-7000-8000-0000000000e1',
          lessonId: LESSON_ID,
          policy: {},
          ...input,
        },
        config.media.lessonGrantSecret,
        ttlSeconds,
      ),
    path: (url) => {
      const u = new URL(url);
      return `${u.pathname}${u.search}`;
    },
    async close() {
      await closeApp(app);
      const keys = await redis.keys(`${namespace}*`);
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
      await database.destroy();
      await tdb.drop();
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}
