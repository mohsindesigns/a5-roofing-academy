import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { signPrincipalToken, PRINCIPAL_HEADER } from '@a5/auth';
import { createDatabase, migrateToLatest, type Database } from '@a5/database';
import { createRedis, RedisNamespace, type Redis } from '@a5/messaging';
import { TEST_INTERNAL_SECRET, closeApp, createTestApp, testLogger } from '@a5/nest-kit/testing';
import { DEFAULT_SEED_PASSWORD, PEOPLE, emailOf, type PersonKey } from '@a5/seed-data';
import { TEST_REDIS_URL, createTestDatabase, testRedisNamespace, type TestDatabase } from '@a5/testing';
import { AppModule, configureIdentityApp } from '../src/app.module.js';
import { loadIdentityConfig, type IdentityConfig } from '../src/config.js';
import { migrations } from '../src/database/migrations/index.js';
import type { IdentityDatabase } from '../src/database/schema.js';
import { PrincipalResolver } from '../src/access/principal.resolver.js';
import { seedIdentity } from '../src/seed/seed-identity.js';

export interface IdentityHarness {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  db: Database<IdentityDatabase>['db'];
  redis: Redis;
  ns: RedisNamespace;
  config: IdentityConfig;
  /** Principal headers for a seeded person, resolved exactly as the gateway would. */
  as(person: PersonKey | string): Promise<Record<string, string>>;
  email(person: PersonKey): string;
  password: string;
  close(): Promise<void>;
}

export async function createIdentityHarness(name: string): Promise<IdentityHarness> {
  const tdb: TestDatabase = await createTestDatabase(`identity_${name}`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const namespace = testRedisNamespace(`identity-${name}`);
  const config = loadIdentityConfig({
    NODE_ENV: 'test',
    DATABASE_URL: tdb.url,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_NAMESPACE: namespace,
    INTERNAL_AUTH_SECRET: TEST_INTERNAL_SECRET,
    AUTH_JWT_PRIVATE_KEY: privateKey,
    AUTH_JWT_PUBLIC_KEY: publicKey,
    LOG_LEVEL: 'silent',
    SERVICE_ROLE: 'api',
    COOKIE_SECURE: 'false',
    EXPOSE_ACTIVATION_LINKS: 'true',
  });
  const database = createDatabase<IdentityDatabase>({ url: tdb.url, poolMax: 4 });
  await migrateToLatest(database.db as never, migrations);
  await seedIdentity(database.db, { fastHash: true });

  const app = await createTestApp(AppModule.register(config, testLogger()), config, configureIdentityApp);
  const redis = createRedis(TEST_REDIS_URL);
  const ns = new RedisNamespace(namespace);
  const resolver = app.get(PrincipalResolver);

  return {
    app,
    http: request(app.getHttpServer()),
    db: database.db,
    redis,
    ns,
    config,
    password: DEFAULT_SEED_PASSWORD,
    email: (p) => emailOf(PEOPLE[p]),
    async as(person) {
      const userId = person in PEOPLE ? PEOPLE[person as PersonKey].id : person;
      const data = await resolver.compute(userId, null);
      if (!data) throw new Error(`No active principal for ${person}`);
      return { [PRINCIPAL_HEADER]: await signPrincipalToken(data, TEST_INTERNAL_SECRET) };
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

/** Extract a cookie value from a supertest response. */
export function cookie(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
  for (const c of list) {
    const [pair] = c.split(';');
    const [k, ...v] = pair!.split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
