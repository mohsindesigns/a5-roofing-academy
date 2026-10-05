import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { signLessonGrant } from '@a5/auth';
import { createDatabase, migrateToLatest, type Database } from '@a5/database';
import { createRedis, RedisNamespace, type Redis } from '@a5/messaging';
import {
  TEST_INTERNAL_SECRET,
  closeApp,
  createTestApp,
  principalHeaders,
  testLogger,
} from '@a5/nest-kit/testing';
import {
  DEFAULT_ROLES,
  widestScope,
  type DataScope,
  type PermissionKey,
  type PermissionMap,
} from '@a5/permissions';
import {
  ORGANIZATION,
  PEOPLE,
  SCENARIOS,
  TEAMS,
  TRAINER_ASSIGNMENTS,
  type PersonKey,
} from '@a5/seed-data';
import {
  TEST_REDIS_URL,
  createTestDatabase,
  testRedisNamespace,
  type TestDatabase,
} from '@a5/testing';
import { AppModule } from '../src/app.module.js';
import { loadAiConfig, type AiConfig } from '../src/config.js';
import { migrations } from '../src/database/migrations/index.js';
import type { AiDatabase } from '../src/database/schema.js';
import { seedAi } from '../src/seed/seed-ai.js';

export interface AiHarness {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  db: Database<AiDatabase>['db'];
  redis: Redis;
  config: AiConfig;
  /** Principal headers for a seeded person, computed from the default role definitions. */
  as(person: PersonKey): Promise<Record<string, string>>;
  /** Principal headers with explicit permissions (for edge cases). */
  asCustom(
    userId: string,
    permissions: PermissionKey[],
    scope: DataScope,
  ): Promise<Record<string, string>>;
  scenarioId(key: string): string;
  grant(
    person: PersonKey,
    scenarioKey: string,
    overrides?: {
      userId?: string;
      resourceId?: string;
      resourceType?: 'ai_scenario' | 'media';
      secret?: string;
      ttlSeconds?: number;
    },
  ): Promise<string>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Run BullMQ workers (evaluation) and background jobs. Defaults to API role only. */
  workers?: boolean;
  env?: Record<string, string>;
  /** Seed the full dataset (default) or only the people directory. */
  seed?: boolean;
}

/** Mirrors identity-service's principal resolution for the default roles. */
function principalFor(person: PersonKey) {
  const p = PEOPLE[person];
  const permissions: PermissionMap = {};
  for (const roleKey of p.roles) {
    const role = DEFAULT_ROLES.find((r) => r.key === roleKey)!;
    for (const key of role.permissions) {
      const existing = permissions[key];
      permissions[key] = existing ? widestScope(existing, role.dataScope) : role.dataScope;
    }
  }
  const managedUserIds = TRAINER_ASSIGNMENTS.filter((a) => a.trainer === person).flatMap((a) =>
    a.trainees.map((t) => PEOPLE[t].id),
  );
  return {
    userId: p.id,
    organizationId: ORGANIZATION.id,
    displayName: `${p.firstName} ${p.lastName}`,
    roles: [...p.roles],
    permissions,
    managedTeamIds: TEAMS.filter((t) => (t.managers as readonly string[]).includes(person)).map(
      (t) => t.id,
    ),
    managedUserIds,
  };
}

export async function createAiHarness(
  name: string,
  options: HarnessOptions = {},
): Promise<AiHarness> {
  const tdb: TestDatabase = await createTestDatabase(`ai_${name}`);
  const namespace = testRedisNamespace(`ai-${name}`);
  const config = loadAiConfig({
    NODE_ENV: 'test',
    DATABASE_URL: tdb.url,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_NAMESPACE: namespace,
    INTERNAL_AUTH_SECRET: TEST_INTERNAL_SECRET,
    LOG_LEVEL: 'silent',
    SERVICE_ROLE: options.workers ? 'all' : 'api',
    AI_PROVIDER_RETRY_BASE_MS: '5',
    AI_EVALUATION_BACKOFF_MS: '20',
    AI_SWEEP_INTERVAL_MS: '3600000',
    // The development simulator must be what the tests exercise, whatever the machine has configured.
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    ...options.env,
  });
  const database = createDatabase<AiDatabase>({ url: tdb.url, poolMax: 6 });
  await migrateToLatest(database.db as never, migrations);
  if (options.seed !== false) await seedAi(database.db);

  const app = await createTestApp(AppModule.register(config, testLogger()), config);
  const redis = createRedis(TEST_REDIS_URL);
  const ns = new RedisNamespace(namespace);

  return {
    app,
    http: request(app.getHttpServer()),
    db: database.db,
    redis,
    config,
    async as(person) {
      return principalHeaders(principalFor(person));
    },
    async asCustom(userId, permissions, scope) {
      return principalHeaders({ userId, organizationId: ORGANIZATION.id, permissions, scope });
    },
    scenarioId(key) {
      const s = SCENARIOS.find((x) => x.key === key);
      if (!s) throw new Error(`Unknown scenario ${key}`);
      return s.id;
    },
    async grant(person, scenarioKey, overrides = {}) {
      return signLessonGrant(
        {
          userId: overrides.userId ?? PEOPLE[person].id,
          organizationId: ORGANIZATION.id,
          programId: '0190a3b2-0000-7000-8000-00000000aa01',
          enrollmentId: '0190a3b2-0000-7000-8000-00000000aa02',
          lessonId: '0190a3b2-0000-7000-8000-00000000aa03',
          resource: {
            type: overrides.resourceType ?? 'ai_scenario',
            id: overrides.resourceId ?? SCENARIOS.find((s) => s.key === scenarioKey)!.id,
          },
          policy: {},
        },
        overrides.secret ?? config.ai.lessonGrantSecret,
        overrides.ttlSeconds ?? 600,
      );
    },
    async close() {
      await closeApp(app);
      const keys = await redis.keys(`${ns.prefix}*`);
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
      await database.destroy();
      await tdb.drop();
    },
  };
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Parse a text/event-stream body into events (comments such as keep-alives are ignored). */
export function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block && !block.startsWith(':'))
    .map((block) => {
      const lines = block.split('\n');
      const event =
        lines
          .find((l) => l.startsWith('event:'))
          ?.slice(6)
          .trim() ?? 'message';
      const data = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

/** Send a message and collect the SSE events. */
export async function sendStreaming(
  h: AiHarness,
  headers: Record<string, string>,
  sessionId: string,
  body: Record<string, unknown>,
) {
  const res = await h.http
    .post(`/api/v1/ai/sessions/${sessionId}/messages`)
    .set(headers)
    .set('Accept', 'text/event-stream')
    .buffer(true)
    .parse((r, cb) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', (chunk: string) => (data += chunk));
      r.on('end', () => cb(null, data));
    })
    .send(body);
  const text = typeof res.body === 'string' ? res.body : '';
  return {
    status: res.status,
    headers: res.headers,
    text,
    events: res.status === 200 ? parseSse(text) : [],
  };
}

export function replyText(events: SseEvent[]): string {
  return events
    .filter((e) => e.event === 'delta')
    .map((e) => String(e.data.text))
    .join('');
}

export async function startSession(
  h: AiHarness,
  headers: Record<string, string>,
  scenarioKey: string,
  extra: Record<string, unknown> = {},
) {
  const res = await h.http
    .post('/api/v1/ai/sessions')
    .set(headers)
    .send({ scenarioId: h.scenarioId(scenarioKey), ...extra });
  return res;
}
