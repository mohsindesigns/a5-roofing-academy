import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signLessonGrant } from '@a5/auth';
import { PEOPLE } from '@a5/seed-data';
import { MediaProcessor } from '../src/processing/media-processor.js';
import { generateJourneyChecklistPdf } from '../src/seed/sample-media.js';
import { insertReadyVideo, processedVideo, uploadFile } from './fixtures.js';
import { LESSON_ID, ORG, OTHER_ORG, createMediaHarness, type MediaHarness } from './harness.js';

let h: MediaHarness;
let videoId: string;
let documentId: string;

const marcus = PEOPLE.marcus.id;

beforeAll(async () => {
  h = await createMediaHarness('playback');
  const admin = await h.as('shelby');
  videoId = await processedVideo(h, admin);
  const pdf = await uploadFile(h, admin, { kind: 'document', title: 'Customer Journey Map', filename: 'journey.pdf', mimeType: 'application/pdf' }, await generateJourneyChecklistPdf());
  documentId = pdf.assetId;
  expect(await h.app.get(MediaProcessor).process(documentId)).toBe('ready');
});
afterAll(() => h?.close());

async function describeFor(grant: string, person: Parameters<MediaHarness['as']>[0] = 'marcus') {
  return h.http.post('/api/v1/media/playback').set(await h.as(person)).send({ grant });
}

