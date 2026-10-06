import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  createDatabase,
  createInboxTable,
  createOutboxTable,
  migrateToLatest,
  writeOutbox,
  type Database,
  type InboxSchema,
  type OutboxSchema,
} from '@a5/database';
import {
  buildEvent,
  identityEvents,
  streamFor,
  type EventEnvelope,
} from '@a5/events';
import { uuidv7 } from '@a5/observability';
import {
  TEST_REDIS_URL,
  createTestDatabase,
  testRedisNamespace,
  waitFor,
  type TestDatabase,
} from '@a5/testing';
import {
  Cache,
  DistributedLock,
  OutboxRelay,
  QueueFactory,
  RateLimiter,
  RedisNamespace,
  StreamConsumer,
  StreamPublisher,
  createRedis,
  processOnce,
  signEvent,
  verifyEvent,
  type Redis,
} from './index.js';

const logger = pino({ level: 'silent' });
const ORG = '0190a3b2-0000-7000-8000-0000000000a1';
const EVENT_SECRET = 'identity-event-signing-secret-for-tests-123456789';

describe('event signatures', () => {
  it('uses canonical envelope fields and detects altered events', () => {
    const signed = userActivated();
    const reordered = Object.fromEntries(Object.entries(signed).reverse()) as EventEnvelope;
    expect(verifyEvent(signed, EVENT_SECRET)).toBe(true);
    expect(verifyEvent(reordered, EVENT_SECRET)).toBe(true);
    expect(verifyEvent(signed, 'another-event-signing-secret-for-tests-123456789')).toBe(false);
    expect(verifyEvent({ ...signed, organizationId: null }, EVENT_SECRET)).toBe(false);
  });
});

function userActivated(userId = uuidv7()): EventEnvelope {
  return signEvent(buildEvent(
    identityEvents.userActivated,
    { userId },
    {
      id: uuidv7(),
      producer: 'identity-service',
      organizationId: ORG,
      actor: { type: 'system', id: null },
    },
  ), EVENT_SECRET);
}

let tdb: TestDatabase;
let database: Database<OutboxSchema & InboxSchema>;
let redis: Redis;
let ns: RedisNamespace;

beforeAll(async () => {
  tdb = await createTestDatabase('messaging');
  database = createDatabase({ url: tdb.url, poolMax: 5 });
  await migrateToLatest(database.db as never, {
    '0001': {
      up: async (db) => {
        await createOutboxTable(db);
        await createInboxTable(db);
      },
    },
  });
  redis = createRedis(TEST_REDIS_URL);
  ns = new RedisNamespace(testRedisNamespace('messaging'));
});

afterAll(async () => {
  const keys = await redis.keys(`${ns.prefix}*`);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
  await database.destroy();
  await tdb.drop();
});

describe('outbox → stream → consumer', () => {
  it('delivers committed events exactly once per handler', async () => {
    const publisher = new StreamPublisher(redis, ns);
    const relay = new OutboxRelay({
      db: database.db,
      databaseUrl: tdb.url,
      publisher,
      logger,
      pollIntervalMs: 100,
    });
    const stream = streamFor('identity-service');
    const consumer = new StreamConsumer({
      redis,
      ns,
      group: 'test-consumer',
      streams: [stream],
      signingKeys: { 'identity-service': EVENT_SECRET },
      logger,
      blockMs: 100,
    });
    const seen: string[] = [];
    consumer.on('user.activated', async (event) => {
      await processOnce(database.db, 'count-activations', event, async () => {
        seen.push((event.payload as { userId: string }).userId);
      });
    });
    await consumer.start();
    await relay.start();

    const event = userActivated();
    await database.db
      .transaction()
      .execute((trx) =>
        writeOutbox(trx, [
          {
            id: event.id,
            type: event.type,
            version: event.version,
            stream,
            envelope: event,
            published_at: null,
            last_error: null,
          },
        ]),
      );
    await waitFor(() => seen.length === 1, { message: 'event delivery' });

    // Simulate a duplicate publish (relay crashed after XADD, before marking published).
    await publisher.publish([{ stream, envelope: event }]);
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toHaveLength(1);

    const row = await database.db
      .selectFrom('outbox_events')
      .select('published_at')
      .where('id', '=', event.id)
      .executeTakeFirstOrThrow();
    expect(row.published_at).toBeInstanceOf(Date);

    await relay.stop();
    await consumer.stop();
  });

  it('retries failing handlers and dead-letters after max deliveries', async () => {
    const publisher = new StreamPublisher(redis, ns);
    const stream = `${streamFor('identity-service')}:retry-test`;
    const consumer = new StreamConsumer({
      redis,
      ns,
      group: 'retry-group',
      streams: [stream],
      signingKeys: { 'identity-service': EVENT_SECRET },
      logger,
      blockMs: 50,
      claimIdleMs: 1,
      maxDeliveries: 3,
    });
    let calls = 0;
    consumer.on('user.activated', async () => {
      calls += 1;
      throw new Error('downstream unavailable');
    });
    await consumer.ensureGroups();
    await publisher.publish([{ stream, envelope: userActivated() }]);
    await consumer.start();
    await waitFor(async () => (await redis.xlen(consumer.dlqKey)) === 1, {
      message: 'dead letter',
      timeoutMs: 8_000,
    });
    await consumer.stop();
    expect(calls).toBe(3);
    const pending = (await redis.xpending(ns.stream(stream), 'retry-group')) as [number];
    expect(pending[0]).toBe(0);

    // Replay puts the original envelope back on its source stream.
    expect(await consumer.replayDeadLetters()).toBe(1);
    expect(await redis.xlen(consumer.dlqKey)).toBe(0);
  });

  it('dead-letters malformed envelopes immediately', async () => {
    const stream = `${streamFor('identity-service')}:malformed-test`;
    const consumer = new StreamConsumer({
      redis,
      ns,
      group: 'malformed',
      streams: [stream],
      logger,
      blockMs: 50,
    });
    await consumer.ensureGroups();
    await redis.xadd(
      ns.stream(stream),
      '*',
      'id',
      'x',
      'type',
      'user.activated',
      'envelope',
      JSON.stringify({ type: 'user.activated' }),
    );
    await consumer.start();
    await waitFor(async () => (await redis.xlen(consumer.dlqKey)) === 1, {
      message: 'malformed dead letter',
    });
    await consumer.stop();
  });

  it('dead-letters producer mismatches and invalid signatures', async () => {
    const identityStream = `${streamFor('identity-service')}:signature-test`;
    const learningStream = `${streamFor('learning-service')}:producer-mismatch-test`;
    const consumer = new StreamConsumer({
      redis,
      ns,
      group: 'signature-checks',
      streams: [identityStream, learningStream],
      signingKeys: { 'identity-service': EVENT_SECRET },
      logger,
      blockMs: 50,
    });
    let calls = 0;
    consumer.on('user.activated', async () => {
      calls += 1;
    });
    await consumer.ensureGroups();
    const signed = userActivated();
    await redis.xadd(
      ns.stream(learningStream),
      '*',
      'id',
      signed.id,
      'type',
      signed.type,
      'envelope',
      JSON.stringify(signed),
    );
    await redis.xadd(
      ns.stream(identityStream),
      '*',
      'id',
      signed.id,
      'type',
      signed.type,
      'envelope',
      JSON.stringify({ ...signed, organizationId: null }),
    );
    await consumer.start();
    await waitFor(async () => (await redis.xlen(consumer.dlqKey)) === 2, {
      message: 'invalid producer and signature dead letters',
    });
    await consumer.stop();
    expect(calls).toBe(0);
  });

  it('rejects unsigned envelopes unless the consumer explicitly allows compatibility mode', async () => {
    const stream = `${streamFor('identity-service')}:unsigned-test`;
    const consumer = new StreamConsumer({
      redis,
      ns,
      group: 'unsigned-disabled',
      streams: [stream],
      signingKeys: { 'identity-service': EVENT_SECRET },
      logger,
      blockMs: 50,
    });
    const unsigned = buildEvent(
      identityEvents.userActivated,
      { userId: uuidv7() },
      {
        id: uuidv7(),
        producer: 'identity-service',
        organizationId: ORG,
        actor: { type: 'system', id: null },
      },
    );
    await consumer.ensureGroups();
    await new StreamPublisher(redis, ns).publish([{ stream, envelope: unsigned }]);
    await consumer.start();
    await waitFor(async () => (await redis.xlen(consumer.dlqKey)) === 1, {
      message: 'unsigned envelope dead letter',
    });
    await consumer.stop();
  });
});

