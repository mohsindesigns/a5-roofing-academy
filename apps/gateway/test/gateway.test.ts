import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  PRINCIPAL_HEADER,
  importAccessKeys,
  signAccessToken,
  verifyPrincipalToken,
  type PrincipalData,
} from '@a5/auth';
import { createRedis, RedisNamespace, type Redis } from '@a5/messaging';
import { TEST_INTERNAL_SECRET, closeApp, createTestApp, testLogger } from '@a5/nest-kit/testing';
import { TEST_REDIS_URL, testRedisNamespace } from '@a5/testing';
import { GatewayModule } from '../src/app.module.js';
import { loadGatewayConfig } from '../src/config.js';
import { isCanonicalPath } from '../src/proxy/routes.js';

const ORG = '0190a3b2-0000-7000-8000-00000000f001';
const USER = '0190a3b2-0000-7000-8000-00000000f002';
const SESSION = '0190a3b2-0000-7000-8000-00000000f003';

const principal: PrincipalData = {
  userId: USER,
  organizationId: ORG,
  sessionId: null,
  displayName: 'Danielle Okafor',
  roles: ['manager'],
  permissions: { 'enrollments.view': 'managed', 'training.participate': 'own' },
  managedTeamIds: ['0190a3b2-0000-7000-8000-00000000f004'],
  managedUserIds: [],
};

let upstream: Server;
let upstreamUrl: string;
let identityCalls: Array<{ path: string; sessionId: string | null }> = [];
let identityResponse: { principal: PrincipalData | null; sessionActive: boolean } = {
  principal,
  sessionActive: true,
};
let app: NestExpressApplication;
let redis: Redis;
let ns: RedisNamespace;
let keys: { privateKey: Parameters<typeof signAccessToken>[1]['privateKey']; kid: string };

function startUpstream(): Promise<void> {
  const fake = express();
  fake.get('/internal/principals/:id', (req, res) => {
    identityCalls.push({ path: req.path, sessionId: (req.query.sessionId as string) ?? null });
    res.json(identityResponse);
  });
  fake.get('/api/v1/notifications/stream', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ping\ndata: {"n":1}\n\n');
    setTimeout(() => {
      res.write('event: ping\ndata: {"n":2}\n\n');
      res.end();
    }, 30);
  });
  fake.all('/api/v1/{*rest}', express.json(), (req, res) => {
    res.json({
      path: req.originalUrl,
      method: req.method,
      principal: req.header(PRINCIPAL_HEADER) ?? null,
      service: req.header('x-a5-service') ?? null,
      requestId: req.header('x-request-id') ?? null,
      authorization: req.header('authorization') ?? null,
      body: req.body ?? null,
    });
  });
  upstream = createServer(fake);
  return new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
}

beforeAll(async () => {
  await startUpstream();
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const pair = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const imported = await importAccessKeys(pair.privateKey, pair.publicKey, 'test');
  keys = { privateKey: imported.privateKey!, kid: 'test' };
  const namespace = testRedisNamespace('gateway');
  ns = new RedisNamespace(namespace);
  const urls = Object.fromEntries(
    [
      'IDENTITY',
      'LEARNING',
      'MEDIA',
      'ASSESSMENT',
      'AI',
      'CERTIFICATION',
      'NOTIFICATION',
      'ANALYTICS',
    ].map((s) => [`${s}_SERVICE_URL`, upstreamUrl]),
  );
  // A port nothing listens on, to exercise upstream outages.
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
  const deadPort = (dead.address() as AddressInfo).port;
  await new Promise<void>((r) => dead.close(() => r()));
  urls.AUDIT_SERVICE_URL = `http://127.0.0.1:${deadPort}`;
  const config = loadGatewayConfig({
    NODE_ENV: 'test',
    REDIS_URL: TEST_REDIS_URL,
    REDIS_NAMESPACE: namespace,
    INTERNAL_AUTH_SECRET: TEST_INTERNAL_SECRET,
    AUTH_JWT_PUBLIC_KEY: pair.publicKey,
    LOG_LEVEL: 'silent',
    RATE_LIMIT_LOGIN_PER_MINUTE: '3',
    MAX_BODY_BYTES: '1024',
    ...urls,
  });
  app = await createTestApp(GatewayModule.register(config, testLogger()), config, undefined, {
    parseBodies: false,
  });
  redis = createRedis(TEST_REDIS_URL);
});

afterAll(async () => {
  await closeApp(app);
  const keysLeft = await redis.keys(`${ns.prefix}*`);
  if (keysLeft.length) await redis.del(...keysLeft);
  redis.disconnect();
  upstream.close();
});

beforeEach(async () => {
  identityCalls = [];
  identityResponse = { principal, sessionActive: true };
  await redis.set(ns.key('iam', 'sess', SESSION), '1', 'EX', 600);
  await redis.set(
    ns.key('iam', 'principal', USER),
    JSON.stringify({ epoch: 0, data: principal }),
    'EX',
    600,
  );
  await redis.del(ns.key('iam', 'epoch', ORG));
});

