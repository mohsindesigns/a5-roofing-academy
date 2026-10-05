import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@a5/observability';
import { generateJourneyChecklistPdf } from '../src/seed/sample-media.js';
import { MEDIA_PROCESS_QUEUE } from '../src/processing/processing.queue.js';
import { PNG, outboxEvents, putUpload } from './fixtures.js';
import { ORG, createMediaHarness, type MediaHarness } from './harness.js';

let h: MediaHarness;

beforeAll(async () => {
  h = await createMediaHarness('uploads');
});
afterAll(() => h?.close());

const processJob = (id: string) => h.queues.queue(MEDIA_PROCESS_QUEUE).getJob(id);

describe('upload workflow', () => {
  it('uploads a document through the signed development PUT and queues processing', async () => {
    const admin = await h.as('shelby');
    const pdf = await generateJourneyChecklistPdf();
    const created = await h.http
      .post('/api/v1/media/uploads')
      .set(admin)
      .send({ kind: 'document', title: 'Customer Journey Map', filename: '../../etc/Journey Map.pdf', mimeType: 'application/pdf', sizeBytes: pdf.length });
    expect(created.status).toBe(201);
    expect(created.body.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'application/pdf' }, fields: {} });
    expect(created.body.upload.url).toMatch(/^http:\/\/media\.test\/api\/v1\/media\/dev-storage\/upload\?/);
    expect(created.body.maxBytes).toBe(50 * 1024 * 1024);
    const id = created.body.assetId as string;

    const row = await h.db.selectFrom('media_assets').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'awaiting_upload', storage_key: `media/${ORG}/${id}/source`, original_filename: 'Journey Map.pdf', kind: 'document' });

    // Completing before the file arrived changes nothing.
    const early = await h.http.post(`/api/v1/media/uploads/${id}/complete`).set(admin).send();
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('UPLOAD_NOT_FOUND');

    expect((await putUpload(h, created.body.upload, pdf)).status).toBe(204);
    const completed = await h.http.post(`/api/v1/media/uploads/${id}/complete`).set(admin).send();
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ id, status: 'uploaded', sizeBytes: pdf.length, scanStatus: 'pending', downloadUrl: null });

    const job = await processJob(id);
    expect(job?.data).toMatchObject({ assetId: id });

    // Idempotent completion: same state, still one job.
    const again = await h.http.post(`/api/v1/media/uploads/${id}/complete`).set(admin).send();
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('uploaded');
    expect(await h.queues.queue(MEDIA_PROCESS_QUEUE).getJobCountByTypes('waiting', 'delayed', 'active')).toBe(1);

    const audits = (await outboxEvents(h, 'audit.recorded')).map((e) => e.payload.action);
    expect(audits).toEqual(expect.arrayContaining(['media.upload_started', 'media.uploaded']));
  });

  it('rejects forged, tampered and expired upload signatures', async () => {
    const admin = await h.as('shelby');
    const created = await h.http
      .post('/api/v1/media/uploads')
      .set(admin)
      .send({ kind: 'image', title: 'Ridge vent close-up', filename: 'ridge.png', mimeType: 'image/png', sizeBytes: PNG.length });
    const url = new URL(created.body.upload.url);

    const raised = new URL(url);
    raised.searchParams.set('max', String(10 * 1024 ** 3));
    const forged = await h.http.put(h.path(raised.toString())).set('content-type', 'image/png').send(PNG);
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe('SIGNATURE_INVALID');

    const otherKey = new URL(url);
    otherKey.searchParams.set('key', `media/${ORG}/${uuidv7()}/source`);
    expect((await h.http.put(h.path(otherKey.toString())).set('content-type', 'image/png').send(PNG)).status).toBe(403);

    const tampered = new URL(url);
    tampered.searchParams.set('sig', `${url.searchParams.get('sig')!.slice(0, -2)}AA`);
    expect((await h.http.put(h.path(tampered.toString())).set('content-type', 'image/png').send(PNG)).status).toBe(403);

    const expired = await h.storage.createUploadTarget(url.searchParams.get('key')!, { contentType: 'image/png', maxBytes: 1024, expiresInSeconds: -5 });
    const late = await putUpload(h, expired, PNG);
    expect(late.status).toBe(403);
    expect(await h.storage.headObject(url.searchParams.get('key')!)).toBeNull();

    // The genuine URL still works.
    expect((await putUpload(h, created.body.upload, PNG)).status).toBe(204);
  });

  it('enforces the signed size limit and content type on the development PUT', async () => {
    const key = `media/${ORG}/${uuidv7()}/source`;
    const target = await h.storage.createUploadTarget(key, { contentType: 'image/png', maxBytes: 100, expiresInSeconds: 60 });

    const tooBig = await putUpload(h, target, Buffer.alloc(101, 1));
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe('FILE_TOO_LARGE');
    expect(await h.storage.headObject(key)).toBeNull();

    const wrongType = await putUpload(h, target, PNG, 'image/jpeg');
    expect(wrongType.status).toBe(415);

    // Without a Content-Length (chunked) the stream itself is capped.
    const server = h.app.getHttpServer() as http.Server;
    if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'PUT', path: h.path(target.url), headers: { 'content-type': 'image/png', 'transfer-encoding': 'chunked' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      for (let i = 0; i < 10; i++) req.write(Buffer.alloc(40, i));
      req.end();
    });
    expect(status).toBe(413);
    expect(await h.storage.headObject(key)).toBeNull();

    expect((await putUpload(h, target, PNG)).status).toBe(204);
    expect(await h.storage.headObject(key)).toMatchObject({ size: PNG.length, contentType: 'image/png' });
  });

  it('validates the requested type, extension and per-kind size limit', async () => {
    const admin = await h.as('shelby');
    const post = (body: Record<string, unknown>) => h.http.post('/api/v1/media/uploads').set(admin).send(body);

    const svg = await post({ kind: 'image', title: 'Logo', filename: 'logo.svg', mimeType: 'image/svg+xml', sizeBytes: 100 });
    expect(svg.status).toBe(400);
    expect(svg.body.error.fields[0]).toMatchObject({ path: 'mimeType' });

    const ext = await post({ kind: 'video', title: 'Clip', filename: 'clip.png', mimeType: 'video/mp4', sizeBytes: 100 });
    expect(ext.status).toBe(400);
    expect(ext.body.error.fields[0]).toMatchObject({ path: 'filename' });

    const big = await post({ kind: 'video', title: 'Clip', filename: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: 2049 * 1024 * 1024 });
    expect(big.status).toBe(400);
    expect(big.body.error.fields[0]).toEqual({ path: 'sizeBytes', message: 'Videos can be at most 2 GB.' });

    const doc = await post({ kind: 'document', title: 'Handbook', filename: 'handbook.pdf', mimeType: 'application/pdf', sizeBytes: 51 * 1024 * 1024 });
    expect(doc.body.error.fields[0].message).toBe('Documents can be at most 50 MB.');

    const caption = await post({ kind: 'caption', title: 'Captions', filename: 'en.vtt', mimeType: 'text/vtt', sizeBytes: 100 });
    expect(caption.status).toBe(400);
  });

  it('rejects a PNG renamed to .mp4 by its magic bytes', async () => {
    const admin = await h.as('shelby');
    const created = await h.http
      .post('/api/v1/media/uploads')
      .set(admin)
      .send({ kind: 'video', title: 'Storm damage walkthrough', filename: 'walkthrough.mp4', mimeType: 'video/mp4', sizeBytes: PNG.length });
    expect((await putUpload(h, created.body.upload, PNG)).status).toBe(204);
    const id = created.body.assetId as string;

    const completed = await h.http.post(`/api/v1/media/uploads/${id}/complete`).set(admin).send();
    expect(completed.status).toBe(422);
    expect(completed.body.error).toMatchObject({ code: 'UPLOAD_REJECTED', message: 'File content (image/png) does not match its declared type (video/mp4).' });

    const row = await h.db.selectFrom('media_assets').select(['status', 'error', 'storage_key']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('rejected');
    expect(row.error).toContain('does not match');
    expect(await h.storage.headObject(row.storage_key)).toBeNull();
    expect(await processJob(id)).toBeUndefined();
    expect((await outboxEvents(h, 'media.asset.failed')).map((e) => e.payload.assetId)).toContain(id);

    const retry = await h.http.post(`/api/v1/media/uploads/${id}/complete`).set(admin).send();
    expect(retry.status).toBe(422);
    expect(retry.body.error.code).toBe('UPLOAD_REJECTED');
  });

  it('rejects an upload whose size differs from the declared file', async () => {
    const admin = await h.as('shelby');
    const created = await h.http
      .post('/api/v1/media/uploads')
      .set(admin)
      .send({ kind: 'image', title: 'Shingle sample', filename: 'shingle.png', mimeType: 'image/png', sizeBytes: 5_000 });
    await putUpload(h, created.body.upload, PNG);
    const completed = await h.http.post(`/api/v1/media/uploads/${created.body.assetId}/complete`).set(admin).send();
    expect(completed.status).toBe(422);
    expect(completed.body.error.message).toMatch(/does not match the selected file/);
  });

  it('serves signed development objects with HTTP Range support', async () => {
    const key = `media/${ORG}/${uuidv7()}/source`;
    const bytes = Buffer.from('0123456789abcdefghij');
    await h.storage.putObject(key, bytes, { contentType: 'video/mp4' });
    const url = h.path(await h.storage.signedGetUrl(key, { expiresInSeconds: 60 }));

    const full = await h.http.get(url).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect((full.body as Buffer).toString()).toBe(bytes.toString());

    const part = await h.http.get(url).set('range', 'bytes=2-5');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 2-5/20');
    expect(part.headers['content-length']).toBe('4');

    const suffix = await h.http.get(url).set('range', 'bytes=-3');
    expect(suffix.headers['content-range']).toBe('bytes 17-19/20');

    expect((await h.http.get(url).set('range', 'bytes=40-50')).status).toBe(416);
    expect((await h.http.get(url.replace(/sig=[^&]+/, 'sig=forged'))).status).toBe(403);

    const download = h.path(await h.storage.signedGetUrl(key, { expiresInSeconds: 60, downloadName: 'Hail "damage".mp4' }));
    const dl = await h.http.get(download);
    expect(dl.headers['content-disposition']).toBe('attachment; filename="Hail damage.mp4"');
  });
});

