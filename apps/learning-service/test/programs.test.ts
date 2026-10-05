import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PEOPLE, TEAMS } from '@a5/seed-data';
import { buildProgram, enroll, outline, randomId } from './fixtures.js';
import { createLearningHarness, type LearningHarness } from './harness.js';

let h: LearningHarness;
let admin: Record<string, string>;

beforeAll(async () => {
  h = await createLearningHarness('programs');
  admin = await h.as('grant');
});
afterAll(() => h?.close());

describe('access control', () => {
  it('keeps a sales representative out of every administrative endpoint', async () => {
    const rep = await h.as('marcus');
    const someId = randomId();
    const calls = [
      () => h.http.get('/api/v1/programs'),
      () => h.http.post('/api/v1/programs').send({ title: 'Rogue program' }),
      () => h.http.get(`/api/v1/programs/${someId}`),
      () => h.http.post(`/api/v1/programs/${someId}/publish`).send({ changeNote: 'nope' }),
      () => h.http.post('/api/v1/lessons').send({ moduleId: someId, type: 'article', title: 'x' }),
      () => h.http.delete(`/api/v1/lessons/${someId}`),
      () => h.http.get('/api/v1/enrollments'),
      () => h.http.post('/api/v1/enrollments').send({ programId: someId, userIds: [PEOPLE.marcus.id] }),
      () => h.http.get('/api/v1/progress/team'),
      () => h.http.get('/api/v1/learning/approvals'),
      () => h.http.get(`/internal/programs/${someId}/summary`),
    ];
    const statuses: number[] = [];
    for (const call of calls) statuses.push((await call().set(rep)).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(403));
    // Internal routes need a service token, not a principal.
    expect(statuses[10]).toBe(401);
  });

  it('requires authentication', async () => {
    expect((await h.http.get('/api/v1/programs')).status).toBe(401);
  });
});