describe('DistributedLock', () => {
  it('grants a lock to one holder at a time and only the holder can release', async () => {
    const locks = new DistributedLock(redis, ns);
    const a = await locks.acquire('cert:def:user', 5_000);
    const b = await locks.acquire('cert:def:user', 5_000);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(await a!.release()).toBe(true);
    expect(await a!.release()).toBe(false);
    const c = await locks.acquire('cert:def:user', 5_000);
    expect(c).not.toBeNull();
    await c!.release();
  });

  it('serialises concurrent withLock callers when waiting is allowed', async () => {
    const locks = new DistributedLock(redis, ns);
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        locks.withLock(
          'serial',
          2_000,
          async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 20));
            active -= 1;
          },
          { waitMs: 5_000 },
        ),
      ),
    );
    expect(maxActive).toBe(1);
  });
});

describe('Cache', () => {
  it('loads once under concurrency and invalidates by namespace version', async () => {
    const cache = new Cache(redis, ns);
    let loads = 0;
    const loader = async () => {
      loads += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { title: 'A5 New Hire Sales Academy' };
    };
    const key = await cache.versioned('program', 'p1');
    const results = await Promise.all([1, 2, 3].map(() => cache.getOrSet(key, 60, loader)));
    expect(loads).toBe(1);
    expect(results[2]).toEqual({ title: 'A5 New Hire Sales Academy' });
    await cache.bump('program');
    const nextKey = await cache.versioned('program', 'p1');
    expect(nextKey).not.toBe(key);
    await cache.getOrSet(nextKey, 60, loader);
    expect(loads).toBe(2);
  });
});

describe('RateLimiter', () => {
  it('blocks after the limit within a window', async () => {
    const limiter = new RateLimiter(redis, ns);
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.hit('login', '10.0.0.1', 3, 60));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]!.remaining).toBe(0);
    expect(results[3]!.resetSeconds).toBeGreaterThan(0);
  });
});

describe('QueueFactory', () => {
  it('retries jobs and copies exhausted jobs to the dead-letter queue', async () => {
    const factory = new QueueFactory({ redisUrl: TEST_REDIS_URL, prefix: ns.prefix, logger });
    let attempts = 0;
    factory.worker<{ n: number }>('flaky', async () => {
      attempts += 1;
      throw new Error('PDF renderer unavailable');
    });
    await factory
      .queue('flaky')
      .add('render', { n: 1 }, { attempts: 2, backoff: { type: 'fixed', delay: 10 } });
    await waitFor(async () => (await factory.queue('flaky.dlq').count()) === 1, {
      message: 'job dead letter',
      timeoutMs: 10_000,
    });
    expect(attempts).toBe(2);
    const [dead] = await factory.queue<Record<string, unknown>>('flaky.dlq').getJobs(['waiting']);
    expect(dead?.data).toMatchObject({ queue: 'flaky', error: 'PDF renderer unavailable' });
    await factory.close();
  });
});
