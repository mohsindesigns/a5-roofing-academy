import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PRINCIPAL_HEADER, SERVICE_TOKEN_HEADER, signPrincipalToken, verifyServiceToken, type PrincipalData } from '@a5/auth';
import { createDatabase, migrateToLatest, type Database } from '@a5/database';
import { buildEvent, type EventEnvelope } from '@a5/events';
import { createRedis, type Redis } from '@a5/messaging';
import { TEST_INTERNAL_SECRET, closeApp, createTestApp, testLogger } from '@a5/nest-kit/testing';
import { uuidv7 } from '@a5/observability';
import { DEFAULT_ROLES, widestScope, type DataScope, type PermissionMap } from '@a5/permissions';
import { ORGANIZATION, PEOPLE, TEAMS, TRAINER_ASSIGNMENTS, type PersonKey } from '@a5/seed-data';
import { LocalDiskStorage } from '@a5/storage';
import { TEST_REDIS_URL, createTestDatabase, testRedisNamespace, type TestDatabase } from '@a5/testing';
import { AppModule } from '../src/app.module.js';
import { loadCertificationConfig, type CertificationConfig } from '../src/config.js';
import { migrations } from '../src/database/migrations/index.js';
import type { CertificationDatabase } from '../src/database/schema.js';
import { ProjectionsConsumer } from '../src/eligibility/projections.consumer.js';
import { EligibilityService } from '../src/eligibility/eligibility.service.js';
import { IssuanceService } from '../src/issuance/issuance.service.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import { LifecycleService } from '../src/jobs/lifecycle.service.js';
import { PdfService } from '../src/issuance/pdf.service.js';
import { VerificationService } from '../src/verification/verification.service.js';
import { seedCertification } from '../src/seed/seed-certification.js';

export interface CertHarness {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  db: Database<CertificationDatabase>['db'];
  redis: Redis;
  config: CertificationConfig;
  storage: LocalDiskStorage;
  storageRoot: string;
  consumer: ProjectionsConsumer;
  eligibility: EligibilityService;
  issuance: IssuanceService;
  lifecycle: LifecycleService;
  jobs: JobsService;
  pdf: PdfService;
  verification: VerificationService;
  /** Identity stub: names it returns for `GET /internal/users?ids=`; `null` makes it unreachable. */
  identity: { names: Map<string, { firstName: string; lastName: string }>; calls: string[]; down: boolean };
  /** Principal headers for a seeded person, computed like identity's principal resolver. */
  as(person: PersonKey): Promise<Record<string, string>>;
  /** Headers for an arbitrary principal. */
  principal(input: Partial<PrincipalData> & { userId: string }): Promise<Record<string, string>>;
  /** Publish a domain event to the consumer exactly as the stream consumer would. */
  deliver(def: Parameters<typeof buildEvent>[0], payload: unknown, options?: { id?: string; occurredAt?: Date }): Promise<EventEnvelope>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Seed the A5 catalogue (default true). */
  seed?: boolean;
  /** `all` also starts the BullMQ workers, outbox relay and event consumers. */
  role?: 'api' | 'all';
  env?: Record<string, string>;
}

function permissionsOf(person: PersonKey): PermissionMap {
  const map: PermissionMap = {};
  for (const roleKey of PEOPLE[person].roles) {
    const role = DEFAULT_ROLES.find((r) => r.key === roleKey)!;
    for (const key of role.permissions) {
      const existing = map[key];
      map[key] = existing ? widestScope(existing, role.dataScope as DataScope) : (role.dataScope as DataScope);
    }
  }
  return map;
}