describe('programs', () => {
  it('creates a draft with a derived slug and validated settings', async () => {
    const res = await h.http.post('/api/v1/programs').set(admin).send({ title: 'Storm Season Refresher', category: 'Refresher', settings: { defaultMinWatchPercent: 85 } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: 'Storm Season Refresher',
      slug: 'storm-season-refresher',
      status: 'draft',
      phaseLabel: 'Week',
      publishedVersion: 0,
      settings: { navigationMode: 'sequential', defaultMinWatchPercent: 85, allowSkipAhead: false, inactivityAlertDays: 7 },
    });
    expect(res.body.owner.id).toBe(PEOPLE.grant.id);

    const again = await h.http.post('/api/v1/programs').set(admin).send({ title: 'Storm Season Refresher' });
    expect(again.body.slug).toBe('storm-season-refresher-2');
    const clash = await h.http.post('/api/v1/programs').set(admin).send({ title: 'Anything', slug: 'storm-season-refresher' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('SLUG_TAKEN');

    const bad = await h.http.post('/api/v1/programs').set(admin).send({ title: 'Bad', settings: { defaultMinWatchPercent: 150 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields[0].path).toBe('settings.defaultMinWatchPercent');
  });

  it('updates settings without losing the ones that were not sent, and flags unpublished changes', async () => {
    const created = await h.http.post('/api/v1/programs').set(admin).send({ title: 'Settings Program', settings: { allowSkipAhead: true } });
    const id = created.body.id;
    const updated = await h.http.patch(`/api/v1/programs/${id}`).set(admin).send({ settings: { defaultDueDays: 30 }, tags: ['sales'], phaseLabel: 'Module' });
    expect(updated.status).toBe(200);
    expect(updated.body.settings).toMatchObject({ allowSkipAhead: true, defaultDueDays: 30 });
    expect(updated.body.phaseLabel).toBe('Module');
    expect(updated.body.hasUnpublishedChanges).toBe(true);
    expect((await h.http.patch(`/api/v1/programs/${id}`).set(admin).send({ availabilityStartsAt: '2027-02-01T00:00:00Z', availabilityEndsAt: '2027-01-01T00:00:00Z' })).status).toBe(400);
  });

  it('lists with search, status filter and pagination', async () => {
    const all = await h.http.get('/api/v1/programs?pageSize=2&sort=title').set(admin);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.total).toBeGreaterThanOrEqual(3);
    const search = await h.http.get('/api/v1/programs?q=refresher').set(admin);
    expect(search.body.items.map((p: { title: string }) => p.title)).toEqual(['Storm Season Refresher', 'Storm Season Refresher']);
    expect((await h.http.get('/api/v1/programs?status=published').set(admin)).body.items.every((p: { status: string }) => p.status === 'published')).toBe(true);
    expect((await h.http.get('/api/v1/programs/00000000-0000-4000-8000-000000000000').set(admin)).status).toBe(404);
  });

  it('archives, blocks edits and restores', async () => {
    const created = await h.http.post('/api/v1/programs').set(admin).send({ title: 'Archive Me' });
    const id = created.body.id;
    await h.clearOutbox();
    const archived = await h.http.post(`/api/v1/programs/${id}/archive`).set(admin);
    expect(archived.body.status).toBe('archived');
    expect((await h.outbox('program.archived')).map((e) => (e.payload as { programId: string }).programId)).toEqual([id]);
    const edit = await h.http.patch(`/api/v1/programs/${id}`).set(admin).send({ title: 'Nope' });
    expect(edit.status).toBe(422);
    expect(edit.body.error.code).toBe('PROGRAM_ARCHIVED');
    const restored = await h.http.post(`/api/v1/programs/${id}/restore`).set(admin);
    expect(restored.body.status).toBe('draft');
    expect((await h.http.post(`/api/v1/programs/${id}/restore`).set(admin)).status).toBe(422);
  });

  it('records an audit event for every administrative mutation', async () => {
    await h.clearOutbox();
    const created = await h.http.post('/api/v1/programs').set(admin).send({ title: 'Audited Program' });
    await h.http.patch(`/api/v1/programs/${created.body.id}`).set(admin).send({ summary: 'Changed' });
    await h.http.post(`/api/v1/programs/${created.body.id}/phases`).set(admin).send({ title: 'Week A' });
    const audits = await h.outbox('audit.recorded');
    expect(audits.map((e) => (e.payload as { action: string }).action)).toEqual(['program.created', 'program.updated', 'phase.created']);
    expect(audits.every((e) => (e.payload as { actorDisplay: string }).actorDisplay === 'Grant Holloway')).toBe(true);
  });
});

describe('lesson editor', () => {
  it('validates configuration against the lesson type and reports field paths', async () => {
    const program = await h.http.post('/api/v1/programs').set(admin).send({ title: 'Validation Program' });
    const phase = await h.http.post(`/api/v1/programs/${program.body.id}/phases`).set(admin).send({ title: 'One' });
    const mod = await h.http.post(`/api/v1/programs/${program.body.id}/modules`).set(admin).send({ phaseId: phase.body.phases[0].id, title: 'Module' });
    const moduleId = mod.body.phases[0].modules[0].id;
    const create = (body: Record<string, unknown>) => h.http.post('/api/v1/lessons').set(admin).send({ moduleId, title: 'Lesson', ...body });

    const video = await create({ type: 'video', config: {} });
    expect(video.status).toBe(400);
    expect(video.body.error.fields.map((f: { path: string }) => f.path)).toContain('config.mediaAssetId');

    const link = await create({ type: 'external', config: { url: 'javascript:alert(1)' } });
    expect(link.status).toBe(400);
    expect(link.body.error.fields[0].path).toBe('config.url');

    const ai = await create({ type: 'ai_simulation', config: { scenarioId: randomId() } });
    expect(ai.body.error.fields[0].path).toBe('config.minScore');

    const unknown = await create({ type: 'hologram', config: {} });
    expect(unknown.status).toBe(400);

    const ok = await create({ type: 'video', config: { mediaAssetId: randomId(), minWatchPercent: 80 } });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ type: 'video', status: 'draft', completionMode: 'video', config: { minWatchPercent: 80, allowSkipping: false, maxCreditedPlaybackRate: 2, completion: 'auto' } });

    const patched = await h.http.patch(`/api/v1/lessons/${ok.body.id}`).set(admin).send({ config: { mediaAssetId: 'not-a-uuid' } });
    expect(patched.status).toBe(400);
  });

  it('rejects unlock rules that point at themselves or at nodes outside the program', async () => {
    const built = await buildProgram(h, admin, { title: 'Rules Program', phases: [{ key: 'p1', lessons: [{ key: 'a', type: 'article' }, { key: 'b', type: 'article' }] }] }, false);
    const self = await h.http.patch(`/api/v1/lessons/${built.lessons.a}`).set(admin).send({ unlockRule: { type: 'lesson_completed', lessonId: built.lessons.a } });
    expect(self.status).toBe(400);
    expect(self.body.error.fields[0].path).toBe('unlockRule');
    const foreign = await h.http.patch(`/api/v1/lessons/${built.lessons.a}`).set(admin).send({ unlockRule: { type: 'lesson_completed', lessonId: randomId() } });
    expect(foreign.status).toBe(400);
    const fine = await h.http.patch(`/api/v1/lessons/${built.lessons.b}`).set(admin).send({ unlockRule: { type: 'lesson_completed', lessonId: built.lessons.a } });
    expect(fine.status).toBe(200);
    expect(fine.body.unlockRule).toEqual({ type: 'lesson_completed', lessonId: built.lessons.a });
  });

  it('reorders with explicit positions across lessons, modules and phases', async () => {
    const built = await buildProgram(
      h,
      admin,
      {
        title: 'Reorder Program',
        phases: [
          { key: 'p1', lessons: [{ key: 'a', type: 'article' }, { key: 'b', type: 'article' }, { key: 'c', type: 'article' }] },
          { key: 'p2', lessons: [{ key: 'd', type: 'article' }] },
        ],
      },
      false,
    );
    const titles = async () => {
      const p = (await h.http.get(`/api/v1/programs/${built.id}`).set(admin)).body;
      return p.phases.map((ph: { title: string; modules: Array<{ lessons: Array<{ title: string; position: number }> }> }) => ({
        phase: ph.title,
        lessons: ph.modules.flatMap((m) => m.lessons.map((l) => `${l.position}:${l.title}`)),
      }));
    };
    expect(await titles()).toEqual([
      { phase: 'p1', lessons: ['1:a', '2:b', '3:c'] },
      { phase: 'p2', lessons: ['1:d'] },
    ]);

    expect((await h.http.post(`/api/v1/lessons/${built.lessons.c}/move`).set(admin).send({ position: 1 })).status).toBe(200);
    expect((await titles())[0]!.lessons).toEqual(['1:c', '2:a', '3:b']);

    // Into another module, at a given position.
    expect((await h.http.post(`/api/v1/lessons/${built.lessons.a}/move`).set(admin).send({ moduleId: built.modules.p2, position: 1 })).status).toBe(200);
    expect(await titles()).toEqual([
      { phase: 'p1', lessons: ['1:c', '2:b'] },
      { phase: 'p2', lessons: ['1:a', '2:d'] },
    ]);

    // Phases swap places.
    const moved = await h.http.post(`/api/v1/programs/${built.id}/phases/${built.phases.p2}/move`).set(admin).send({ position: 1 });
    expect(moved.body.phases.map((p: { title: string; position: number }) => `${p.position}:${p.title}`)).toEqual(['1:p2', '2:p1']);
    expect(moved.body.phases.map((p: { label: string }) => p.label)).toEqual(['Week 1', 'Week 2']);
  });

  it('manages lesson resources', async () => {
    const built = await buildProgram(h, admin, { title: 'Resources Program', phases: [{ key: 'p1', lessons: [{ key: 'a', type: 'article' }] }] }, false);
    const lessonId = built.lessons.a;
    const link = await h.http.post(`/api/v1/lessons/${lessonId}/resources`).set(admin).send({ kind: 'link', title: 'NRCA shingle guide', url: 'https://www.nrca.net/' });
    expect(link.status).toBe(201);
    const media = await h.http.post(`/api/v1/lessons/${lessonId}/resources`).set(admin).send({ kind: 'media', title: 'Inspection checklist', mediaAssetId: randomId(), position: 1 });
    expect(media.body.items.map((r: { title: string; position: number }) => `${r.position}:${r.title}`)).toEqual(['1:Inspection checklist', '2:NRCA shingle guide']);
    const bad = await h.http.post(`/api/v1/lessons/${lessonId}/resources`).set(admin).send({ kind: 'link', title: 'No address' });
    expect(bad.status).toBe(400);
    const renamed = await h.http.patch(`/api/v1/lessons/${lessonId}/resources/${link.body.items[0].id}`).set(admin).send({ title: 'Renamed' });
    expect(renamed.body.items.map((r: { title: string }) => r.title)).toContain('Renamed');
    const removed = await h.http.delete(`/api/v1/lessons/${lessonId}/resources/${link.body.items[0].id}`).set(admin);
    expect(removed.body.items).toHaveLength(1);
    expect((await h.http.get(`/api/v1/lessons/${lessonId}`).set(admin)).body.resources).toHaveLength(1);
  });

  it('deletes unpublished lessons but archives anything that was published or has activity', async () => {
    const built = await buildProgram(
      h,
      admin,
      { title: 'Delete Program', phases: [{ key: 'p1', lessons: [{ key: 'keep', type: 'article' }, { key: 'extra', type: 'article' }] }] },
      true,
    );
    // A brand-new draft lesson can be deleted outright.
    const draft = await h.http.post('/api/v1/lessons').set(admin).send({ moduleId: built.modules.p1, type: 'article', title: 'Scratch', body: 'draft' });
    const del = await h.http.delete(`/api/v1/lessons/${draft.body.id}`).set(admin);
    expect(del.body.outcome).toBe('deleted');
    expect((await h.http.get(`/api/v1/lessons/${draft.body.id}`).set(admin)).status).toBe(404);

    // A published lesson is archived instead, and learners stop seeing it after the next publish.
    await enroll(h, admin, built.id, ['marcus']);
    const rep = await h.as('marcus');
    const archived = await h.http.delete(`/api/v1/lessons/${built.lessons.extra}`).set(admin);
    expect(archived.body.outcome).toBe('archived');
    expect((await h.http.get(`/api/v1/lessons/${built.lessons.extra}`).set(admin)).body.status).toBe('archived');
    expect((await outline(h, rep, built.id)).phases[0]!.modules[0]!.lessons).toHaveLength(2);
    await h.http.post(`/api/v1/programs/${built.id}/publish`).set(admin).send({ changeNote: 'Retired the extra lesson' });
    expect((await outline(h, rep, built.id)).phases[0]!.modules[0]!.lessons).toHaveLength(1);

    // Restoring brings it back as published content for the next version.
    const restored = await h.http.post(`/api/v1/lessons/${built.lessons.extra}/restore`).set(admin);
    expect(restored.body.status).toBe('published');
  });
});

describe('publishing', () => {
  it('refuses to publish incomplete work and explains what to fix', async () => {
    const empty = await h.http.post('/api/v1/programs').set(admin).send({ title: 'Empty Program' });
    const res = await h.http.post(`/api/v1/programs/${empty.body.id}/publish`).set(admin).send({ changeNote: 'Try anyway' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PUBLISH_BLOCKED');
    expect(res.body.error.message).toContain('Add at least one lesson');

    const built = await buildProgram(h, admin, { title: 'Unfinished Program', phases: [{ key: 'p1', lessons: [{ key: 'a', type: 'article' }] }] }, false);
    await h.http.patch(`/api/v1/lessons/${built.lessons.a}`).set(admin).send({ body: null });
    const blocked = await h.http.post(`/api/v1/programs/${built.id}/publish`).set(admin).send({ changeNote: 'Missing article text' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details.issues[0]).toMatchObject({ nodeType: 'lesson', nodeId: built.lessons.a });
    const detail = await h.http.get(`/api/v1/programs/${built.id}`).set(admin);
    expect(detail.body.publishIssues).toHaveLength(1);
  });

  it('publishes atomically, snapshots the version and emits program.published with the requirement map', async () => {
    const assessmentId = randomId();
    const scenarioId = randomId();
    const built = await buildProgram(
      h,
      admin,
      {
        title: 'Publish Program',
        phases: [
          {
            key: 'w1',
            title: 'Week One',
            lessons: [
              { key: 'read', type: 'article', title: 'Read first' },
              { key: 'quiz', type: 'quiz', title: 'Check', config: { assessmentId } },
              { key: 'bonus', type: 'article', title: 'Bonus reading', isRequired: false },
            ],
          },
          { key: 'w2', title: 'Week Two', lessons: [{ key: 'ai', type: 'ai_simulation', title: 'Role-play', config: { scenarioId, minScore: 70 } }] },
        ],
      },
      false,
    );
    await h.clearOutbox();
    const res = await h.http.post(`/api/v1/programs/${built.id}/publish`).set(admin).send({ changeNote: 'Launch week one and two' });
    expect(res.status).toBe(200);
    expect(res.body.version).toMatchObject({ version: 1, changeNote: 'Launch week one and two', stats: { phases: 2, lessons: 4, requiredLessons: 3 } });
    expect(res.body.version.publishedBy.displayName).toBe('Grant Holloway');
    expect(res.body.program).toMatchObject({ status: 'published', publishedVersion: 1, hasUnpublishedChanges: false });
    expect(res.body.program.phases.every((p: { status: string; hasUnpublishedChanges: boolean }) => p.status === 'published' && !p.hasUnpublishedChanges)).toBe(true);

    const [event] = await h.outbox('program.published');
    expect(event!.payload).toMatchObject({
      programId: built.id,
      title: 'Publish Program',
      version: 1,
      phases: [
        { phaseId: built.phases.w1, title: 'Week One', position: 1 },
        { phaseId: built.phases.w2, title: 'Week Two', position: 2 },
      ],
      requiredLessonIds: [built.lessons.read, built.lessons.quiz, built.lessons.ai],
      assessments: [{ assessmentId, lessonId: built.lessons.quiz, kind: 'quiz', required: true, title: 'Check' }],
      aiScenarios: [{ scenarioId, lessonId: built.lessons.ai, minScore: 70 }],
    });
    expect((await h.outbox('audit.recorded')).map((e) => (e.payload as { action: string }).action)).toContain('program.published');

    const versions = await h.http.get(`/api/v1/programs/${built.id}/versions`).set(admin);
    expect(versions.body.items).toHaveLength(1);
    const snapshot = await h.http.get(`/api/v1/programs/${built.id}/versions/1`).set(admin);
    expect(snapshot.body.snapshot.phases).toHaveLength(2);

    // Nothing changed since: a second publish is refused.
    const again = await h.http.post(`/api/v1/programs/${built.id}/publish`).set(admin).send({ changeNote: 'Again' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('NO_CHANGES');

    // Snapshots are immutable, even for someone with direct database access.
    await expect(h.db.updateTable('program_versions').set({ change_note: 'tampered' }).where('program_id', '=', built.id).execute()).rejects.toThrow(/immutable/);
  });

  it('keeps learners on the published version until changes are published', async () => {
    const built = await buildProgram(h, admin, { title: 'Versioned Program', phases: [{ key: 'p1', lessons: [{ key: 'a', type: 'article', title: 'Original title' }] }] });
    await enroll(h, admin, built.id, ['tyler']);
    const rep = await h.as('tyler');
    await h.http.patch(`/api/v1/lessons/${built.lessons.a}`).set(admin).send({ title: 'Edited title', body: '# Edited body' });
    const detail = await h.http.get(`/api/v1/programs/${built.id}`).set(admin);
    expect(detail.body.hasUnpublishedChanges).toBe(true);
    expect(detail.body.phases[0].modules[0].lessons[0]).toMatchObject({ title: 'Edited title', hasUnpublishedChanges: true });

    const before = await h.http.get(`/api/v1/learning/me/lessons/${built.lessons.a}`).set(rep);
    expect(before.body.lesson.title).toBe('Original title');
    const draftPreview = await h.http.get(`/api/v1/programs/${built.id}/preview?source=draft`).set(admin);
    expect(draftPreview.body.phases[0].modules[0].lessons[0].title).toBe('Edited title');
    const publishedPreview = await h.http.get(`/api/v1/programs/${built.id}/preview?source=published`).set(admin);
    expect(publishedPreview.body.phases[0].modules[0].lessons[0].title).toBe('Original title');

    const published = await h.http.post(`/api/v1/programs/${built.id}/publish`).set(admin).send({ changeNote: 'Clarified the title' });
    expect(published.body.version.version).toBe(2);
    const after = await h.http.get(`/api/v1/learning/me/lessons/${built.lessons.a}`).set(rep);
    expect(after.body.lesson.title).toBe('Edited title');
    expect((await h.http.get(`/api/v1/programs/${built.id}/versions`).set(admin)).body.items.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it('duplicates a program as a draft, remapping unlock rules to the copied nodes', async () => {
    const built = await buildProgram(h, admin, {
      title: 'Original Program',
      phases: [
        { key: 'p1', lessons: [{ key: 'a', type: 'article' }] },
        { key: 'p2', unlockRule: (b) => ({ type: 'phase_completed', phaseId: b.phases.p1! }), lessons: [{ key: 'b', type: 'article' }] },
      ],
    });
    const copy = await h.http.post(`/api/v1/programs/${built.id}/duplicate`).set(admin).send({});
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ title: 'Original Program (copy)', status: 'draft', publishedVersion: 0, slug: 'original-program-copy' });
    expect(copy.body.id).not.toBe(built.id);
    const [p1, p2] = copy.body.phases;
    expect(p1.id).not.toBe(built.phases.p1);
    expect(p2.unlockRule).toEqual({ type: 'phase_completed', phaseId: p1.id });
    expect(copy.body.phases.flatMap((p: { modules: Array<{ lessons: unknown[] }> }) => p.modules.flatMap((m) => m.lessons))).toHaveLength(2);
    // The copy is independent and publishable.
    const publish = await h.http.post(`/api/v1/programs/${copy.body.id}/publish`).set(admin).send({ changeNote: 'Copy launch' });
    expect(publish.status).toBe(200);
  });

  it('sets audiences and prerequisites, rejecting loops', async () => {
    const a = await buildProgram(h, admin, { title: 'Prereq A', phases: [{ key: 'p', lessons: [{ key: 'x', type: 'article' }] }] });
    const b = await buildProgram(h, admin, { title: 'Prereq B', phases: [{ key: 'p', lessons: [{ key: 'x', type: 'article' }] }] });
    const aud = await h.http
      .put(`/api/v1/programs/${a.id}/audiences`)
      .set(admin)
      .send({ audiences: [{ kind: 'role', ref: 'sales_rep' }, { kind: 'team', ref: TEAMS[0].id }] });
    expect(aud.status).toBe(200);
    expect(aud.body.audiences).toEqual([
      { kind: 'role', ref: 'sales_rep', name: 'Sales Representative' },
      { kind: 'team', ref: TEAMS[0].id, name: 'Dallas Residential A' },
    ]);
    expect((await h.http.put(`/api/v1/programs/${a.id}/audiences`).set(admin).send({ audiences: [{ kind: 'team', ref: randomId() }] })).status).toBe(400);

    const pre = await h.http.put(`/api/v1/programs/${b.id}/prerequisites`).set(admin).send({ programIds: [a.id] });
    expect(pre.body.prerequisites).toEqual([{ id: a.id, title: 'Prereq A' }]);
    const loop = await h.http.put(`/api/v1/programs/${a.id}/prerequisites`).set(admin).send({ programIds: [b.id] });
    expect(loop.status).toBe(400);
    expect(loop.body.error.fields[0].message).toContain('loop');

    // A learner is held at the prerequisite until it is complete.
    await enroll(h, admin, b.id, ['kayla']);
    const o = await outline(h, await h.as('kayla'), b.id);
    expect(o.state).toBe('locked');
    expect(Object.values(lessonStatesOf(o)).every((s) => s === 'locked')).toBe(true);
  });
});

function lessonStatesOf(o: Awaited<ReturnType<typeof outline>>) {
  return Object.fromEntries(o.phases.flatMap((p) => p.modules.flatMap((m) => m.lessons.map((l) => [l.id, l.state]))));
}
