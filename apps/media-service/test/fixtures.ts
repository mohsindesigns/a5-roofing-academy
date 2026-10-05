import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { media } from '@a5/contracts';
import { uuidv7 } from '@a5/observability';
import { MediaProcessor } from '../src/processing/media-processor.js';
import { generateClip } from '../src/seed/sample-media.js';
import { mediaKeys } from '../src/storage/keys.js';
import { ORG, type MediaHarness } from './harness.js';

/** 1×1 PNG. */
export const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2b3f3ab0000000049454e44ae426082',
  'hex',
);

/** The standard EICAR anti-virus test string (harmless). */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export const VTT = 'WEBVTT\n\n1\n00:00.000 --> 00:01.500\nWelcome to A5 Roofing.\n';

/** A real H.264/AAC MP4 test-pattern clip. */
export async function makeClip(h: MediaHarness, { seconds = 2, width = 1280, height = 720 } = {}): Promise<Buffer> {
  const dir = await mkdtemp(join(h.storageRoot, 'clip-'));
  const out = join(dir, 'clip.mp4');
  await generateClip({ outPath: out, workDir: dir, durationSeconds: seconds, width, height });
  return readFile(out);
}

/** PUT the bytes to the signed development upload URL. */
export function putUpload(h: MediaHarness, target: media.UploadTarget, body: Buffer, contentType = target.headers['content-type']!) {
  return h.http.put(h.path(target.url)).set('content-type', contentType).send(body);
}

/** Register, upload and complete a file; returns the completion response. */
export async function uploadFile(
  h: MediaHarness,
  headers: Record<string, string>,
  request: Record<string, unknown> & { mimeType: string },
  body: Buffer,
) {
  const created = await h.http.post('/api/v1/media/uploads').set(headers).send({ sizeBytes: body.length, ...request });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const put = await putUpload(h, created.body.upload, body);
  expect(put.status, JSON.stringify(put.body)).toBe(204);
  const completed = await h.http.post(`/api/v1/media/uploads/${created.body.assetId}/complete`).set(headers).send();
  return { assetId: created.body.assetId as string, created, completed };
}

/** Upload a clip and run the real processor synchronously (API-only harnesses have no worker). */
export async function processedVideo(h: MediaHarness, headers: Record<string, string>, title = 'Identifying Hail and Wind Damage'): Promise<string> {
  const clip = await makeClip(h, { seconds: 3 });
  const { assetId, completed } = await uploadFile(h, headers, { kind: 'video', title, filename: 'hail-damage.mp4', mimeType: 'video/mp4' }, clip);
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  expect(await h.app.get(MediaProcessor).process(assetId)).toBe('ready');
  return assetId;
}

/** A ready video row without media files (enough for telemetry and playback-authorization tests). */
export async function insertReadyVideo(h: MediaHarness, { durationSeconds = 100, title = 'How a Homeowner Claim Works', organizationId = ORG } = {}): Promise<string> {
  const id = uuidv7();
  await h.db
    .insertInto('media_assets')
    .values({
      id,
      organization_id: organizationId,
      kind: 'video',
      title,
      description: null,
      original_filename: 'claims.mp4',
      storage_key: mediaKeys.source(organizationId, id),
      mime_type: 'video/mp4',
      size_bytes: 1_000_000,
      checksum: null,
      status: 'ready',
      duration_seconds: durationSeconds,
      width: 1280,
      height: 720,
      hls_master_key: mediaKeys.hls(organizationId, id, 'master.m3u8'),
      thumbnail_key: mediaKeys.thumbnail(organizationId, id),
      error: null,
      parent_asset_id: null,
      uploaded_at: new Date(),
      ready_at: new Date(),
      archived_at: null,
      created_by: '0190a3b2-0000-7000-8000-000000000001',
      updated_by: null,
    })
    .execute();
  return id;
}

export async function outboxEvents(h: MediaHarness, type?: string) {
  let q = h.db.selectFrom('outbox_events').select(['type', 'envelope']).orderBy('created_at').orderBy('id');
  if (type) q = q.where('type', '=', type);
  return (await q.execute()).map((r) => ({ type: r.type, ...(r.envelope as { payload: Record<string, unknown>; organizationId: string | null }) }));
}