describe('permissions', () => {
  it('representatives cannot upload or browse the media library', async () => {
    const rep = await h.as('marcus');
    const upload = await h.http
      .post('/api/v1/media/uploads')
      .set(rep)
      .send({ kind: 'image', title: 'x', filename: 'x.png', mimeType: 'image/png', sizeBytes: 10 });
    expect(upload.status).toBe(403);
    expect((await h.http.get('/api/v1/media').set(rep)).status).toBe(403);
    expect((await h.http.post(`/api/v1/media/uploads/${uuidv7()}/complete`).set(rep).send()).status).toBe(403);
  });

  it('managers cannot upload and nobody can act without a principal', async () => {
    const manager = await h.as('danielle');
    expect(
      (await h.http.post('/api/v1/media/uploads').set(manager).send({ kind: 'image', title: 'x', filename: 'x.png', mimeType: 'image/png', sizeBytes: 10 })).status,
    ).toBe(403);
    expect((await h.http.get('/api/v1/media')).status).toBe(401);
  });

  it('hides uploads of another organization', async () => {
    const admin = await h.as('shelby');
    const created = await h.http
      .post('/api/v1/media/uploads')
      .set(admin)
      .send({ kind: 'image', title: 'Gutter guard', filename: 'gutter.png', mimeType: 'image/png', sizeBytes: PNG.length });
    const outsider = await h.outsider();
    expect((await h.http.post(`/api/v1/media/uploads/${created.body.assetId}/complete`).set(outsider).send()).status).toBe(404);
    expect((await h.http.get(`/api/v1/media/${created.body.assetId}`).set(outsider)).status).toBe(404);
  });
});

