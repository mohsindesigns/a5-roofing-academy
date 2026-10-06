import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PEOPLE } from '@a5/seed-data';
import { HmacCdnUrlSigner } from '../src/storage/url-signer.js';
import { processedVideo } from './fixtures.js';
import { ORG, createMediaHarness, type MediaHarness } from './harness.js';

const CDN = 'https://cdn.a5roofing.example';
const SECRET = 'cdn-signing-secret-0123456789abcdefghij';

let h: MediaHarness;
let videoId: string;

beforeAll(async () => {
  h = await createMediaHarness('cdn', {
    env: { CDN_BASE_URL: `${CDN}/`, CDN_SIGNING_SECRET: SECRET },
  });
  videoId = await processedVideo(h, await h.as('shelby'));
});
afterAll(() => h?.close());

function expectSigned(raw: string, key: string) {
  const url = new URL(raw);
  expect(url.origin).toBe(CDN);
  expect(decodeURIComponent(url.pathname)).toBe(`/${key}`);
  const expires = Number(url.searchParams.get('expires'));
  expect(url.searchParams.get('signature')).toBe(
    HmacCdnUrlSigner.signature(
      SECRET,
      url.pathname,
      expires,
      url.searchParams.get('download') ?? '',
    ),
  );
  expect(expires).toBeGreaterThan(Math.floor(h.clock.now() / 1000));
}

describe('CDN delivery', () => {
  it('signs segment, poster and download URLs for the CDN instead of the API', async () => {
    const grant = await h.grant({
      userId: PEOPLE.marcus.id,
      resource: { type: 'media', id: videoId },
    });
    const descriptor = await h.http
      .post('/api/v1/media/playback')
      .set(await h.as('marcus'))
      .send({ grant });
    expect(descriptor.status).toBe(200);
    // Playlists are still served (and rewritten) by this service; bytes come from the CDN.
    expect(descriptor.body.url).toMatch(/^http:\/\/media\.test\/api\/v1\/media\/hls\//);
    expectSigned(descriptor.body.posterUrl, `media/${ORG}/${videoId}/thumb.jpg`);

    const master = await h.http.get(h.path(descriptor.body.url));
    const variantLine = master.text.split('\n').find((l) => l.startsWith('720p.m3u8'))!;
    const variantUrl = new URL(variantLine, descriptor.body.url);
    const variant = await h.http.get(h.path(variantUrl.toString()));
    const segments = variant.text.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(segments.length).toBeGreaterThan(0);
    segments.forEach((s, i) =>
      expectSigned(s, `media/${ORG}/${videoId}/hls/720p_${String(i).padStart(5, '0')}.ts`),
    );

    const detail = await h.http.get(`/api/v1/media/${videoId}`).set(await h.as('shelby'));
    expectSigned(detail.body.thumbnailUrl, `media/${ORG}/${videoId}/thumb.jpg`);
    expectSigned(detail.body.downloadUrl, `media/${ORG}/${videoId}/source`);
  });
});
