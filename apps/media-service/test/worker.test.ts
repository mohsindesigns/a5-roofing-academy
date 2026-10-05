import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@a5/observability';
import { waitFor } from '@a5/testing';
import { MEDIA_PROCESS_QUEUE, ProcessingWorker } from '../src/processing/processing.queue.js';
import type { MediaProbe, Transcoder } from '../src/processing/transcoder.js';
import { PNG, outboxEvents, uploadFile } from './fixtures.js';
import { ORG, createMediaHarness, type MediaHarness } from './harness.js';

/** Fails the first `failures` probes with a transient error, then behaves. */
class FlakyTranscoder implements Transcoder {
  calls = 0;
  constructor(public failures: number) {}
  async probe(): Promise<MediaProbe> {
    this.calls++;
    if (this.calls <= this.failures) throw new Error('scratch disk is full');
    return { formatName: 'png_pipe', durationSeconds: null, video: { width: 1, height: 1, codec: 'png' }, audio: null };
  }
  async transcodeToHls(): Promise<never> {
    throw new Error('not used');
  }
  async thumbnail(): Promise<void> {}
}

const transcoder = new FlakyTranscoder(0);
let h: MediaHarness;

beforeAll(async () => {
  h = await createMediaHarness('worker', { role: 'all', overrides: { transcoder } });
});
afterAll(() => h?.close());

/**
 * Register an image whose file is already in storage and queue processing by hand, so the test
 * controls attempts and backoff (the automatic job uses 4 attempts with a 15 s backoff).
 */
async function stage(title: string, attempts: number): Promise<string> {
  const admin = await h.as('shelby');
  const created = await h.http.post('/api/v1/media/uploads').set(admin).send({ kind: 'image', title, filename: 'sample.png', mimeType: 'image/png', sizeBytes: PNG.length });
  const id = created.body.assetId as string;
  await h.storage.putObject(`media/${ORG}/${id}/source`, PNG, { contentType: 'image/png' });
  await h.db.updateTable('media_assets').set({ status: 'uploaded' }).where('id', '=', id).execute();
  await h.queues.add(MEDIA_PROCESS_QUEUE, 'process', { assetId: id }, { jobId: id, attempts, backoff: { type: 'fixed', delay: 100 } });
  return id;
}

const statusOf = async (id: string) => (await h.db.selectFrom('media_assets').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;

describe('retries and dead letters', () => {
  it('retries transient failures and finishes the asset', async () => {
    transcoder.calls = 0;
    transcoder.failures = 1;
    const id = await stage('Retried image', 3);
    await waitFor(async () => (await statusOf(id)) === 'ready', { timeoutMs: 30_000, intervalMs: 100, message: 'retried processing to succeed' });
    expect(transcoder.calls).toBe(2);
    expect((await outboxEvents(h, 'media.asset.failed')).some((e) => e.payload.assetId === id)).toBe(false);
  });

  it('marks the asset failed and copies the job to the dead-letter queue after the last attempt', async () => {
    transcoder.calls = 0;
    transcoder.failures = 100;
    const id = await stage('Doomed image', 2);
    const row = await waitFor(
      async () => {
        const r = await h.db.selectFrom('media_assets').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
        return r.status === 'failed' ? r : null;
      },
      { timeoutMs: 30_000, intervalMs: 100, message: 'asset to be marked failed' },
    );
    expect(row.error).toBe('Processing failed after several attempts (scratch disk is full). Upload the file again or contact support.');
    expect(transcoder.calls).toBe(2);
    expect((await outboxEvents(h, 'media.asset.failed')).filter((e) => e.payload.assetId === id)).toHaveLength(1);

    const dlq = await waitFor(
      async () => (await h.queues.queue(`${MEDIA_PROCESS_QUEUE}.dlq`).getJobs(['waiting', 'delayed', 'active', 'completed'])).filter((j) => (j.data as { jobId?: string }).jobId === id),
      { timeoutMs: 20_000, message: 'dead-letter entry' },
    );
    expect(dlq[0]!.data).toMatchObject({ queue: MEDIA_PROCESS_QUEUE, error: 'scratch disk is full', data: { assetId: id } });
  });
});

describe('stranded uploads', () => {
  it('re-enqueues verified uploads that never reached the queue', async () => {
    const id = uuidv7();
    const old = new Date(Date.now() - 10 * 60_000);
    await h.db
      .insertInto('media_assets')
      .values({
        id,
        organization_id: ORG,
        kind: 'image',
        title: 'Stranded image',
        description: null,
        original_filename: 'stranded.png',
        storage_key: `media/${ORG}/${id}/source`,
        mime_type: 'image/png',
        size_bytes: PNG.length,
        checksum: null,
        status: 'uploaded',
        duration_seconds: null,
        width: null,
        height: null,
        hls_master_key: null,
        thumbnail_key: null,
        error: null,
        parent_asset_id: null,
        uploaded_at: old,
        ready_at: null,
        archived_at: null,
        created_by: '0190a3b2-0000-7000-8000-000000000001',
        updated_by: null,
        created_at: old,
        updated_at: old,
      })
      .execute();
    await h.storage.putObject(`media/${ORG}/${id}/source`, PNG, { contentType: 'image/png' });
    const fresh = uuidv7();
    await h.db
      .insertInto('media_assets')
      .values({ ...(await h.db.selectFrom('media_assets').selectAll().where('id', '=', id).executeTakeFirstOrThrow()), id: fresh, storage_key: `media/${ORG}/${fresh}/source`, created_at: new Date(), updated_at: new Date() })
      .execute();

    transcoder.failures = 0;
    expect(await h.app.get(ProcessingWorker).requeueStranded()).toBe(1);
    await waitFor(async () => (await h.db.selectFrom('media_assets').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status === 'ready', {
      timeoutMs: 30_000,
      intervalMs: 200,
      message: 'stranded upload to be processed',
    });
    // The recent upload was left alone (it may still be queued normally).
    expect((await h.db.selectFrom('media_assets').select('status').where('id', '=', fresh).executeTakeFirstOrThrow()).status).toBe('uploaded');
  });
});
