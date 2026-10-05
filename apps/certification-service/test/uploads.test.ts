import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIGNATORIES, STAMPS } from '@a5/seed-data';
import { createCertHarness, solidJpeg, solidPng, type CertHarness } from './harness.js';

let h: CertHarness;
let admin: Record<string, string>;
const signatureUrl = `/api/v1/certification-assets/signatories/${SIGNATORIES[1].id}/signature`;
const stampUrl = `/api/v1/certification-assets/stamps/${STAMPS[0].id}/image`;
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><script>alert(1)</script><rect width="600" height="200"/></svg>');

beforeAll(async () => {
  h = await createCertHarness('uploads');
  admin = await h.as('priya');
});
afterAll(() => h?.close());

const assetCount = async () => Number((await h.db.selectFrom('certification_assets').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
const upload = (url: string, body: Buffer, contentType: string, headers = admin, field = 'file') =>
  h.http.post(url).set(headers).attach(field, body, { filename: 'upload', contentType });

describe('signature uploads', () => {
  it('rejects SVG however it is declared', async () => {
    const before = await assetCount();
    const asSvg = await upload(signatureUrl, SVG, 'image/svg+xml');
    expect(asSvg.status).toBe(415);
    expect(asSvg.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect(asSvg.body.error.message).toContain('PNG or JPEG');
    // Declared as PNG: the magic bytes give it away.
    const disguised = await upload(signatureUrl, SVG, 'image/png');
    expect(disguised.status).toBe(415);
    expect(await assetCount()).toBe(before);
  });

  it('rejects content that does not match the declared type', async () => {
    const png = solidPng(600, 200);
    const asJpeg = await upload(signatureUrl, png, 'image/jpeg');
    expect(asJpeg.status).toBe(415);
    expect(asJpeg.body.error.message).toMatch(/does not match/);
    const asPng = await upload(signatureUrl, solidJpeg(), 'image/png');
    expect(asPng.status).toBe(415);
    const text = await upload(signatureUrl, Buffer.from('definitely not an image'), 'image/png');
    expect(text.status).toBe(415);
    const gif = await upload(signatureUrl, Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;', 'latin1'), 'image/gif');
    expect(gif.status).toBe(415);
  });

  it('rejects files over 2 MB', async () => {
    const big = Buffer.concat([solidPng(600, 200), Buffer.alloc(2 * 1024 * 1024 + 10, 7)]);
    const res = await upload(signatureUrl, big, 'image/png');
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
    expect(res.body.error.message).toContain('2 MB');
  });

  it('rejects corrupt or truncated images that magic bytes alone would accept', async () => {
    const good = solidPng(600, 200);
    const truncated = good.subarray(0, good.length - 40);
    expect((await upload(signatureUrl, truncated, 'image/png')).status).toBe(415);
    const flipped = Buffer.from(good);
    flipped[flipped.length - 20] = flipped[flipped.length - 20]! ^ 0xff;
    const corrupt = await upload(signatureUrl, flipped, 'image/png');
    expect(corrupt.status).toBe(415);
    expect(corrupt.body.error.code).toBe('INVALID_IMAGE');
    const jpegHead = solidJpeg().subarray(0, 300);
    expect((await upload(signatureUrl, jpegHead, 'image/jpeg')).status).toBe(415);
  });

  it('checks dimensions', async () => {
    const tiny = await upload(signatureUrl, solidPng(100, 30), 'image/png');
    expect(tiny.status).toBe(422);
    expect(tiny.body.error.code).toBe('IMAGE_DIMENSIONS');
    expect(tiny.body.error.message).toContain('100×30');
    const square = await upload(signatureUrl, solidPng(500, 500), 'image/png');
    expect(square.status).toBe(422);
    const huge = await upload(signatureUrl, solidPng(5000, 1500), 'image/png');
    expect(huge.status).toBe(422);
  });

  it('requires a single multipart file field', async () => {
    const json = await h.http.post(signatureUrl).set(admin).send({ file: 'nope' });
    expect(json.status).toBe(415);
    expect(json.body.error.code).toBe('MULTIPART_REQUIRED');
    const noFile = await h.http.post(signatureUrl).set(admin).field('note', 'hello');
    expect(noFile.status).toBe(400);
    expect(noFile.body.error.code).toBe('FILE_REQUIRED');
    const wrongField = await upload(signatureUrl, solidPng(600, 200), 'image/png', admin, 'image');
    expect(wrongField.status).toBe(400);
    expect(wrongField.body.error.code).toBe('UNEXPECTED_FILE');
    const unknown = await upload(`/api/v1/certification-assets/signatories/${'0190a3b2-0000-7000-8000-000000000999'}/signature`, solidPng(600, 200), 'image/png');
    expect(unknown.status).toBe(404);
  });

  it('is limited to people who manage signatures', async () => {
    expect((await upload(signatureUrl, solidPng(600, 200), 'image/png', await h.as('marcus'))).status).toBe(403);
    expect((await upload(signatureUrl, solidPng(600, 200), 'image/png', await h.as('danielle'))).status).toBe(403);
    expect((await upload(stampUrl, solidPng(400, 400), 'image/png', await h.as('shelby'))).status).toBe(403);
  });

  it('accepts PNG and JPEG, versions them and records metadata', async () => {
    const before = await assetCount();
    const png = await upload(signatureUrl, solidPng(640, 220), 'image/png');
    expect(png.status).toBe(201);
    expect(png.body.currentSignature).toMatchObject({ version: 2, contentType: 'image/png', width: 640, height: 220, uploadedBy: { displayName: 'Priya Raman' } });
    expect(png.body.currentSignature.sha256).toMatch(/^[0-9a-f]{64}$/);
    const jpeg = await upload(signatureUrl, solidJpeg(), 'image/jpeg');
    expect(jpeg.status).toBe(201);
    expect(jpeg.body.currentSignature).toMatchObject({ version: 3, contentType: 'image/jpeg', width: 600, height: 200 });
    expect(await assetCount()).toBe(before + 2);

    const versions = await h.http.get(`/api/v1/signatories/${SIGNATORIES[1].id}/signatures`).set(admin);
    expect(versions.body.items.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    // Signed preview links serve the image.
    const url = new URL(jpeg.body.currentSignature.previewUrl);
    const file = await h.http.get(`${url.pathname}${url.search}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    const audit = await h.db.selectFrom('outbox_events').select('envelope').where('type', '=', 'audit.recorded').execute();
    expect(audit.some((a) => (a.envelope as { payload: { action: string } }).payload.action === 'signatory.signature_uploaded')).toBe(true);
  });

  it('uploads stamp images and template artwork with their own limits', async () => {
    const stamp = await upload(stampUrl, solidPng(400, 400), 'image/png');
    expect(stamp.status).toBe(201);
    expect(stamp.body.currentImage).toMatchObject({ version: 2, width: 400, height: 400 });
    expect((await upload(stampUrl, solidPng(600, 100), 'image/png')).status).toBe(422);

    const background = await h.http.post('/api/v1/certification-assets/images?purpose=background').set(admin).attach('file', solidPng(1200, 800), { filename: 'bg.png', contentType: 'image/png' });
    expect(background.status).toBe(201);
    expect(background.body).toMatchObject({ purpose: 'background', width: 1200, height: 800, contentType: 'image/png' });
    expect((await h.http.post('/api/v1/certification-assets/images?purpose=stamp').set(admin).attach('file', solidPng(1200, 800), { filename: 'bg.png', contentType: 'image/png' })).status).toBe(400);
    const fetched = await h.http.get(`/api/v1/certification-assets/${background.body.id}`).set(admin);
    expect(fetched.status).toBe(200);
  });
});
