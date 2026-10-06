import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PEOPLE, type PersonKey } from '@a5/seed-data';
import { ProgressFlushWorker } from '../src/telemetry/progress-flush.worker.js';
import { WatchBuffer } from '../src/telemetry/watch-buffer.js';
import { insertReadyVideo, outboxEvents } from './fixtures.js';
import { LESSON_ID, ORG, createMediaHarness, type MediaHarness } from './harness.js';

let h: MediaHarness;

beforeAll(async () => {
  h = await createMediaHarness('telemetry');
});
afterAll(() => h?.close());

interface Session {
  assetId: string;
  token: string;
  headers: Record<string, string>;
  userId: string;
}

async function session({
  duration = 100,
  policy = {},
  person = 'marcus' as PersonKey,
} = {}): Promise<Session> {
  const assetId = await insertReadyVideo(h, { durationSeconds: duration });
  const headers = await h.as(person);
  const grant = await h.grant({
    userId: PEOPLE[person].id,
    resource: { type: 'media', id: assetId },
    policy,
  });
  const res = await h.http.post('/api/v1/media/playback').set(headers).send({ grant });
  expect(res.status).toBe(200);
  return { assetId, token: res.body.playbackToken, headers, userId: PEOPLE[person].id };
}

type Triple = [start: number, end: number, rate: number];

function beat(
  s: Session,
  intervals: Triple[],
  { position, ended = false }: { position?: number; ended?: boolean } = {},
) {
  return h.http
    .post('/api/v1/media/playback/heartbeat')
    .set(s.headers)
    .send({
      playbackToken: s.token,
      intervals: intervals.map(([start, end, rate]) => ({ start, end, rate })),
      positionSeconds: position ?? intervals[intervals.length - 1]?.[1] ?? 0,
      ended,
      clientSentAt: new Date().toISOString(),
    });
}

const progressRow = (s: Session) =>
  h.db
    .selectFrom('video_progress')
    .selectAll()
    .where('asset_id', '=', s.assetId)
    .where('user_id', '=', s.userId)
    .executeTakeFirst();

async function eventsFor(s: Session, type: string) {
  return (await outboxEvents(h, type)).filter((e) => e.payload.assetId === s.assetId);
}

describe('watch crediting', () => {
  it('credits normal viewing, including allowed faster playback', async () => {
    const s = await session();
    h.clock.advance(15_000);
    const first = await beat(s, [[0, 15, 1]]);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      watchedSeconds: 15,
      watchedPercent: 15,
      creditedSeconds: 15,
      completed: false,
      nextHeartbeatSeconds: 15,
    });

    h.clock.advance(15_000);
    expect((await beat(s, [[15, 30, 1]])).body).toMatchObject({
      watchedSeconds: 30,
      creditedSeconds: 15,
    });

    // 15 s of content at 1.5× takes 10 s of wall clock (policy allows up to 2×).
    h.clock.advance(10_000);
    expect((await beat(s, [[30, 45, 1.5]])).body).toMatchObject({
      watchedSeconds: 45,
      watchedPercent: 45,
      creditedSeconds: 15,
    });
  });

  it('does not credit 60 s of content claimed within 5 s of wall clock', async () => {
    const s = await session();
    h.clock.advance(5_000);
    const res = await beat(s, [[0, 60, 1]]);
    expect(res.status).toBe(200);
    // Elapsed (5–6 s, token issue time is whole seconds) + 2 s tolerance at 1×.
    expect(res.body.creditedSeconds).toBeGreaterThanOrEqual(7);
    expect(res.body.creditedSeconds).toBeLessThan(8.01);
    expect(res.body.watchedPercent).toBeLessThan(9);

    // Replaying the same claim later only credits what the new wall-clock time allows.
    h.clock.advance(3_000);
    const replay = await beat(s, [[0, 60, 1]]);
    expect(replay.body.watchedSeconds).toBeLessThan(13.01);
  });

  it('does not credit viewing faster than the policy allows', async () => {
    const s = await session();
    h.clock.advance(10_000);
    expect((await beat(s, [[0, 30, 3]])).body).toMatchObject({
      creditedSeconds: 0,
      watchedSeconds: 0,
    });

    const strict = await session({ policy: { maxCreditedPlaybackRate: 1 } });
    h.clock.advance(10_000);
    expect((await beat(strict, [[0, 15, 1.5]])).body).toMatchObject({ creditedSeconds: 0 });
    h.clock.advance(10_000);
    expect((await beat(strict, [[0, 10, 1]])).body).toMatchObject({ creditedSeconds: 10 });
  });

  it('ignores seeks: only played intervals count', async () => {
    const s = await session();
    h.clock.advance(15_000);
    expect((await beat(s, [[0, 10, 1]], { position: 80 })).body.watchedSeconds).toBe(10);
    h.clock.advance(15_000);
    const res = await beat(s, [[80, 95, 1]]);
    expect(res.body).toMatchObject({ watchedSeconds: 25, watchedPercent: 25 });
    // Re-watching credited time adds nothing.
    h.clock.advance(15_000);
    expect((await beat(s, [[80, 95, 1]])).body).toMatchObject({
      watchedSeconds: 25,
      creditedSeconds: 0,
    });
  });

  it('rejects heartbeats for another account or with an expired session', async () => {
    const s = await session();
    const otherUser = await h.http
      .post('/api/v1/media/playback/heartbeat')
      .set(await h.as('tyler'))
      .send({ playbackToken: s.token, intervals: [], positionSeconds: 0 });
    expect(otherUser.status).toBe(403);
    expect(
      (
        await h.http
          .post('/api/v1/media/playback/heartbeat')
          .send({ playbackToken: s.token, intervals: [], positionSeconds: 0 })
      ).status,
    ).toBe(401);

    h.clock.advance((h.config.media.playbackTtlSeconds + 1) * 1000);
    const expired = await beat(s, [[0, 5, 1]]);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('PLAYBACK_EXPIRED');
  });
});