export async function createCertHarness(name: string, options: HarnessOptions = {}): Promise<CertHarness> {
  const tdb: TestDatabase = await createTestDatabase(`cert_${name}`);
  const storageRoot = await mkdtemp(join(tmpdir(), 'a5-cert-'));
  const namespace = testRedisNamespace(`cert-${name}`);

  // Minimal identity stub (service-to-service contract: GET /internal/users?ids=a,b with a service token).
  const identity: CertHarness['identity'] = { names: new Map(), calls: [], down: false };
  const stub: Server = createServer((req, res) => {
    void (async () => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const token = req.headers[SERVICE_TOKEN_HEADER];
    const caller = typeof token === 'string' ? await verifyServiceToken(token, TEST_INTERNAL_SECRET).catch(() => null) : null;
    if (identity.down || !caller || url.pathname !== '/internal/users') {
      res.statusCode = identity.down ? 503 : 401;
      res.end('{}');
      return;
    }
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
    identity.calls.push(...ids);
    const items = ids.flatMap((id) => {
      const override = identity.names.get(id);
      const person = Object.values(PEOPLE).find((p) => p.id === id);
      if (!override && !person) return [];
      return [
        {
          id,
          organizationId: ORGANIZATION.id,
          firstName: override?.firstName ?? person!.firstName,
          lastName: override?.lastName ?? person!.lastName,
          employeeId: person?.employeeId ?? null,
          status: 'active',
        },
      ];
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ items }));
    })();
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const identityUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;

  const config = loadCertificationConfig({
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
    CERTIFICATION_FILES_URL: 'http://localhost/api/v1/certification-files',
    IDENTITY_SERVICE_URL: identityUrl,
    PUBLIC_APP_URL: 'https://academy.a5roofing.example',
    CERT_SWEEP_INTERVAL_MS: '3600000',
    ...options.env,
  });
  const storage = new LocalDiskStorage({ root: storageRoot, publicBaseUrl: config.storage.filesBaseUrl, signingSecret: config.storage.signingSecret });

  const database = createDatabase<CertificationDatabase>({ url: tdb.url, poolMax: 4 });
  await migrateToLatest(database.db as never, migrations);

  const app = await createTestApp(AppModule.register(config, testLogger(), { storage }), config);
  app.getHttpServer().setMaxListeners(100);
  const get = <T>(cls: abstract new (...args: never[]) => T): T => app.get(cls as never, { strict: false });
  const eligibility = get(EligibilityService);
  const issuance = get(IssuanceService);
  const lifecycle = get(LifecycleService);
  if (options.seed !== false) {
    await seedCertification({ db: database.db, storage, config, issuance, eligibility, lifecycle }, {});
  }

  const redis = createRedis(TEST_REDIS_URL);
  const h: CertHarness = {
    app,
    http: request(app.getHttpServer()),
    db: database.db,
    redis,
    config,
    storage,
    storageRoot,
    consumer: get(ProjectionsConsumer),
    eligibility,
    issuance,
    lifecycle,
    jobs: get(JobsService),
    pdf: get(PdfService),
    verification: get(VerificationService),
    identity,
    async as(person) {
      const p = PEOPLE[person];
      const managedTeamIds = TEAMS.filter((t) => (t.managers as readonly string[]).includes(person)).map((t) => t.id);
      const managedUserIds = TRAINER_ASSIGNMENTS.filter((a) => a.trainer === person).flatMap((a) => a.trainees.map((t) => PEOPLE[t].id));
      return h.principal({
        userId: p.id,
        displayName: `${p.firstName} ${p.lastName}`,
        roles: [...p.roles],
        permissions: permissionsOf(person),
        managedTeamIds,
        managedUserIds,
      });
    },
    async principal(input) {
      const data: PrincipalData = {
        organizationId: ORGANIZATION.id,
        sessionId: null,
        displayName: 'Test User',
        roles: [],
        permissions: {},
        managedTeamIds: [],
        managedUserIds: [],
        ...input,
      };
      return { [PRINCIPAL_HEADER]: await signPrincipalToken(data, TEST_INTERNAL_SECRET) };
    },
    async deliver(def, payload, opts = {}) {
      const event = buildEvent(def, payload as never, {
        id: opts.id ?? uuidv7(),
        producer: def.producer,
        organizationId: ORGANIZATION.id,
        actor: { type: 'system', id: null },
        occurredAt: opts.occurredAt ?? new Date(),
      }) as EventEnvelope;
      await h.consumer.dispatch(event);
      return event;
    },
    async close() {
      await closeApp(app);
      const keys = await redis.keys(`${namespace}*`);
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
      await database.destroy();
      // Let closed pool connections finish their shutdown handshake before the database is dropped.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await tdb.drop();
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
  return h;
}

export { solidJpeg, solidPng } from './images.js';
