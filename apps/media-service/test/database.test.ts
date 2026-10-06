import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateDown, migrateToLatest, sql, type Database } from '@a5/database';
import { uuidv7 } from '@a5/observability';
import { createTestDatabase, type TestDatabase } from '@a5/testing';
import { migrations } from '../src/database/migrations/index.js';
import type { MediaDatabase } from '../src/database/schema.js';

let tdb: TestDatabase;
let database: Database<MediaDatabase>;

const TABLES = [
  'media_assets',
  'media_renditions',
  'media_captions',
  'media_chapters',
  'media_transcripts',
  'video_progress',
  'outbox_events',
];

beforeAll(async () => {
  tdb = await createTestDatabase('media_db');
  database = createDatabase<MediaDatabase>({ url: tdb.url, poolMax: 3 });
});
afterAll(async () => {
  await database.destroy();
  await tdb.drop();
});

async function existingTables(): Promise<string[]> {
  const rows = await sql<{
    table_name: string;
  }>`select table_name from information_schema.tables where table_schema = 'public' and table_name = any(${sql.val(TABLES)}::text[])`.execute(
    database.db,
  );
  return rows.rows.map((r) => r.table_name).sort();
}

describe('migrations', () => {
  it('apply, reverse completely and apply again', async () => {
    expect(await migrateToLatest(database.db as never, migrations)).toEqual(['Up 0001_media']);
    expect(await existingTables()).toEqual([...TABLES].sort());
    expect(await migrateDown(database.db as never, migrations)).toEqual(['Down 0001_media']);
    expect(await existingTables()).toEqual([]);
    const fn = await sql<{
      n: number;
    }>`select count(*)::int as n from pg_proc where proname = 'set_updated_at'`.execute(
      database.db,
    );
    expect(fn.rows[0]!.n).toBe(0);
    expect(await migrateToLatest(database.db as never, migrations)).toEqual(['Up 0001_media']);
    expect(await existingTables()).toEqual([...TABLES].sort());
  });
});

function asset(overrides: Record<string, unknown> = {}) {
  const id = uuidv7();
  return {
    id,
    organization_id: uuidv7(),
    kind: 'video' as const,
    title: 'Welcome from Leadership',
    description: null,
    original_filename: 'welcome.mp4',
    storage_key: `media/o/${id}/source`,
    mime_type: 'video/mp4',
    size_bytes: 1000,
    checksum: null,
    status: 'awaiting_upload' as const,
    duration_seconds: null,
    width: null,
    height: null,
    hls_master_key: null,
    thumbnail_key: null,
    error: null,
    parent_asset_id: null,
    uploaded_at: null,
    ready_at: null,
    archived_at: null,
    created_by: uuidv7(),
    updated_by: null,
    ...overrides,
  };
}

describe('invariants', () => {
  const db = () => database.db;

  it('rejects unknown kinds and statuses, empty files and inconsistent archive state', async () => {
    await expect(
      db()
        .insertInto('media_assets')
        .values(asset({ kind: 'audio' }) as never)
        .execute(),
    ).rejects.toThrow(/media_assets_kind_check/);
    await expect(
      db()
        .insertInto('media_assets')
        .values(asset({ status: 'deleted' }) as never)
        .execute(),
    ).rejects.toThrow(/media_assets_status_check/);
    await expect(
      db()
        .insertInto('media_assets')
        .values(asset({ size_bytes: 0 }))
        .execute(),
    ).rejects.toThrow(/size_bytes/);
    await expect(
      db()
        .insertInto('media_assets')
        .values(asset({ status: 'archived' }))
        .execute(),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db()
        .insertInto('media_assets')
        .values(asset({ kind: 'caption' }))
        .execute(),
    ).rejects.toThrow(/check constraint/);
  });

  it('ties caption files to a video and allows only one default track per video', async () => {
    const video = asset();
    await db().insertInto('media_assets').values(video).execute();
    const captionFiles = [
      asset({ kind: 'caption', mime_type: 'text/vtt', parent_asset_id: video.id }),
      asset({ kind: 'caption', mime_type: 'text/vtt', parent_asset_id: video.id }),
    ];
    await db().insertInto('media_assets').values(captionFiles).execute();
    const link = (i: number, label: string, isDefault: boolean) => ({
      id: uuidv7(),
      asset_id: video.id,
      caption_asset_id: captionFiles[i]!.id,
      language: 'en',
      label,
      storage_key: captionFiles[i]!.storage_key,
      is_default: isDefault,
      created_by: uuidv7(),
    });
    await db()
      .insertInto('media_captions')
      .values(link(0, 'English', true))
      .execute();
    await expect(
      db()
        .insertInto('media_captions')
        .values(link(1, 'Spanish', true))
        .execute(),
    ).rejects.toThrow(/media_captions_default_uq/);
    await expect(
      db()
        .insertInto('media_captions')
        .values(link(1, 'ENGLISH', false))
        .execute(),
    ).rejects.toThrow(/media_captions_label_uq/);
    await db()
      .insertInto('media_captions')
      .values(link(1, 'English (alt)', false))
      .execute();
  });

  it('keeps one progress row per learner, asset and context', async () => {
    const video = asset();
    await db().insertInto('media_assets').values(video).execute();
    const row = () => ({
      id: uuidv7(),
      organization_id: video.organization_id,
      user_id: '0190a3b2-0000-7000-8000-00000000aaaa',
      asset_id: video.id,
      context_type: 'lesson',
      context_id: '0190a3b2-0000-7000-8000-00000000bbbb',
      watched_seconds: 5,
      duration_seconds: 100,
      percent: 5,
      last_position_seconds: 5,
      intervals: JSON.stringify([[0, 5]]) as never,
      started_at: new Date(),
      completed_at: null,
      milestones_emitted: [5],
    });
    await db().insertInto('video_progress').values(row()).execute();
    await expect(db().insertInto('video_progress').values(row()).execute()).rejects.toThrow(
      /video_progress_user_id_asset_id_context_type_context_id_key/,
    );
    await expect(
      db()
        .insertInto('video_progress')
        .values({ ...row(), context_id: uuidv7(), percent: 101 })
        .execute(),
    ).rejects.toThrow(/check constraint/);
  });

  it('removes renditions and chapters with their asset and keeps chapter start times unique', async () => {
    const video = asset();
    await db().insertInto('media_assets').values(video).execute();
    await db()
      .insertInto('media_renditions')
      .values({
        id: uuidv7(),
        asset_id: video.id,
        name: '720p',
        width: 1280,
        height: 720,
        bandwidth: 1,
        codecs: null,
        playlist_key: 'k',
      })
      .execute();
    await db()
      .insertInto('media_chapters')
      .values({
        id: uuidv7(),
        asset_id: video.id,
        start_seconds: 0,
        title: 'Intro',
        position: 1,
        created_by: null,
        updated_by: null,
      })
      .execute();
    await expect(
      db()
        .insertInto('media_chapters')
        .values({
          id: uuidv7(),
          asset_id: video.id,
          start_seconds: 0,
          title: 'Again',
          position: 2,
          created_by: null,
          updated_by: null,
        })
        .execute(),
    ).rejects.toThrow(/media_chapters_asset_id_start_seconds_key/);
    await db().deleteFrom('media_assets').where('id', '=', video.id).execute();
    for (const t of ['media_renditions', 'media_chapters'] as const) {
      expect(
        await db().selectFrom(t).select('id').where('asset_id', '=', video.id).execute(),
      ).toEqual([]);
    }
  });
});