async function bearer(): Promise<string> {
  return `Bearer ${await signAccessToken({ sub: USER, sid: SESSION, org: ORG }, keys, 300)}`;
}

describe('authentication', () => {
  it('rejects protected routes without a token', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/enrollments');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects forged and expired tokens', async () => {
    const forged = await request(app.getHttpServer())
      .get('/api/v1/enrollments')
      .set('authorization', 'Bearer abc.def.ghi');
    expect(forged.body.error.code).toBe('TOKEN_INVALID');
    const expired = await request(app.getHttpServer())
      .get('/api/v1/enrollments')
      .set(
        'authorization',
        `Bearer ${await signAccessToken({ sub: USER, sid: SESSION, org: ORG }, keys, -5)}`,
      );
    expect(expired.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('forwards a signed principal from the Redis cache without calling identity', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/enrollments?status=active')
      .set('authorization', await bearer());
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('/api/v1/enrollments?status=active');
    expect(res.body.authorization).toBeNull();
    const forwarded = await verifyPrincipalToken(res.body.principal, TEST_INTERNAL_SECRET);
    expect(forwarded.userId).toBe(USER);
    expect(forwarded.sessionId).toBe(SESSION);
    expect(forwarded.scopeOf('enrollments.view')).toBe('managed');
    expect(identityCalls).toHaveLength(0);
  });

  it('strips internal headers supplied by the client', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/programs')
      .set('authorization', await bearer())
      .set(PRINCIPAL_HEADER, 'forged')
      .set('x-a5-service', 'forged');
    expect(res.body.service).toBeNull();
    expect(res.body.principal).not.toBe('forged');
  });

  it('re-resolves the principal after the organization epoch changes', async () => {
    await redis.incr(ns.key('iam', 'epoch', ORG));
    identityResponse = {
      principal: { ...principal, permissions: { 'training.participate': 'own' } },
      sessionActive: true,
    };
    const res = await request(app.getHttpServer())
      .get('/api/v1/programs')
      .set('authorization', await bearer());
    expect(identityCalls).toEqual([{ path: `/internal/principals/${USER}`, sessionId: null }]);
    const forwarded = await verifyPrincipalToken(res.body.principal, TEST_INTERNAL_SECRET);
    expect(forwarded.can('enrollments.view')).toBe(false);
  });

  it('asks identity to validate the session when its liveness key is missing', async () => {
    await redis.del(ns.key('iam', 'sess', SESSION));
    identityResponse = { principal: null, sessionActive: false };
    const res = await request(app.getHttpServer())
      .get('/api/v1/programs')
      .set('authorization', await bearer());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_REVOKED');
    expect(identityCalls[0]?.sessionId).toBe(SESSION);
  });

  it('allows public routes without a token', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/public/certificates/verify/abc');
    expect(res.status).toBe(200);
    expect(res.body.principal).toBeNull();
  });

  it('passes the principal on optional routes when a valid token is present', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('authorization', await bearer());
    expect(res.body.principal).not.toBeNull();
  });
});

describe('path canonicalization', () => {
  it('accepts ordinary paths', () => {
    expect(isCanonicalPath('/api/v1/programs/3f2a')).toBe(true);
    expect(isCanonicalPath('/api/v1/media/hls/abc/master.m3u8')).toBe(true);
  });

  it.each([
    '/api/v1/auth/password/../../../../health/ready',
    '/api/v1/auth/password/%2e%2e/%2E%2e/health',
    '/api/v1/auth//login',
    '/api/v1/auth/password/..%2fhealth',
    '/api/v1/auth\\login',
    '/api/v1/auth/password/./x',
  ])('refuses %s', (path) => {
    expect(isCanonicalPath(path)).toBe(false);
  });

  it('answers 400 instead of forwarding a traversal path', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/v1/auth/password/%2e%2e/%2e%2e/health/ready',
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PATH');
  });
});

describe('edge protections', () => {
  it('rate limits sign-in attempts per client', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (
          await request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .send({ email: 'a@b.c', password: 'x' })
        ).status,
      );
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('rejects oversized bodies', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/programs')
      .set('authorization', await bearer())
      .send({ description: 'x'.repeat(5_000) });
    expect(res.status).toBe(413);
  });

  it('returns 404 for unknown API paths', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/does-not-exist')
      .set('authorization', await bearer());
    expect(res.status).toBe(404);
  });

  it('streams server-sent events', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications/stream')
      .set('authorization', await bearer());
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('"n":1');
    expect(res.text).toContain('"n":2');
  });

  it('propagates the request id to services', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/programs')
      .set('authorization', await bearer())
      .set('x-request-id', 'client-req-123456');
    expect(res.body.requestId).toBe('client-req-123456');
    expect(res.headers['x-request-id']).toBe('client-req-123456');
  });
});

describe('upstream failures', () => {
  it('returns a clear 503 when a service is unreachable', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/audit/logs')
      .set('authorization', await bearer());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED/);
  });
});
