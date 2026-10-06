import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitFor } from '@a5/testing';
import type { MalwareScanner, ScanVerdict } from '../src/scanning/malware-scanner.js';
import { generateJourneyChecklistPdf } from '../src/seed/sample-media.js';
import { EICAR, PNG, VTT, makeClip, outboxEvents, putUpload, uploadFile } from './fixtures.js';
import { ORG, createMediaHarness, type MediaHarness } from './harness.js';

/** Flags files containing the EICAR test signature, like clamd would. */
class FakeScanner implements MalwareScanner {
  readonly name = 'fake';
  scanned = 0;
  async scanFile(path: string): Promise<ScanVerdict> {
    this.scanned++;
    const content = await readFile(path, 'latin1');
    return content.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')
      ? { status: 'infected', engine: 'fake', signature: 'Eicar-Test-Signature' }
      : { status: 'clean', engine: 'fake' };
  }
  async ping(): Promise<void> {}
}

let h: MediaHarness;
const scanner = new FakeScanner();

beforeAll(async () => {
  h = await createMediaHarness('processing', { role: 'all', overrides: { scanner } });
});
afterAll(() => h?.close());

async function settled(id: string) {
  return waitFor(
    async () => {
      const row = await h.db
        .selectFrom('media_assets')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return ['ready', 'failed', 'rejected'].includes(row.status) ? row : null;
    },
    { timeoutMs: 90_000, intervalMs: 200, message: `asset ${id} to finish processing` },
  );
}

