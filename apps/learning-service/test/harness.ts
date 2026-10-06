import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { z } from 'zod';
import { createDatabase, migrateToLatest, type Database } from '@a5/database';
import { DirectoryProjection } from '@a5/directory';
import { buildEvent, type EventDefinition, type EventEnvelope } from '@a5/events';
import { createRedis, RedisNamespace, StreamPublisher, type Redis } from '@a5/messaging';
import {
  TEST_INTERNAL_SECRET,
  closeApp,
  createTestApp,
  principalHeaders,
  serviceHeaders,
  testLogger,
} from '@a5/nest-kit/testing';
import { uuidv7 } from '@a5/observability';
import {
  DEFAULT_ROLES,
  widestScope,
  type DataScope,
  type PermissionKey,
  type PermissionMap,
  type SystemRoleKey,
} from '@a5/permissions';
import { ORGANIZATION, PEOPLE, TEAMS, TRAINER_ASSIGNMENTS, type PersonKey } from '@a5/seed-data';
import {
  TEST_REDIS_URL,
  createTestDatabase,
  testRedisNamespace,
  type TestDatabase,
} from '@a5/testing';
import { AppModule } from '../src/app.module.js';
import { loadLearningConfig, type LearningConfig } from '../src/config.js';
import { LearningEventsConsumer } from '../src/consumers/learning-events.consumer.js';
import { migrations } from '../src/database/migrations/index.js';
import type { LearningDatabase } from '../src/database/schema.js';
import { OverdueService } from '../src/enrollments/overdue.service.js';
import { seedDirectoryProjection, seedLearning } from '../src/seed/seed-learning.js';

export { TEST_INTERNAL_SECRET, serviceHeaders };

export interface LearningHarness {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  db: Database<LearningDatabase>['db'];
  redis: Redis;
  ns: RedisNamespace;
  config: LearningConfig;
  /** Principal headers for a seeded person, resolved like identity-service would (roles → permissions, teams, trainees). */
  as(person: PersonKey): Promise<Record<string, string>>;
  /** Headers for an arbitrary principal. */
  asCustom(input: {
    userId: string;
    permissions: PermissionKey[] | PermissionMap;
    scope?: DataScope;
    managedTeamIds?: string[];
    managedUserIds?: string[];
  }): Promise<Record<string, string>>;
  /** Build a validated event envelope as its producer would. */
  envelope<T extends string, S extends z.ZodType>(
    def: EventDefinition<T, S>,
    payload: z.input<S>,
    occurredAt?: Date,
  ): EventEnvelope;
  /** Hand an envelope to the matching consumer handler (the same code the stream consumer calls). */
  consume(event: EventEnvelope): Promise<void>;
  /** Publish onto the producer's Redis stream so the running consumer picks it up. */
  publish(event: EventEnvelope): Promise<void>;
  /** Events written to the outbox, oldest first. */
  outbox(type?: string): Promise<EventEnvelope[]>;
  clearOutbox(): Promise<void>;
  overdue: OverdueService;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** `academy`: the full seed. `directory`: only people, teams and units. */
  seed?: 'academy' | 'directory';
  /** `all` starts the outbox relay and stream consumers. */
  role?: 'api' | 'all';
}

export function principalFor(person: PersonKey): {
  userId: string;
  permissions: PermissionMap;
  managedTeamIds: string[];
  managedUserIds: string[];
  roles: string[];
  displayName: string;
} {
  const p = PEOPLE[person];
  const permissions: PermissionMap = {};
  for (const roleKey of p.roles as SystemRoleKey[]) {
    const role = DEFAULT_ROLES.find((r) => r.key === roleKey)!;
    for (const key of role.permissions) {
      const current = permissions[key];
      permissions[key] = current ? widestScope(current, role.dataScope) : role.dataScope;
    }
  }
  return {
    userId: p.id,
    permissions,
    managedTeamIds: TEAMS.filter((t) => (t.managers as readonly string[]).includes(person)).map(
      (t) => t.id,
    ),
    managedUserIds: TRAINER_ASSIGNMENTS.filter((a) => a.trainer === person).flatMap((a) =>
      a.trainees.map((t) => PEOPLE[t].id),
    ),
    roles: [...p.roles],
    displayName: `${p.firstName} ${p.lastName}`,
  };
}

export async function createLearningHarness(
  name: string,
  options: HarnessOptions = {},
): Promise<LearningHarness> {
  const tdb: TestDatabase = await createTestDatabase(`learning_${name}`);
  const namespace = testRedisNamespace(`learning-${name}`);
  const config = loadLearningConfig({
    NODE_ENV: 'test',
    DATABASE_URL: tdb.url,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_NAMESPACE: namespace,
    INTERNAL_AUTH_SECRET: TEST_INTERNAL_SECRET,
    LOG_LEVEL: 'silent',
    SERVICE_ROLE: options.role ?? 'api',
  });
  const database = createDatabase<LearningDatabase>({ url: tdb.url, poolMax: 6 });
  await migrateToLatest(database.db as never, migrations);
  if (options.seed === 'academy') await seedLearning(database.db);
  else await seedDirectoryProjection(database.db);

  const app = await createTestApp(AppModule.register(config, testLogger()), config);
  const redis = createRedis(TEST_REDIS_URL);
  const ns = new RedisNamespace(namespace);

  const h: LearningHarness = {
    app,
    http: request(app.getHttpServer()),
    db: database.db,
    redis,
    ns,
    config,
    overdue: app.get(OverdueService),
    async as(person) {
      const { userId, permissions, managedTeamIds, managedUserIds, roles, displayName } =
        principalFor(person);
      return principalHeaders({
        userId,
        organizationId: ORGANIZATION.id,
        displayName,
        roles,
        permissions,
        managedTeamIds,
        managedUserIds,
      });
    },
    asCustom(input) {
      return principalHeaders({
        organizationId: ORGANIZATION.id,
        scope: input.scope ?? 'organization',
        ...input,
      });
    },
    envelope(def, payload, occurredAt) {
      return buildEvent(def, payload, {
        id: uuidv7(),
        producer: def.producer,
        organizationId: ORGANIZATION.id,
        actor: { type: 'system', id: null },
        occurredAt,
      }) as EventEnvelope;
    },
    async consume(event) {
      const consumer = app.get(LearningEventsConsumer);
      switch (event.type) {
        case 'video.progressed':
          return consumer.onVideoProgressed(event);
        case 'video.completed':
          return consumer.onVideoCompleted(event);
        case 'assessment.attempt.graded':
          return consumer.onAttemptGraded(event);
        case 'ai.score.generated':
          return consumer.onAiScore(event);
        case 'directory.user.upserted':
          await app.get(DirectoryProjection).onUser(event);
          return consumer.onDirectoryUser(event);
        default:
          throw new Error(`No consumer handler for ${event.type}`);
      }
    },
    async publish(event) {
      const stream = `events:${event.producer.replace(/-service$/, '')}`;
      await new StreamPublisher(redis, ns).publish([{ stream, envelope: event }]);
    },
    async outbox(type) {
      let q = database.db
        .selectFrom('outbox_events')
        .select('envelope')
        .orderBy('created_at')
        .orderBy('id');
      if (type) q = q.where('type', '=', type);
      return (await q.execute()).map((r) => r.envelope as EventEnvelope);
    },
    async clearOutbox() {
      await database.db.deleteFrom('outbox_events').execute();
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
  return h;
}