describe('playback authorization with lesson grants', () => {
  it('exchanges a valid grant for an HLS descriptor', async () => {
    await h.http
      .post(`/api/v1/media/${videoId}/chapters`)
      .set(await h.as('shelby'))
      .send({ startSeconds: 1, title: 'Hail strikes on shingles' });
    const grant = await h.grant({ userId: marcus, resource: { type: 'media', id: videoId }, policy: { minWatchPercent: 90, maxCreditedPlaybackRate: 1.5, unknown: true } });
    const res = await describeFor(grant);
    expect(res.status).toBe(200);
    const d = res.body;
    expect(d).toMatchObject({
      assetId: videoId,
      kind: 'hls',
      mimeType: 'video/mp4',
      captions: [],
      chapters: [{ startSeconds: 1, title: 'Hail strikes on shingles', position: 1 }],
      resume: { positionSeconds: 0, watchedPercent: 0, completed: false },
      policy: { minWatchPercent: 90, maxCreditedPlaybackRate: 1.5, completionPercent: 98, allowSeekAhead: true },
      heartbeatIntervalSeconds: 15,
    });
    expect(d.url).toMatch(new RegExp(`^http://media\\.test/api/v1/media/hls/${videoId}/master\\.m3u8\\?token=v1\\.`));
    expect(d.posterUrl).toMatch(/\/api\/v1\/media\/dev-storage\/object\?key=media/);
    expect(d.durationSeconds).toBeGreaterThan(2);
    expect(d.playbackToken).toMatch(/^v1\./);
    expect(new Date(d.expiresAt).getTime() - h.clock.now()).toBeGreaterThan(7_000_000);
  });

  it('refuses grants issued to another learner, organization or resource type', async () => {
    const forTyler = await h.grant({ userId: PEOPLE.tyler.id, resource: { type: 'media', id: videoId } });
    const other = await describeFor(forTyler);
    expect(other.status).toBe(403);

    const otherOrgGrant = await h.grant({ userId: marcus, organizationId: OTHER_ORG, resource: { type: 'media', id: videoId } });
    expect((await describeFor(otherOrgGrant)).status).toBe(403);

    // A learner of another organization cannot reach this organization's media even with a grant of their own.
    const outsiderGrant = await h.grant({ userId: '0190a3b2-0000-7000-8000-00000000cafe', organizationId: OTHER_ORG, resource: { type: 'media', id: videoId } });
    expect((await h.http.post('/api/v1/media/playback').set(await h.outsider([])).send({ grant: outsiderGrant })).status).toBe(404);

    const assessment = await h.grant({ userId: marcus, resource: { type: 'assessment', id: videoId } });
    expect((await describeFor(assessment)).status).toBe(403);

    const missing = await h.grant({ userId: marcus, resource: { type: 'media', id: '0190a3b2-0000-7000-8000-000000000404' } });
    expect((await describeFor(missing)).status).toBe(404);
  });

  it('refuses expired and forged grants, and anonymous callers', async () => {
    const expired = await describeFor(await h.grant({ userId: marcus, resource: { type: 'media', id: videoId } }, -10));
    expect(expired.status).toBe(403);
    expect(expired.body.error.code).toBe('GRANT_EXPIRED');

    const forged = await signLessonGrant(
      { userId: marcus, organizationId: ORG, programId: videoId, enrollmentId: videoId, lessonId: LESSON_ID, resource: { type: 'media', id: videoId }, policy: {} },
      'not-the-real-secret-not-the-real-secret-0000',
    );
    const res = await describeFor(forged);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('GRANT_INVALID');

    expect((await h.http.post('/api/v1/media/playback').send({ grant: forged })).status).toBe(401);
  });

  it('reports media that is still processing', async () => {
    const pending = await insertReadyVideo(h);
    await h.db.updateTable('media_assets').set({ status: 'processing', ready_at: null }).where('id', '=', pending).execute();
    const res = await describeFor(await h.grant({ userId: marcus, resource: { type: 'media', id: pending } }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MEDIA_NOT_READY');
  });

  it('describes documents with a signed URL', async () => {
    const res = await describeFor(await h.grant({ userId: marcus, resource: { type: 'document', id: documentId } }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'document', mimeType: 'application/pdf', playbackToken: null, resume: null, chapters: [], captions: [] });
    const file = await h.http.get(h.path(res.body.url)).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
  });
});

describe('HLS delivery', () => {
  async function descriptor() {
    const res = await describeFor(await h.grant({ userId: marcus, resource: { type: 'media', id: videoId } }));
    return res.body as { url: string; expiresAt: string };
  }

  it('rewrites variant URIs to tokenized playlist URLs and segments to signed storage URLs', async () => {
    const { url } = await descriptor();
    const token = new URL(url).searchParams.get('token')!;
    const master = await h.http.get(h.path(url));
    expect(master.status).toBe(200);
    expect(master.headers['content-type']).toMatch(/^application\/vnd\.apple\.mpegurl/);
    expect(master.headers['cache-control']).toBe('private, no-store');
    const variants = master.text.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(variants).toEqual([`360p.m3u8?token=${encodeURIComponent(token)}`, `720p.m3u8?token=${encodeURIComponent(token)}`]);
    expect(master.text).toContain('#EXT-X-STREAM-INF:BANDWIDTH=');

    const variantUrl = new URL(variants[0]!, url).toString();
    const variant = await h.http.get(h.path(variantUrl));
    expect(variant.status).toBe(200);
    const segments = variant.text.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(segments.length).toBeGreaterThan(0);
    const expires = Math.floor(new Date((await descriptor()).expiresAt).getTime() / 1000);
    for (const s of segments) {
      const u = new URL(s);
      expect(u.origin + u.pathname).toBe('http://media.test/api/v1/media/dev-storage/object');
      expect(u.searchParams.get('key')).toMatch(new RegExp(`^media/${ORG}/${videoId}/hls/360p_\\d{5}\\.ts$`));
      expect(Math.abs(Number(u.searchParams.get('expires')) - expires)).toBeLessThanOrEqual(2);
      expect(u.searchParams.get('sig')).toBeTruthy();
    }
    const segment = await h.http.get(h.path(segments[0]!)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(segment.status).toBe(200);
    expect(segment.headers['content-type']).toBe('video/mp2t');
    expect((segment.body as Buffer)[0]).toBe(0x47); // MPEG-TS sync byte
  });

  it('refuses missing, tampered and foreign tokens and unknown files', async () => {
    const { url } = await descriptor();
    const u = new URL(url);
    const token = u.searchParams.get('token')!;
    expect((await h.http.get(u.pathname)).status).toBe(401);
    const tampered = await h.http.get(`${u.pathname}?token=${encodeURIComponent(`${token.slice(0, -3)}abc`)}`);
    expect(tampered.status).toBe(401);
    expect(tampered.body.error.code).toBe('PLAYBACK_TOKEN_INVALID');

    // A token for one video cannot unlock another.
    const otherVideo = await insertReadyVideo(h);
    expect((await h.http.get(`/api/v1/media/hls/${otherVideo}/master.m3u8?token=${encodeURIComponent(token)}`)).status).toBe(403);

    // The telemetry token is not an HLS token.
    const playbackToken = (await describeFor(await h.grant({ userId: marcus, resource: { type: 'media', id: videoId } }))).body.playbackToken as string;
    expect((await h.http.get(`${u.pathname}?token=${encodeURIComponent(playbackToken)}`)).status).toBe(401);

    // Only playlists are served here; segments come from storage.
    expect((await h.http.get(`/api/v1/media/hls/${videoId}/360p_00000.ts?token=${encodeURIComponent(token)}`)).status).toBe(404);
    expect((await h.http.get(`/api/v1/media/hls/${videoId}/1080p.m3u8?token=${encodeURIComponent(token)}`)).status).toBe(404);
    expect((await h.http.get(`/api/v1/media/hls/${videoId}/..%2Fsource?token=${encodeURIComponent(token)}`)).status).toBe(404);
  });

  it('stops serving playlists once the token expired', async () => {
    const { url } = await descriptor();
    expect((await h.http.get(h.path(url))).status).toBe(200);
    h.clock.advance((h.config.media.playbackTtlSeconds + 1) * 1000);
    const late = await h.http.get(h.path(url));
    expect(late.status).toBe(401);
    expect(late.body.error.code).toBe('PLAYBACK_EXPIRED');
    // A fresh descriptor works again.
    expect((await h.http.get(h.path((await descriptor()).url))).status).toBe(200);
  });
});

describe('administrator preview', () => {
  it('returns the descriptor without progress or telemetry', async () => {
    const res = await h.http.post(`/api/v1/media/${videoId}/preview`).set(await h.as('shelby')).send();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ assetId: videoId, kind: 'hls', resume: null, playbackToken: null });
    expect((await h.http.get(h.path(res.body.url))).status).toBe(200);
  });

  it('is limited to media.view within the organization', async () => {
    expect((await h.http.post(`/api/v1/media/${videoId}/preview`).set(await h.as('marcus')).send()).status).toBe(403);
    expect((await h.http.post(`/api/v1/media/${videoId}/preview`).set(await h.outsider()).send()).status).toBe(404);
  });

  it('keeps archived media playable for lessons that still use it', async () => {
    const archivedId = await insertReadyVideo(h, { title: 'Working With Adjusters (2025)' });
    expect((await h.http.post(`/api/v1/media/${archivedId}/archive`).set(await h.as('shelby')).send()).status).toBe(200);
    const res = await describeFor(await h.grant({ userId: marcus, resource: { type: 'media', id: archivedId } }));
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('hls');
  });
});