describe('S3 driver', () => {
  it('does not expose the development storage routes and hands out presigned POST uploads', async () => {
    const s3 = await createMediaHarness('s3', {
      env: {
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'a5-academy-test',
        S3_REGION: 'us-east-1',
        S3_ENDPOINT: 'http://127.0.0.1:9',
        S3_PUBLIC_ENDPOINT: 'https://media.a5roofing.example',
        S3_ACCESS_KEY_ID: 'test-access-key',
        S3_SECRET_ACCESS_KEY: 'test-secret-key',
      },
    });
    try {
      expect((await s3.http.put('/api/v1/media/dev-storage/upload?key=a&expires=1&max=1&type=image/png&sig=x').set('content-type', 'image/png').send(PNG)).status).toBe(404);
      expect((await s3.http.get('/api/v1/media/dev-storage/object?key=a&expires=1&sig=x')).status).toBe(404);
      const created = await s3.http
        .post('/api/v1/media/uploads')
        .set(await s3.as('shelby'))
        .send({ kind: 'image', title: 'Ridge cap', filename: 'ridge.png', mimeType: 'image/png', sizeBytes: PNG.length });
      expect(created.status).toBe(201);
      expect(created.body.upload.method).toBe('POST');
      expect(created.body.upload.url).toMatch(/^https:\/\/media\.a5roofing\.example\/a5-academy-test/);
      expect(created.body.upload.fields).toMatchObject({ key: `media/${ORG}/${created.body.assetId}/source`, 'Content-Type': 'image/png' });
    } finally {
      await s3.close();
    }
  });
});