describe('milestones', () => {
  it('emits started, each 5 % boundary and completion exactly once', async () => {
    const s = await session();
    for (let start = 0; start < 100; start += 15) {
      h.clock.advance(15_000);
      const res = await beat(s, [[start, Math.min(start + 15, 100), 1]], {
        ended: start + 15 >= 100,
      });
      expect(res.status).toBe(200);
    }
    const started = await eventsFor(s, 'video.started');
    const progressed = await eventsFor(s, 'video.progressed');
    const completed = await eventsFor(s, 'video.completed');
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toEqual({
      assetId: s.assetId,
      userId: s.userId,
      contextType: 'lesson',
      contextId: LESSON_ID,
    });
    expect(progressed.map((e) => e.payload.watchedPercent)).toEqual([15, 30, 45, 60, 75, 90, 100]);
    expect(completed).toHaveLength(1);
    expect(completed[0]!).toMatchObject({
      organizationId: ORG,
      payload: {
        watchedPercent: 100,
        watchedSeconds: 100,
        durationSeconds: 100,
        contextType: 'lesson',
        contextId: LESSON_ID,
        userId: s.userId,
      },
    });

    const row = (await progressRow(s))!;
    expect(row).toMatchObject({ percent: 100, watched_seconds: 100, intervals: [[0, 100]] });
    expect(row.completed_at).not.toBeNull();
    expect(row.milestones_emitted).toEqual(Array.from({ length: 20 }, (_, i) => (i + 1) * 5));

    // Repeated and concurrent heartbeats change nothing.
    h.clock.advance(15_000);
    const burst = await Promise.all(Array.from({ length: 5 }, () => beat(s, [[0, 15, 1]])));
    expect(burst.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(burst[0]!.body).toMatchObject({ completed: true, watchedPercent: 100 });

    // Another instance without the Redis buffer (e.g. after expiry) must not re-announce anything.
    await h.redis.del(h.app.get(WatchBuffer).key(s.userId, s.assetId, 'lesson', LESSON_ID));
    h.clock.advance(15_000);
    expect((await beat(s, [[0, 15, 1]])).body).toMatchObject({
      watchedPercent: 100,
      completed: true,
    });
    await h.app.get(ProgressFlushWorker).flushDirty();

    expect(await eventsFor(s, 'video.started')).toHaveLength(1);
    expect(await eventsFor(s, 'video.progressed')).toHaveLength(7);
    expect(await eventsFor(s, 'video.completed')).toHaveLength(1);
  });

  it('writes PostgreSQL behind the heartbeats, immediately only on milestones', async () => {
    const s = await session({ duration: 1000 });
    h.clock.advance(15_000);
    await beat(s, [[0, 15, 1]]); // first report: row created, video.started
    expect((await progressRow(s))?.watched_seconds).toBe(15);

    h.clock.advance(15_000);
    await beat(s, [[15, 30, 1]]); // 3 %: buffered only
    expect((await progressRow(s))?.watched_seconds).toBe(15);
    const buffer = h.app.get(WatchBuffer);
    expect(
      await h.redis.sismember(
        buffer.dirtyKey,
        buffer.key(s.userId, s.assetId, 'lesson', LESSON_ID),
      ),
    ).toBe(1);

    const flushed = await h.app.get(ProgressFlushWorker).flushDirty();
    expect(flushed.failed).toBe(0);
    expect(flushed.flushed).toBeGreaterThanOrEqual(1);
    expect((await progressRow(s))?.watched_seconds).toBe(30);
    expect(await h.redis.scard(buffer.dirtyKey)).toBe(0);

    h.clock.advance(15_000);
    await beat(s, [[30, 45, 1]]); // 4.5 %
    expect((await progressRow(s))?.watched_seconds).toBe(30);
    h.clock.advance(15_000);
    await beat(s, [[45, 60, 1]]); // crosses 5 %: persisted at once
    expect(await progressRow(s)).toMatchObject({
      watched_seconds: 60,
      percent: 6,
      last_position_seconds: 60,
    });
    expect(await eventsFor(s, 'video.progressed')).toHaveLength(1);
    expect(await eventsFor(s, 'video.started')).toHaveLength(1);
  });

  it('returns saved progress as the resume point', async () => {
    const s = await session();
    h.clock.advance(40_000);
    await beat(s, [[0, 40, 1]]);
    const again = await h.http
      .post('/api/v1/media/playback')
      .set(s.headers)
      .send({
        grant: await h.grant({ userId: s.userId, resource: { type: 'media', id: s.assetId } }),
      });
    expect(again.body.resume).toEqual({
      positionSeconds: 40,
      watchedPercent: 40,
      completed: false,
    });
  });
});

describe('beacon', () => {
  it('accepts text/plain and JSON beacons carrying a valid playback token', async () => {
    const s = await session();
    h.clock.advance(15_000);
    const body = JSON.stringify({
      playbackToken: s.token,
      intervals: [{ start: 0, end: 15, rate: 1 }],
      positionSeconds: 15,
      ended: false,
      clientSentAt: new Date().toISOString(),
    });
    const text = await h.http
      .post('/api/v1/media/playback/beacon')
      .set('content-type', 'text/plain;charset=UTF-8')
      .send(body);
    expect(text.status).toBe(204);

    h.clock.advance(15_000);
    const json = await h.http
      .post('/api/v1/media/playback/beacon')
      .set('content-type', 'application/json')
      .send({
        playbackToken: s.token,
        intervals: [{ start: 15, end: 30, rate: 1 }],
        positionSeconds: 30,
      });
    expect(json.status).toBe(204);

    const resume = await h.http
      .post('/api/v1/media/playback')
      .set(s.headers)
      .send({
        grant: await h.grant({ userId: s.userId, resource: { type: 'media', id: s.assetId } }),
      });
    expect(resume.body.resume).toMatchObject({ positionSeconds: 30, watchedPercent: 30 });
  });

  it('refuses beacons without a valid token or with a malformed body', async () => {
    const s = await session();
    const forged = await h.http
      .post('/api/v1/media/playback/beacon')
      .set('content-type', 'text/plain')
      .send(
        JSON.stringify({
          playbackToken: `${s.token.slice(0, -4)}AAAA`,
          intervals: [{ start: 0, end: 15, rate: 1 }],
          positionSeconds: 15,
        }),
      );
    expect(forged.status).toBe(401);
    expect(
      (
        await h.http
          .post('/api/v1/media/playback/beacon')
          .set('content-type', 'text/plain')
          .send('{not json')
      ).status,
    ).toBe(400);
    expect(
      (
        await h.http
          .post('/api/v1/media/playback/beacon')
          .set('content-type', 'text/plain')
          .send(JSON.stringify({ intervals: [] }))
      ).status,
    ).toBe(400);
    expect(await progressRow(s)).toBeUndefined();
  });
});