describe('media.process worker', () => {
  it('turns an uploaded clip into an HLS ladder capped at the source height, with a poster frame', async () => {
    const admin = await h.as('shelby');
    const clip = await makeClip(h, { seconds: 3, width: 1280, height: 720 });
    const { assetId, completed } = await uploadFile(
      h,
      admin,
      {
        kind: 'video',
        title: 'Anatomy of a Residential Roof',
        filename: 'anatomy.mp4',
        mimeType: 'video/mp4',
      },
      clip,
    );
    expect(completed.status).toBe(200);

    const row = await settled(assetId);
    expect(row.status).toBe('ready');
    expect(row).toMatchObject({
      width: 1280,
      height: 720,
      scan_status: 'clean',
      error: null,
      checksum: createHash('sha256').update(clip).digest('hex'),
    });
    expect(row.duration_seconds).toBeGreaterThan(2.5);
    expect(row.duration_seconds).toBeLessThan(3.5);
    expect(row.hls_master_key).toBe(`media/${ORG}/${assetId}/hls/master.m3u8`);
    expect(row.thumbnail_key).toBe(`media/${ORG}/${assetId}/thumb.jpg`);

    const renditions = await h.db
      .selectFrom('media_renditions')
      .selectAll()
      .where('asset_id', '=', assetId)
      .orderBy('height')
      .execute();
    expect(renditions.map((r) => [r.name, r.width, r.height])).toEqual([
      ['360p', 640, 360],
      ['720p', 1280, 720],
    ]);
    expect(renditions.every((r) => r.bandwidth > 0 && r.codecs?.startsWith('avc1'))).toBe(true);

    const thumb = await h.storage.getBytes(row.thumbnail_key!);
    expect(thumb.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    const hlsFiles = (
      await readdir(join(h.storageRoot, 'objects', 'media', ORG, assetId, 'hls'))
    ).filter((f) => !f.endsWith('.meta.json'));
    expect(hlsFiles).toEqual(
      expect.arrayContaining([
        'master.m3u8',
        '360p.m3u8',
        '720p.m3u8',
        '360p_00000.ts',
        '720p_00000.ts',
      ]),
    );
    expect(await h.storage.headObject(`media/${ORG}/${assetId}/hls/360p_00000.ts`)).toMatchObject({
      contentType: 'video/mp2t',
    });

    const ready = (await outboxEvents(h, 'media.asset.ready')).find(
      (e) => e.payload.assetId === assetId,
    )!;
    expect(ready.payload).toMatchObject({ kind: 'video', title: 'Anatomy of a Residential Roof' });
    expect(ready.organizationId).toBe(ORG);

    // Every job works in its own temporary directory, which is always removed.
    expect(await readdir(join(h.storageRoot, 'work'))).toEqual([]);

    const detail = await h.http.get(`/api/v1/media/${assetId}`).set(admin);
    expect(detail.body).toMatchObject({
      status: 'ready',
      renditions: [{ name: '360p' }, { name: '720p' }],
    });
    expect(detail.body.thumbnailUrl).toMatch(
      /^http:\/\/media\.test\/api\/v1\/media\/dev-storage\/object\?/,
    );
    const poster = await h.http.get(h.path(detail.body.thumbnailUrl));
    expect(poster.status).toBe(200);
    expect(poster.headers['content-type']).toBe('image/jpeg');
  });

  it('publishes documents and images without transcoding', async () => {
    const admin = await h.as('shelby');
    const pdf = await uploadFile(
      h,
      admin,
      {
        kind: 'document',
        title: 'Customer Journey Map',
        filename: 'journey.pdf',
        mimeType: 'application/pdf',
      },
      await generateJourneyChecklistPdf(),
    );
    const png = await uploadFile(
      h,
      admin,
      { kind: 'image', title: 'Ridge vent', filename: 'ridge.png', mimeType: 'image/png' },
      PNG,
    );
    const doc = await settled(pdf.assetId);
    const image = await settled(png.assetId);
    expect(doc).toMatchObject({
      status: 'ready',
      hls_master_key: null,
      thumbnail_key: null,
      duration_seconds: null,
    });
    expect(image).toMatchObject({
      status: 'ready',
      width: 1,
      height: 1,
      thumbnail_key: image.storage_key,
    });
  });

  it('rejects infected files and removes them', async () => {
    const admin = await h.as('shelby');
    const pdf = Buffer.concat([await generateJourneyChecklistPdf(), Buffer.from(`\n% ${EICAR}\n`)]);
    const { assetId } = await uploadFile(
      h,
      admin,
      {
        kind: 'document',
        title: 'Adjuster notes',
        filename: 'notes.pdf',
        mimeType: 'application/pdf',
      },
      pdf,
    );
    const row = await settled(assetId);
    expect(row).toMatchObject({ status: 'rejected', scan_status: 'infected' });
    expect(row.error).toBe(
      'The file failed the malware scan (Eicar-Test-Signature) and was removed.',
    );
    expect(await h.storage.headObject(row.storage_key)).toBeNull();
    const failed = (await outboxEvents(h, 'media.asset.failed')).find(
      (e) => e.payload.assetId === assetId,
    );
    expect(failed?.payload.error).toContain('malware scan');
  });

  it('fails unreadable video with a readable reason instead of retrying forever', async () => {
    const admin = await h.as('shelby');
    const clip = await makeClip(h, { seconds: 1, width: 320, height: 240 });
    // Keep the MP4 signature (ftyp box) but destroy everything after it.
    const broken = Buffer.concat([clip.subarray(0, 32), Buffer.alloc(8_192, 0x5a)]);
    const { assetId, completed } = await uploadFile(
      h,
      admin,
      { kind: 'video', title: 'Corrupted export', filename: 'export.mp4', mimeType: 'video/mp4' },
      broken,
    );
    expect(completed.status).toBe(200);
    const row = await settled(assetId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/could not be read as media/);
    expect(
      (await outboxEvents(h, 'media.asset.failed')).some((e) => e.payload.assetId === assetId),
    ).toBe(true);
  });

  it('processes WebVTT captions uploaded for a video', async () => {
    const admin = await h.as('shelby');
    const clip = await makeClip(h, { seconds: 2, width: 640, height: 360 });
    const video = await uploadFile(
      h,
      admin,
      {
        kind: 'video',
        title: 'The A5 Objection Framework',
        filename: 'framework.mp4',
        mimeType: 'video/mp4',
      },
      clip,
    );
    expect((await settled(video.assetId)).status).toBe('ready');

    const vtt = Buffer.from(VTT);
    const created = await h.http
      .post(`/api/v1/media/${video.assetId}/captions`)
      .set(admin)
      .send({
        language: 'en-US',
        label: 'English',
        isDefault: true,
        filename: 'framework.en.vtt',
        sizeBytes: vtt.length,
      });
    expect(created.status).toBe(201);
    expect(created.body.captionId).toBeTruthy();
    expect((await putUpload(h, created.body.upload, vtt)).status).toBe(204);
    expect(
      (
        await h.http
          .post(`/api/v1/media/uploads/${created.body.assetId}/complete`)
          .set(admin)
          .send()
      ).status,
    ).toBe(200);
    expect((await settled(created.body.assetId)).status).toBe('ready');

    const detail = await h.http.get(`/api/v1/media/${video.assetId}`).set(admin);
    expect(detail.body.captions).toEqual([
      expect.objectContaining({
        id: created.body.captionId,
        language: 'en-US',
        label: 'English',
        isDefault: true,
        status: 'ready',
        url: expect.stringContaining('/dev-storage/object?'),
      }),
    ]);
    const file = await h.http.get(h.path(detail.body.captions[0].url));
    expect(file.text).toBe(VTT);

    // Caption files are not listed in the library unless asked for.
    const listed = await h.http.get('/api/v1/media?pageSize=100').set(admin);
    expect(listed.body.items.map((i: { id: string }) => i.id)).not.toContain(created.body.assetId);
    const captions = await h.http.get('/api/v1/media?kind=caption').set(admin);
    expect(captions.body.items.map((i: { id: string }) => i.id)).toContain(created.body.assetId);
  });

  it('scanned every processed file', () => {
    expect(scanner.scanned).toBeGreaterThanOrEqual(6);
  });
});
