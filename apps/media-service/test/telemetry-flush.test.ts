import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PEOPLE } from '@a5/seed-data';
import { waitFor } from '@a5/testing';
import { ProgressStore } from '../src/telemetry/progress-store.js';
import type { WatchState } from '../src/telemetry/watch-buffer.js';
import { insertReadyVideo, outboxEvents } from './fixtures.js';
import { LESSON_ID, ORG, createMediaHarness, type MediaHarness } from './harness.js';

let h: MediaHarness;

beforeAll(async () => {
  // Worker role with the shortest allowed flush interval, so the real BullMQ schedule runs.
  h = await createMediaHarness('flush', {
    role: 'all',
    env: { MEDIA_PROGRESS_FLUSH_INTERVAL_SECONDS: '5' },
  });
});
afterAll(() => h?.close());

describe('write-behind schedule', () => {
  it('persists buffered progress from the scheduled flush job without any further request', async () => {
    const assetId = await insertReadyVideo(h, { durationSeconds: 1000 });
    const headers = await h.as('marcus');
    const grant = await h.grant({
      userId: PEOPLE.marcus.id,
      resource: { type: 'media', id: assetId },
    });
    const { playbackToken } = (
      await h.http.post('/api/v1/media/playback').set(headers).send({ grant })
    ).body;
    const beat = (start: number, end: number) =>
      h.http
        .post('/api/v1/media/playback/heartbeat')
        .set(headers)
        .send({ playbackToken, intervals: [{ start, end, rate: 1 }], positionSeconds: end });
    const row = () =>
      h.db
        .selectFrom('video_progress')
        .select(['watched_seconds', 'last_position_seconds'])
        .where('asset_id', '=', assetId)
        .executeTakeFirst();

    h.clock.advance(15_000);
    expect((await beat(0, 15)).status).toBe(200);
    expect(await row()).toMatchObject({ watched_seconds: 15 });
    h.clock.advance(15_000);
    expect((await beat(15, 30)).status).toBe(200);
    // 3 % is below the next milestone: only Redis knows about it until the job runs.
    expect(await row()).toMatchObject({ watched_seconds: 15 });

    await waitFor(async () => ((await row())?.watched_seconds === 30 ? true : null), {
      timeoutMs: 20_000,
      intervalMs: 250,
      message: 'the scheduled flush to persist progress',
    });
    expect(await row()).toMatchObject({ watched_seconds: 30, last_position_seconds: 30 });
  });
});

describe('cross-instance exactly-once', () => {
  it('announces each event once when several instances persist the same progress concurrently', async () => {
    const assetId = await insertReadyVideo(h, { durationSeconds: 200 });
    const userId = PEOPLE.tyler.id;
    const state: WatchState = {
      userId,
      assetId,
      organizationId: ORG,
      contextType: 'lesson',
      contextId: LESSON_ID,
      durationSeconds: 200,
      completionPercent: 98,
      intervals: [[0, 200]],
      watchedSeconds: 200,
      lastPositionSeconds: 200,
      lastReportAt: Date.now(),
      startedAt: Date.now(),
      completedAt: null,
      milestones: [],
      persisted: false,
    };
    const store = h.app.get(ProgressStore);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => store.persist({ ...state })),
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill('fulfilled'));

    const mine = async (type: string) =>
      (await outboxEvents(h, type)).filter(
        (e) => e.payload.assetId === assetId && e.payload.userId === userId,
      );
    expect(await mine('video.started')).toHaveLength(1);
    expect(await mine('video.progressed')).toHaveLength(1);
    expect(await mine('video.completed')).toHaveLength(1);
    const rows = await h.db
      .selectFrom('video_progress')
      .selectAll()
      .where('asset_id', '=', assetId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ percent: 100, watched_seconds: 200 });
    expect(rows[0]!.milestones_emitted).toHaveLength(20);
  });
});
