import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { learningEvents, type EventEnvelope } from '@a5/events';
import { uuidv7 } from '@a5/observability';
import { PEOPLE, PROGRAM, seedId, type PersonKey } from '@a5/seed-data';
import { waitFor } from '@a5/testing';
import { NotificationStreamService } from '../src/realtime/stream.service.js';
import {
  createNotificationHarness,
  notificationsOf,
  openStream,
  processed,
  type NotificationHarness,
} from './harness.js';

let worker: NotificationHarness;
let api: NotificationHarness;
let workerUrl: string;
let apiUrl: string;

beforeAll(async () => {
  const env = { SSE_HEARTBEAT_MS: '150', SSE_MAX_CONNECTIONS_PER_USER: '3' };
  // Instance A consumes events and creates notifications; instance B only serves HTTP.
  worker = await createNotificationHarness('stream', { role: 'all', env });
  api = await createNotificationHarness('stream-api', {
    role: 'api',
    env,
    database: { url: worker.databaseUrl },
    namespace: worker.namespace,
  });
  workerUrl = await worker.listen();
  apiUrl = await api.listen();
});
afterAll(async () => {
  await api?.close();
  await worker?.close();
});

function enrolled(person: PersonKey): EventEnvelope {
  return worker.event(learningEvents.enrolled, {
    enrollmentId: seedId(`enrollment:${person}:refresher:${uuidv7()}`),
    programId: PROGRAM.id,
    userId: PEOPLE[person].id,
    programTitle: 'Storm Season Refresher',
    assignedBy: PEOPLE.luis.id,
    dueAt: null,
    source: 'manual',
  });
}

const json = (data: string | null) => JSON.parse(data ?? 'null') as Record<string, unknown>;

describe('notification stream (SSE)', () => {
  it('rejects unauthenticated connections', async () => {
    const res = await fetch(`${workerUrl}/api/v1/notifications/stream`);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHENTICATED');
  });

  it('sends the unread count, pushes new notifications, heartbeats and read updates', async () => {
    const stream = await openStream(
      `${workerUrl}/api/v1/notifications/stream`,
      await worker.as('naomi'),
    );
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(json((await stream.next((m) => m.event === 'unread')).data)).toEqual({ count: 0 });

    // The notification is created after the client connected.
    const event = enrolled('naomi');
    await worker.publish(event);
    const pushed = await stream.next((m) => m.event === 'notification');
    const body = json(pushed.data);
    expect(body).toMatchObject({
      type: 'training.assigned',
      title: 'New training: Storm Season Refresher',
      category: 'training',
      readAt: null,
    });
    expect(pushed.id).toBe(body.id);
    await stream.next((m) => m.event === 'unread' && json(m.data).count === 1);

    await stream.next((m) => Boolean(m.comment?.startsWith('heartbeat')), 2_000);

    const read = await worker.http
      .post(`/api/v1/notifications/${body.id as string}/read`)
      .set(await worker.as('naomi'));
    expect(read.status).toBe(200);
    await stream.next(
      (m) =>
        m.event === 'unread' &&
        json(m.data).count === 0 &&
        stream.messages.indexOf(m) > stream.messages.indexOf(pushed) + 1,
    );
    await stream.close();
  });

  it('cleans up the stream and its Redis subscription when the client disconnects', async () => {
    const service = worker.app.get(NotificationStreamService);
    const channel = worker.ns.key('rt', 'user', PEOPLE.isaiah.id);
    const stream = await openStream(
      `${workerUrl}/api/v1/notifications/stream`,
      await worker.as('isaiah'),
    );
    await stream.next((m) => m.event === 'unread');
    expect(service.count(PEOPLE.isaiah.id)).toBe(1);
    expect(((await worker.redis.pubsub('NUMSUB', channel)) as [string, number])[1]).toBe(1);

    await stream.close();
    await waitFor(() => service.count(PEOPLE.isaiah.id) === 0, {
      message: 'stream closed on the server',
    });
    await waitFor(
      async () => ((await worker.redis.pubsub('NUMSUB', channel)) as [string, number])[1] === 0,
      { message: 'unsubscribed' },
    );
  });

  it('limits concurrent streams per person', async () => {
    const headers = await worker.as('ethan');
    const open = await Promise.all(
      [1, 2, 3].map(() => openStream(`${workerUrl}/api/v1/notifications/stream`, headers)),
    );
    await Promise.all(open.map((s) => s.next((m) => m.event === 'unread')));
    const extra = await fetch(`${workerUrl}/api/v1/notifications/stream`, { headers });
    expect(extra.status).toBe(429);
    expect((await extra.json()).error.code).toBe('TOO_MANY_STREAMS');
    await Promise.all(open.map((s) => s.close()));
  });

  it('replays notifications missed since Last-Event-ID', async () => {
    const first = enrolled('sofia');
    await worker.publish(first);
    await processed(worker, first.id);
    const [anchor] = await notificationsOf(worker, 'sofia');
    const second = enrolled('sofia');
    await worker.publish(second);
    await processed(worker, second.id);
    const [missed] = await notificationsOf(worker, 'sofia');

    const stream = await openStream(`${workerUrl}/api/v1/notifications/stream`, {
      ...(await worker.as('sofia')),
      'last-event-id': anchor!.id,
    });
    const replayed = await stream.next((m) => m.event === 'notification');
    expect(replayed.id).toBe(missed!.id);
    await stream.next((m) => m.event === 'unread' && json(m.data).count === 2);
    expect(stream.messages.filter((m) => m.event === 'notification')).toHaveLength(1);
    await stream.close();
  });

  it('delivers to a stream held by another instance through Redis pub/sub', async () => {
    const stream = await openStream(
      `${apiUrl}/api/v1/notifications/stream`,
      await api.as('jasmine'),
    );
    await stream.next((m) => m.event === 'unread');
    expect(api.app.get(NotificationStreamService).count(PEOPLE.jasmine.id)).toBe(1);
    expect(worker.app.get(NotificationStreamService).count(PEOPLE.jasmine.id)).toBe(0);

    const event = enrolled('jasmine');
    await worker.publish(event);
    const pushed = await stream.next((m) => m.event === 'notification');
    expect(json(pushed.data)).toMatchObject({
      type: 'training.assigned',
      title: 'New training: Storm Season Refresher',
    });
    await stream.close();
  });

  it('ends open streams on shutdown so the server can close', async () => {
    const extra = await createNotificationHarness('stream-shutdown', {
      role: 'api',
      database: { url: worker.databaseUrl },
      namespace: worker.namespace,
    });
    const url = await extra.listen();
    const stream = await openStream(`${url}/api/v1/notifications/stream`, await extra.as('darius'));
    await stream.next((m) => m.event === 'unread');
    const started = Date.now();
    await extra.close();
    expect(Date.now() - started).toBeLessThan(5_000);
    await stream.close();
  });
});
