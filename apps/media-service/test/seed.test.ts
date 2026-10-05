import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@a5/database';
import { testLogger } from '@a5/nest-kit/testing';
import { JOURNEYS, ORGANIZATION, PEOPLE, allLessons, completedLessonKeys, seedId } from '@a5/seed-data';
import { LocalDiskStorage } from '@a5/storage';
import { createTestDatabase, type TestDatabase } from '@a5/testing';
import { migrations } from '../src/database/migrations/index.js';
import type { MediaDatabase } from '../src/database/schema.js';
import { seedMedia } from '../src/seed/seed-media.js';

let tdb: TestDatabase;
let database: Database<MediaDatabase>;
let root: string;
let storage: LocalDiskStorage;

const LESSONS = ['w1-welcome', 'w1-journey-map'];
const lines: string[] = [];
const options = () => ({ lessonKeys: LESSONS, workDir: root, logger: testLogger(), log: (l: string) => void lines.push(l) });

beforeAll(async () => {
  tdb = await createTestDatabase('media_seed');
  database = createDatabase<MediaDatabase>({ url: tdb.url, poolMax: 3 });
  await migrateToLatest(database.db as never, migrations);
  root = await mkdtemp(join(tmpdir(), 'a5-media-seed-test-'));
  storage = new LocalDiskStorage({ root: join(root, 'objects'), publicBaseUrl: 'http://media.test', signingSecret: 's'.repeat(32) });
});
afterAll(async () => {
  await database.destroy();
  await tdb.drop();
  await rm(root, { recursive: true, force: true });
});

const db = () => database.db;

describe('media seed', () => {
  it('creates ready video and document assets with the catalogue ids', async () => {
    const result = await seedMedia(db(), storage, options());
    expect(result).toMatchObject({ videos: 1, documents: 1, videosSkipped: false });

    const video = await db().selectFrom('media_assets').selectAll().where('id', '=', seedId('media:w1-welcome')).executeTakeFirstOrThrow();
    expect(video).toMatchObject({
      kind: 'video',
      title: 'Welcome from Leadership',
      status: 'ready',
      organization_id: ORGANIZATION.id,
      width: 1280,
      height: 720,
      mime_type: 'video/mp4',
      storage_key: `media/${ORGANIZATION.id}/${seedId('media:w1-welcome')}/source`,
    });
    expect(video.duration_seconds).toBeGreaterThanOrEqual(15);
    expect(video.duration_seconds).toBeLessThanOrEqual(25);
    expect((await db().selectFrom('media_renditions').select('name').where('asset_id', '=', video.id).orderBy('height').execute()).map((r) => r.name)).toEqual(['360p', '720p']);
    expect(await storage.headObject(video.hls_master_key!)).toMatchObject({ contentType: 'application/vnd.apple.mpegurl' });
    expect(await storage.headObject(video.thumbnail_key!)).not.toBeNull();

    const chapters = await db().selectFrom('media_chapters').select(['title', 'start_seconds', 'position']).where('asset_id', '=', video.id).orderBy('position').execute();
    expect(chapters.map((c) => c.title)).toEqual(['A message from leadership', 'What makes A5 different', 'Your first four weeks']);
    expect(chapters[0]!.start_seconds).toBe(0);
    expect(chapters.every((c, i) => i === 0 || c.start_seconds > chapters[i - 1]!.start_seconds)).toBe(true);

    const captions = await db().selectFrom('media_captions').selectAll().where('asset_id', '=', video.id).execute();
    expect(captions).toMatchObject([{ language: 'en', label: 'English', is_default: true }]);
    const vtt = (await storage.getBytes(captions[0]!.storage_key)).toString();
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('Welcome from Leadership');
    expect((await db().selectFrom('media_transcripts').select('segments').where('asset_id', '=', video.id).executeTakeFirstOrThrow()).segments.length).toBeGreaterThan(1);

    const doc = await db().selectFrom('media_assets').selectAll().where('id', '=', seedId('media:w1-journey-map')).executeTakeFirstOrThrow();
    expect(doc).toMatchObject({ kind: 'document', status: 'ready', mime_type: 'application/pdf', title: 'Customer Journey Map' });
    expect((await storage.getBytes(doc.storage_key, { start: 0, end: 4 })).toString()).toBe('%PDF-');
  });

  it('gives learners with a finished lesson matching watch progress', async () => {
    const expected = JOURNEYS.filter((j) => completedLessonKeys(j.stage).includes('w1-welcome')).map((j) => PEOPLE[j.person].id).sort();
    expect(expected.length).toBeGreaterThan(5);
    const rows = await db().selectFrom('video_progress').selectAll().where('asset_id', '=', seedId('media:w1-welcome')).execute();
    expect(rows.map((r) => r.user_id).sort()).toEqual(expected);
    const lesson = allLessons().find((l) => l.key === 'w1-welcome')!;
    for (const r of rows) {
      expect(r).toMatchObject({ context_type: 'lesson', context_id: lesson.id, percent: 100, intervals: [[0, r.duration_seconds]] });
      expect(r.completed_at).not.toBeNull();
      expect(r.milestones_emitted).toHaveLength(20);
    }
  });

  it('is idempotent', async () => {
    const counts = async () => ({
      assets: Number((await db().selectFrom('media_assets').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
      chapters: Number((await db().selectFrom('media_chapters').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
      progress: Number((await db().selectFrom('video_progress').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
      events: Number((await db().selectFrom('outbox_events').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
    });
    const before = await counts();
    const again = await seedMedia(db(), storage, options());
    expect(again.progressRows).toBe(0);
    expect(await counts()).toEqual(before);
    expect(before.assets).toBe(3); // video + captions + document
  });

  it('finishes assets left half-processed by an interrupted run', async () => {
    const id = seedId('media:w1-welcome');
    await db().deleteFrom('media_renditions').where('asset_id', '=', id).execute();
    await db().updateTable('media_assets').set({ status: 'processing', ready_at: null, hls_master_key: null }).where('id', '=', id).execute();
    await seedMedia(db(), storage, options());
    const row = await db().selectFrom('media_assets').select(['status', 'hls_master_key']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('ready');
    expect(row.hls_master_key).not.toBeNull();
    expect(await db().selectFrom('media_renditions').select('id').where('asset_id', '=', id).execute()).toHaveLength(2);
    expect(await db().selectFrom('media_captions').select('id').where('asset_id', '=', id).execute()).toHaveLength(1);
  });

  it('skips videos with a clear message when ffmpeg is unavailable but still seeds documents', async () => {
    const other = await createTestDatabase('media_seed_noffmpeg');
    const second = createDatabase<MediaDatabase>({ url: other.url, poolMax: 2 });
    try {
      await migrateToLatest(second.db as never, migrations);
      lines.length = 0;
      const result = await seedMedia(second.db, storage, { ...options(), ffmpegPath: '/nonexistent/ffmpeg' });
      expect(result).toMatchObject({ videos: 0, documents: 1, videosSkipped: true, progressRows: 0 });
      expect(lines.some((l) => l.includes('ffmpeg not found at "/nonexistent/ffmpeg"') && l.includes('skipping 1 video lessons'))).toBe(true);
      expect((await second.db.selectFrom('media_assets').select('kind').execute()).map((r) => r.kind)).toEqual(['document']);
    } finally {
      await second.destroy();
      await other.drop();
    }
  });
});
