import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRINCIPAL_HEADER, signPrincipalToken } from '@a5/auth';
import { TEST_INTERNAL_SECRET, principalHeaders } from '@a5/nest-kit/testing';
import { uuidv7 } from '@a5/observability';
import { VTT, insertReadyVideo, outboxEvents, putUpload } from './fixtures.js';
import { ORG, createMediaHarness, type MediaHarness } from './harness.js';

let h: MediaHarness;
let admin: Record<string, string>;

beforeAll(async () => {
  h = await createMediaHarness('library');
  admin = await h.as('shelby');
});
afterAll(() => h?.close());

const get = (path: string, headers = admin) => h.http.get(path).set(headers);

describe('listing and search', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ids.claims = await insertReadyVideo(h, { title: 'How a Homeowner Claim Works', durationSeconds: 120 });
    ids.anatomy = await insertReadyVideo(h, { title: 'Anatomy of a Residential Roof', durationSeconds: 60 });
    ids.hail = await insertReadyVideo(h, { title: 'Identifying Hail and Wind Damage', durationSeconds: 90 });
    ids.other = await insertReadyVideo(h, { title: 'Another organization video', organizationId: '0190a3b2-0000-7000-8000-00000000beef' });
    await h.db.updateTable('media_assets').set({ status: 'processing', ready_at: null }).where('id', '=', ids.hail!).execute();
    await h.db
      .insertInto('media_assets')
      .values({
        id: uuidv7(),
        organization_id: ORG,
        kind: 'document',
        title: 'Customer Journey Map',
        description: 'Printable checklist',
        original_filename: 'journey.pdf',
        storage_key: `media/${ORG}/doc/source`,
        mime_type: 'application/pdf',
        size_bytes: 3500,
        status: 'ready',
        duration_seconds: null,
        width: null,
        height: null,
        hls_master_key: null,
        thumbnail_key: null,
        error: null,
        parent_asset_id: null,
        checksum: null,
        uploaded_at: new Date(),
        ready_at: new Date(),
        archived_at: null,
        created_by: '0190a3b2-0000-7000-8000-000000000001',
        updated_by: null,
      })
      .execute();
  });

  it('filters by kind, status and free text within the organization', async () => {
    const all = await get('/api/v1/media?pageSize=100');
    expect(all.status).toBe(200);
    const titles = all.body.items.map((i: { title: string }) => i.title);
    expect(titles).toEqual(expect.arrayContaining(['How a Homeowner Claim Works', 'Anatomy of a Residential Roof', 'Customer Journey Map']));
    expect(titles).not.toContain('Another organization video');
    expect(all.body).toMatchObject({ page: 1, pageSize: 100, total: 4 });

    const videos = await get('/api/v1/media?kind=video');
    expect(videos.body.total).toBe(3);
    const mixed = await get('/api/v1/media?kind=video,document');
    expect(mixed.body.total).toBe(4);
    const ready = await get('/api/v1/media?status=ready');
    expect(ready.body.items.map((i: { title: string }) => i.title).sort()).toEqual(['Anatomy of a Residential Roof', 'Customer Journey Map', 'How a Homeowner Claim Works']);
    const processing = await get('/api/v1/media?status=processing');
    expect(processing.body.items.map((i: { title: string }) => i.title)).toEqual(['Identifying Hail and Wind Damage']);

    const q = await get('/api/v1/media?q=hail');
    expect(q.body.items.map((i: { title: string }) => i.title)).toEqual(['Identifying Hail and Wind Damage']);
    expect((await get('/api/v1/media?q=journey.pdf')).body.total).toBe(1);
    expect((await get('/api/v1/media?q=checklist')).body.total).toBe(1);
    // LIKE wildcards in the query are literal text.
    expect((await get('/api/v1/media?q=%25')).body.total).toBe(0);
  });

  it('sorts and paginates', async () => {
    const byTitle = await get('/api/v1/media?kind=video&sort=title&pageSize=2');
    expect(byTitle.body.items.map((i: { title: string }) => i.title)).toEqual(['Anatomy of a Residential Roof', 'How a Homeowner Claim Works']);
    expect(byTitle.body).toMatchObject({ total: 3, pageCount: 2 });
    const page2 = await get('/api/v1/media?kind=video&sort=title&pageSize=2&page=2');
    expect(page2.body.items.map((i: { title: string }) => i.title)).toEqual(['Identifying Hail and Wind Damage']);
    const longest = await get('/api/v1/media?kind=video&sort=-durationSeconds&pageSize=1');
    expect(longest.body.items[0].id).toBe(ids.claims);
    expect((await get('/api/v1/media?pageSize=500')).status).toBe(400);
    expect((await get('/api/v1/media?kind=audio')).status).toBe(400);
  });

  it('exposes summaries without internal columns', async () => {
    const res = await get(`/api/v1/media/${ids.claims}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: ids.claims,
      kind: 'video',
      status: 'ready',
      durationSeconds: 120,
      width: 1280,
      height: 720,
      scanStatus: 'pending',
      renditions: [],
      captions: [],
      chapters: [],
      transcripts: [],
    });
    expect(res.body.thumbnailUrl).toMatch(/dev-storage\/object\?key=media/);
    expect(res.body.downloadUrl).toMatch(/download=claims\.mp4/);
    for (const internal of ['storage_key', 'storageKey', 'organizationId', 'hlsMasterKey', 'thumbnail_key']) expect(res.body).not.toHaveProperty(internal);
    expect((await get(`/api/v1/media/${uuidv7()}`)).status).toBe(404);
    expect((await get(`/api/v1/media/${ids.other}`)).status).toBe(404);
    expect((await get('/api/v1/media/not-a-uuid')).status).toBe(400);
  });
});

describe('editing', () => {
  it('updates title and description with an audit trail', async () => {
    const id = await insertReadyVideo(h, { title: 'Working With Adjusters' });
    const res = await h.http.patch(`/api/v1/media/${id}`).set(admin).send({ title: '  Working With Adjusters (2026)  ', description: 'Updated for the new claims process.' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Working With Adjusters (2026)', description: 'Updated for the new claims process.' });
    const cleared = await h.http.patch(`/api/v1/media/${id}`).set(admin).send({ description: '' });
    expect(cleared.body.description).toBeNull();
    expect((await h.http.patch(`/api/v1/media/${id}`).set(admin).send({})).status).toBe(400);
    expect((await h.http.patch(`/api/v1/media/${id}`).set(admin).send({ title: '   ' })).status).toBe(400);
    const audit = (await outboxEvents(h, 'audit.recorded')).filter((e) => e.payload.resourceId === id && e.payload.action === 'media.updated');
    expect(audit).toHaveLength(2);
    expect(audit[0]!.payload).toMatchObject({ before: { title: 'Working With Adjusters' }, after: { title: 'Working With Adjusters (2026)' } });
  });

  it('archives instead of deleting, hides archived media and refuses hard deletes', async () => {
    const id = await insertReadyVideo(h, { title: 'Retired onboarding welcome' });
    const hard = await h.http.delete(`/api/v1/media/${id}`).set(admin);
    expect(hard.status).toBe(422);
    expect(hard.body.error.code).toBe('HARD_DELETE_NOT_ALLOWED');
    expect(await h.db.selectFrom('media_assets').select('id').where('id', '=', id).executeTakeFirst()).toBeDefined();

    const archived = await h.http.post(`/api/v1/media/${id}/archive`).set(admin).send();
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('archived');
    expect(archived.body.archivedAt).toBeTruthy();
    // Archiving twice is harmless.
    expect((await h.http.post(`/api/v1/media/${id}/archive`).set(admin).send()).status).toBe(200);

    expect((await get('/api/v1/media?q=Retired')).body.total).toBe(0);
    expect((await get('/api/v1/media?q=Retired&includeArchived=true')).body.total).toBe(1);
    expect((await get('/api/v1/media?q=Retired&status=archived')).body.total).toBe(1);
    expect((await h.http.patch(`/api/v1/media/${id}`).set(admin).send({ title: 'Edited' })).body.error.code).toBe('MEDIA_ARCHIVED');
    expect((await outboxEvents(h, 'audit.recorded')).some((e) => e.payload.action === 'media.archived' && e.payload.resourceId === id)).toBe(true);
  });

  it('manages chapters in start order', async () => {
    const id = await insertReadyVideo(h, { durationSeconds: 90 });
    const post = (body: object) => h.http.post(`/api/v1/media/${id}/chapters`).set(admin).send(body);
    expect((await post({ startSeconds: 30, title: 'Adjuster inspection' })).status).toBe(201);
    expect((await post({ startSeconds: 0, title: 'Filing the claim' })).status).toBe(201);
    const third = await post({ startSeconds: 60, title: 'Deductibles and depreciation' });
    expect(third.body.items.map((c: { title: string; position: number }) => [c.position, c.title])).toEqual([
      [1, 'Filing the claim'],
      [2, 'Adjuster inspection'],
      [3, 'Deductibles and depreciation'],
    ]);

    expect((await post({ startSeconds: 30, title: 'Duplicate start' })).body.error.code).toBe('CHAPTER_EXISTS');
    expect((await post({ startSeconds: 95, title: 'After the end' })).body.error.fields[0].path).toBe('startSeconds');
    expect((await post({ startSeconds: -1, title: 'Negative' })).status).toBe(400);
    expect((await post({ startSeconds: 10, title: '' })).status).toBe(400);

    const [first, second] = third.body.items as Array<{ id: string }>;
    const moved = await h.http.patch(`/api/v1/media/${id}/chapters/${first!.id}`).set(admin).send({ startSeconds: 45, title: 'Filing the claim online' });
    expect(moved.body.items.map((c: { title: string }) => c.title)).toEqual(['Adjuster inspection', 'Filing the claim online', 'Deductibles and depreciation']);
    const removed = await h.http.delete(`/api/v1/media/${id}/chapters/${second!.id}`).set(admin);
    expect(removed.body.items.map((c: { position: number }) => c.position)).toEqual([1, 2]);
    expect((await h.http.delete(`/api/v1/media/${id}/chapters/${second!.id}`).set(admin)).status).toBe(404);

    const detail = await get(`/api/v1/media/${id}`);
    expect(detail.body.chapters).toHaveLength(2);
    // Chapters belong to videos only.
    const pdf = await h.db.selectFrom('media_assets').select('id').where('kind', '=', 'document').executeTakeFirstOrThrow();
    expect((await h.http.post(`/api/v1/media/${pdf.id}/chapters`).set(admin).send({ startSeconds: 1, title: 'x' })).body.error.code).toBe('NOT_A_VIDEO');
  });

  it('stores one transcript per language, sorted and replaceable', async () => {
    const id = await insertReadyVideo(h, { durationSeconds: 60 });
    const put = (body: object) => h.http.put(`/api/v1/media/${id}/transcript`).set(admin).send(body);
    const res = await put({
      language: 'en',
      segments: [
        { startSeconds: 4, endSeconds: 8, text: 'Then the adjuster walks the roof.' },
        { startSeconds: 0, endSeconds: 4, text: 'Welcome to claims basics.', speaker: 'Trainer' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.transcripts).toHaveLength(1);
    expect(res.body.transcripts[0].segments.map((s: { text: string }) => s.text)).toEqual(['Welcome to claims basics.', 'Then the adjuster walks the roof.']);
    await put({ language: 'es', segments: [{ startSeconds: 0, endSeconds: 3, text: 'Bienvenidos.' }] });
    const replaced = await put({ language: 'en', segments: [{ startSeconds: 0, endSeconds: 3, text: 'Replaced.' }] });
    expect(replaced.body.transcripts.map((t: { language: string; segments: unknown[] }) => [t.language, t.segments.length])).toEqual([['en', 1], ['es', 1]]);

    expect((await put({ language: 'en', segments: [{ startSeconds: 5, endSeconds: 5, text: 'Zero length' }] })).status).toBe(400);
    expect((await put({ language: 'not a tag', segments: [] })).status).toBe(400);
    expect((await put({ language: 'en', segments: [{ startSeconds: 70, endSeconds: 75, text: 'Past the end' }] })).status).toBe(400);
  });
});

describe('captions', () => {
  async function addCaption(videoId: string, label: string, language: string, isDefault: boolean) {
    const vtt = Buffer.from(VTT);
    const created = await h.http.post(`/api/v1/media/${videoId}/captions`).set(admin).send({ language, label, isDefault, filename: `${language}.vtt`, sizeBytes: vtt.length });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await putUpload(h, created.body.upload, vtt);
    // Mark the file as processed without running ffmpeg-free processing in this API-only harness.
    await h.db.updateTable('media_assets').set({ status: 'ready', ready_at: new Date() }).where('id', '=', created.body.assetId).execute();
    return created.body as { assetId: string; captionId: string };
  }

  it('keeps one default track, rejects duplicates and archives removed files', async () => {
    const videoId = await insertReadyVideo(h);
    const en = await addCaption(videoId, 'English', 'en', true);
    const es = await addCaption(videoId, 'Spanish', 'es', true);

    let detail = (await get(`/api/v1/media/${videoId}`)).body;
    expect(detail.captions.map((c: { id: string; isDefault: boolean }) => [c.id === es.captionId ? 'es' : 'en', c.isDefault])).toEqual([['es', true], ['en', false]]);

    const dup = await h.http.post(`/api/v1/media/${videoId}/captions`).set(admin).send({ language: 'en', label: 'english', filename: 'en.vtt', sizeBytes: 10 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CAPTION_EXISTS');

    const switched = await h.http.patch(`/api/v1/media/${videoId}/captions/${en.captionId}`).set(admin).send({ isDefault: true, label: 'English (US)' });
    expect(switched.status).toBe(200);
    detail = switched.body;
    expect(detail.captions.find((c: { id: string }) => c.id === en.captionId)).toMatchObject({ isDefault: true, label: 'English (US)' });
    expect(detail.captions.filter((c: { isDefault: boolean }) => c.isDefault)).toHaveLength(1);

    const removed = await h.http.delete(`/api/v1/media/${videoId}/captions/${es.captionId}`).set(admin);
    expect(removed.body.captions).toHaveLength(1);
    const file = await h.db.selectFrom('media_assets').select(['status', 'archived_at']).where('id', '=', es.assetId).executeTakeFirstOrThrow();
    expect(file.status).toBe('archived');
    expect((await h.http.delete(`/api/v1/media/${videoId}/captions/${es.captionId}`).set(admin)).status).toBe(404);
  });

  it('only accepts captions for videos in the same organization', async () => {
    const videoId = await insertReadyVideo(h);
    const ask = (headers: Record<string, string>, id: string) =>
      h.http.post(`/api/v1/media/${id}/captions`).set(headers).send({ language: 'en', label: 'English', filename: 'en.vtt', sizeBytes: 10 });
    expect((await ask(await h.outsider(), videoId)).status).toBe(404);
    const image = await insertReadyVideo(h);
    await h.db.updateTable('media_assets').set({ kind: 'image', duration_seconds: null, hls_master_key: null }).where('id', '=', image).execute();
    expect((await ask(admin, image)).body.error.code).toBe('NOT_A_VIDEO');
    // Generic caption uploads must reference a video as well.
    const generic = await h.http
      .post('/api/v1/media/uploads')
      .set(admin)
      .send({ kind: 'caption', title: 'Captions', filename: 'en.vtt', mimeType: 'text/vtt', sizeBytes: 10, caption: { videoAssetId: uuidv7(), language: 'en', label: 'English' } });
    expect(generic.status).toBe(400);
    expect(generic.body.error.fields[0].path).toBe('caption.videoAssetId');
  });
});

describe('permissions', () => {
  it('limits the library to media.view and mutations to upload/delete permissions', async () => {
    const id = await insertReadyVideo(h);
    const rep = await h.as('marcus');
    const manager = await h.as('danielle');
    const auditor = await h.as('ruth');
    expect((await get('/api/v1/media', rep)).status).toBe(403);
    expect((await get(`/api/v1/media/${id}`, rep)).status).toBe(403);
    expect((await get('/api/v1/media', manager)).status).toBe(403);
    expect((await get('/api/v1/media', auditor)).status).toBe(403);

    const viewer = await principalOf(['media.view']);
    expect((await get('/api/v1/media', viewer)).status).toBe(200);
    expect((await h.http.patch(`/api/v1/media/${id}`).set(viewer).send({ title: 'x' })).status).toBe(403);
    expect((await h.http.post(`/api/v1/media/${id}/chapters`).set(viewer).send({ startSeconds: 1, title: 'x' })).status).toBe(403);
    expect((await h.http.post(`/api/v1/media/${id}/archive`).set(viewer).send()).status).toBe(403);
    expect((await h.http.delete(`/api/v1/media/${id}`).set(viewer)).status).toBe(403);

    const uploader = await principalOf(['media.view', 'media.upload']);
    expect((await h.http.post(`/api/v1/media/${id}/archive`).set(uploader).send()).status).toBe(403);
    expect((await h.http.patch(`/api/v1/media/${id}`).set(uploader).send({ title: 'Renamed' })).status).toBe(200);

    expect((await h.http.get(`/api/v1/media/${id}`).set(await h.outsider())).status).toBe(404);
    expect((await h.http.get('/api/v1/media')).status).toBe(401);
  });
});

function principalOf(permissions: Array<'media.view' | 'media.upload' | 'media.delete'>) {
  return principalHeaders({ userId: '0190a3b2-0000-7000-8000-0000000000aa', organizationId: ORG, permissions, scope: 'organization' });
}

describe('internal API', () => {
  it('serves asset metadata to services with a service token only', async () => {
    const id = await insertReadyVideo(h, { title: 'Welcome from Leadership', durationSeconds: 42 });
    const service = await h.service();
    const one = await h.http.get(`/internal/media/${id}`).set(service);
    expect(one.status).toBe(200);
    expect(one.body).toEqual({ id, organizationId: ORG, title: 'Welcome from Leadership', kind: 'video', status: 'ready', durationSeconds: 42 });
    const many = await h.http.get(`/internal/media?ids=${id},${uuidv7()}`).set(service);
    expect(many.body.items).toHaveLength(1);
    expect((await h.http.get(`/internal/media/${uuidv7()}`).set(service)).status).toBe(404);

    expect((await h.http.get(`/internal/media/${id}`)).status).toBe(401);
    const asUser = { [PRINCIPAL_HEADER]: await signPrincipalToken(
      { userId: uuidv7(), organizationId: ORG, sessionId: null, displayName: 'x', roles: [], permissions: { 'media.view': 'platform' }, managedTeamIds: [], managedUserIds: [] },
      TEST_INTERNAL_SECRET,
    ) };
    expect((await h.http.get(`/internal/media/${id}`).set(asUser)).status).toBe(401);
  });
});
