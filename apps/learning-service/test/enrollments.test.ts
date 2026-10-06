import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PEOPLE } from '@a5/seed-data';
import { buildProgram, enroll, outline, randomId } from './fixtures.js';
import { createLearningHarness, type LearningHarness } from './harness.js';

let h: LearningHarness;
let admin: Record<string, string>;
let programId: string;
let lessons: Record<string, string>;

beforeAll(async () => {
  h = await createLearningHarness('enrollments');
  admin = await h.as('grant');
  const built = await buildProgram(h, admin, {
    title: 'Enrollment Program',
    phases: [
      {
        key: 'p1',
        lessons: [
          { key: 'a', type: 'article' },
          { key: 'b', type: 'article' },
        ],
      },
    ],
  });
  programId = built.id;
  lessons = built.lessons;
});
afterAll(() => h?.close());

describe('bulk enrollment', () => {
  it('is idempotent, reactivates withdrawn learners and tells other services', async () => {
    await h.clearOutbox();
    const first = await enroll(h, admin, programId, ['marcus', 'tyler']);
    expect(first).toMatchObject({ created: 2, reactivated: 0, unchanged: 0 });
    const again = await enroll(h, admin, programId, ['marcus', 'tyler', 'kayla']);
    expect(again).toMatchObject({ created: 1, reactivated: 0, unchanged: 2 });
    expect(again.items.map((i) => i.outcome)).toEqual(['unchanged', 'unchanged', 'created']);
    const events = await h.outbox('program.enrolled');
    expect(events).toHaveLength(3);
    expect(events[0]!.payload).toMatchObject({
      programTitle: 'Enrollment Program',
      assignedBy: PEOPLE.grant.id,
      source: 'manual',
      dueAt: null,
    });
    expect(
      (
        await h.db
          .selectFrom('enrollments')
          .select('id')
          .where('program_id', '=', programId)
          .execute()
      ).length,
    ).toBe(3);

    // Concurrent duplicate requests still produce exactly one enrollment.
    const results = await Promise.all([
      enroll(h, admin, programId, ['jordan']),
      enroll(h, admin, programId, ['jordan']),
    ]);
    expect(results.map((r) => r.created).sort()).toEqual([0, 1]);
    expect(
      (
        await h.db
          .selectFrom('enrollments')
          .select('id')
          .where('user_id', '=', PEOPLE.jordan.id)
          .execute()
      ).length,
    ).toBe(1);

    // Withdraw: the learner loses access, history is kept, and re-enrolling reactivates.
    const marcusEnrollment = first.items[0]!.enrollmentId;
    const rep = await h.as('marcus');
    await h.http.post(`/api/v1/learning/me/lessons/${lessons.a}/complete`).set(rep);
    const withdrawn = await h.http
      .post(`/api/v1/enrollments/${marcusEnrollment}/withdraw`)
      .set(admin)
      .send({ reason: 'Moved to the commercial team' });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body).toMatchObject({
      status: 'withdrawn',
      withdrawalReason: 'Moved to the commercial team',
    });
    expect(
      (await h.outbox('enrollment.withdrawn')).map(
        (e) => (e.payload as { enrollmentId: string }).enrollmentId,
      ),
    ).toEqual([marcusEnrollment]);
    const blocked = await h.http.get(`/api/v1/learning/me/programs/${programId}/outline`).set(rep);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('ENROLLMENT_WITHDRAWN');
    expect((await h.http.get('/api/v1/learning/me/enrollments').set(rep)).body.items).toHaveLength(
      0,
    );
    expect(
      (await h.http.post(`/api/v1/enrollments/${marcusEnrollment}/withdraw`).set(admin).send({}))
        .status,
    ).toBe(200);
    expect((await h.outbox('enrollment.withdrawn')).length).toBe(1);

    const back = await enroll(
      h,
      admin,
      programId,
      ['marcus'],
      new Date(Date.now() + 14 * 86_400_000).toISOString(),
    );
    expect(back).toMatchObject({ created: 0, reactivated: 1 });
    expect(back.items[0]!.enrollmentId).toBe(marcusEnrollment);
    const o = await outline(h, rep, programId);
    expect(o.phases[0]!.modules[0]!.lessons[0]!.state).toBe('completed');
    expect(o.percent).toBe(50);
    expect((await h.outbox('program.enrolled')).length).toBe(5);
  });

  it('applies the program’s default due date unless one is given, and lets managers change it', async () => {
    const built = await buildProgram(h, admin, {
      title: 'Due Date Program',
      settings: { defaultDueDays: 30 },
      phases: [{ key: 'p1', lessons: [{ key: 'a', type: 'article' }] }],
    });
    const [auto] = (await enroll(h, admin, built.id, ['jasmine'])).items;
    const detail = await h.http.get(`/api/v1/enrollments/${auto!.enrollmentId}`).set(admin);
    const days =
      (new Date(detail.body.dueAt).getTime() - new Date(detail.body.enrolledAt).getTime()) /
      86_400_000;
    expect(Math.round(days)).toBe(30);

    const explicit = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const [custom] = (await enroll(h, admin, built.id, ['colton'], explicit)).items;
    expect(
      (await h.http.get(`/api/v1/enrollments/${custom!.enrollmentId}`).set(admin)).body.dueAt,
    ).toBe(explicit);

    const moved = await h.http
      .put(`/api/v1/enrollments/${custom!.enrollmentId}/due-date`)
      .set(admin)
      .send({ dueAt: null });
    expect(moved.body.dueAt).toBeNull();
    const past = await h.http
      .post('/api/v1/enrollments')
      .set(admin)
      .send({ programId: built.id, userIds: [PEOPLE.isaiah.id], dueAt: '2020-01-01T00:00:00Z' });
    expect(past.status).toBe(400);
    expect(past.body.error.fields[0].path).toBe('dueAt');
  });

  it('refuses unpublished, archived and unknown targets', async () => {
    const draft = await buildProgram(
      h,
      admin,
      {
        title: 'Draft Only Program',
        phases: [{ key: 'p1', lessons: [{ key: 'a', type: 'article' }] }],
      },
      false,
    );
    const notPublished = await h.http
      .post('/api/v1/enrollments')
      .set(admin)
      .send({ programId: draft.id, userIds: [PEOPLE.marcus.id] });
    expect(notPublished.status).toBe(422);
    expect(notPublished.body.error.code).toBe('NOT_PUBLISHED');

    const unknownUser = await h.http
      .post('/api/v1/enrollments')
      .set(admin)
      .send({ programId, userIds: [randomId()] });
    expect(unknownUser.status).toBe(400);
    expect(
      (
        await h.http
          .post('/api/v1/enrollments')
          .set(admin)
          .send({ programId: randomId(), userIds: [PEOPLE.marcus.id] })
      ).status,
    ).toBe(404);
    expect(
      (await h.http.post('/api/v1/enrollments').set(admin).send({ programId, userIds: [] })).status,
    ).toBe(400);

    await h.db
      .updateTable('dir_users')
      .set({ status: 'deactivated' })
      .where('id', '=', PEOPLE.ethan.id)
      .execute();
    const deactivated = await h.http
      .post('/api/v1/enrollments')
      .set(admin)
      .send({ programId, userIds: [PEOPLE.ethan.id] });
    expect(deactivated.status).toBe(400);
    expect(deactivated.body.error.fields[0].message).toContain('Ethan Kowalski');
  });
});

describe('manager enrollment scope', () => {
  it('lets managers enroll people on their teams and refuses everyone else, atomically', async () => {
    const built = await buildProgram(h, admin, {
      title: 'Scoped Program',
      phases: [{ key: 'p1', lessons: [{ key: 'a', type: 'article' }] }],
    });
    const danielle = await h.as('danielle');
    // Danielle manages Dallas Residential A (Kayla, Marcus, ...), not Fort Worth Storm Response.
    const outside = await h.http
      .post('/api/v1/enrollments')
      .set(danielle)
      .send({ programId: built.id, userIds: [PEOPLE.naomi.id] });
    expect(outside.status).toBe(403);
    expect(outside.body.error.message).toContain('teams you manage');
    expect(outside.body.error.details.userIds).toEqual([PEOPLE.naomi.id]);

    const mixed = await h.http
      .post('/api/v1/enrollments')
      .set(danielle)
      .send({ programId: built.id, userIds: [PEOPLE.kayla.id, PEOPLE.naomi.id] });
    expect(mixed.status).toBe(403);
    expect(
      await h.db
        .selectFrom('enrollments')
        .select('id')
        .where('program_id', '=', built.id)
        .execute(),
    ).toHaveLength(0);

    const inside = await h.http
      .post('/api/v1/enrollments')
      .set(danielle)
      .send({ programId: built.id, userIds: [PEOPLE.kayla.id, PEOPLE.marcus.id] });
    expect(inside.status).toBe(200);
    expect(inside.body.created).toBe(2);
    expect(
      (await h.outbox('program.enrolled'))
        .filter((e) => (e.payload as { programId: string }).programId === built.id)
        .every((e) => (e.payload as { assignedBy: string }).assignedBy === PEOPLE.danielle.id),
    ).toBe(true);

    // A trainer's scope is their assigned trainees, who may sit on other teams. Trainers cannot assign.
    expect(
      (
        await h.http
          .post('/api/v1/enrollments')
          .set(await h.as('hector'))
          .send({ programId: built.id, userIds: [PEOPLE.devon.id] })
      ).status,
    ).toBe(403);

    // Managers can change due dates in scope only; withdrawing needs enrollments.manage.
    const kaylaEnrollment = inside.body.items.find(
      (i: { userId: string }) => i.userId === PEOPLE.kayla.id,
    ).enrollmentId;
    const due = new Date(Date.now() + 9 * 86_400_000).toISOString();
    expect(
      (
        await h.http
          .put(`/api/v1/enrollments/${kaylaEnrollment}/due-date`)
          .set(danielle)
          .send({ dueAt: due })
      ).body.dueAt,
    ).toBe(due);
    expect(
      (
        await h.http
          .put(`/api/v1/enrollments/${kaylaEnrollment}/due-date`)
          .set(await h.as('andre'))
          .send({ dueAt: due })
      ).status,
    ).toBe(404);
    expect(
      (await h.http.post(`/api/v1/enrollments/${kaylaEnrollment}/withdraw`).set(danielle).send({}))
        .status,
    ).toBe(403);
  });
});

describe('manager override', () => {
  it('completes a lesson on the learner’s behalf with a recorded reason', async () => {
    const built = await buildProgram(h, admin, {
      title: 'Override Program',
      phases: [
        {
          key: 'p1',
          lessons: [
            { key: 'quiz', type: 'quiz', config: { assessmentId: randomId() } },
            { key: 'next', type: 'article' },
          ],
        },
      ],
    });
    const [{ enrollmentId }] = (await enroll(h, admin, built.id, ['darius'])).items as [
      { enrollmentId: string },
    ];
    const url = `/api/v1/enrollments/${enrollmentId}/lessons/${built.lessons.quiz}/complete`;

    expect(
      (
        await h.http
          .post(url)
          .set(await h.as('danielle'))
          .send({ reason: 'Paper quiz on site' })
      ).status,
    ).toBe(403);
    expect((await h.http.post(url).set(admin).send({})).status).toBe(400);
    await h.clearOutbox();
    const res = await h.http
      .post(url)
      .set(admin)
      .send({ reason: 'Passed the paper quiz at the Austin branch on 9/30' });
    expect(res.status).toBe(200);
    expect(
      res.body.lessons.find((l: { lessonId: string }) => l.lessonId === built.lessons.quiz),
    ).toMatchObject({ status: 'completed', completionSource: 'manager_override' });
    expect(res.body.progressPercent).toBe(50);
    const audit = (await h.outbox('audit.recorded')).map(
      (e) => e.payload as { action: string; reason: string },
    );
    expect(audit.find((a) => a.action === 'lesson.completed_on_behalf')).toMatchObject({
      reason: 'Passed the paper quiz at the Austin branch on 9/30',
    });
    expect((await h.outbox('lesson.completed'))[0]!.payload).toMatchObject({
      source: 'manager_override',
      lessonId: built.lessons.quiz,
    });
    expect(
      await h.db
        .selectFrom('lesson_progress')
        .select(['data', 'completed_by'])
        .where('enrollment_id', '=', enrollmentId)
        .where('lesson_id', '=', built.lessons.quiz!)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      completed_by: PEOPLE.grant.id,
      data: { overrideReason: 'Passed the paper quiz at the Austin branch on 9/30' },
    });
    // The next lesson is now open for the learner; repeating the override conflicts.
    expect((await outline(h, await h.as('darius'), built.id)).nextLessonId).toBe(
      built.lessons.next,
    );
    expect((await h.http.post(url).set(admin).send({ reason: 'Again please' })).status).toBe(409);
  });
});

describe('self-enrollment', () => {
  it('offers only programs that allow it and match the learner’s audience', async () => {
    const open = await buildProgram(h, admin, {
      title: 'Open Enrollment Program',
      settings: { allowSelfEnrollment: true },
      phases: [{ key: 'p1', lessons: [{ key: 'a', type: 'article' }] }],
    });
    const teamOnly = await buildProgram(h, admin, {
      title: 'Fort Worth Only Program',
      settings: { allowSelfEnrollment: true },
      phases: [{ key: 'p1', lessons: [{ key: 'a', type: 'article' }] }],
    });
    const fortWorth = (
      await h.db
        .selectFrom('dir_teams')
        .select('id')
        .where('name', '=', 'Fort Worth Storm Response')
        .executeTakeFirstOrThrow()
    ).id;
    await h.http
      .put(`/api/v1/programs/${teamOnly.id}/audiences`)
      .set(admin)
      .send({ audiences: [{ kind: 'team', ref: fortWorth }] });
    const assignedOnly = await buildProgram(h, admin, {
      title: 'Assigned Only Program',
      phases: [{ key: 'p1', lessons: [{ key: 'a', type: 'article' }] }],
    });

    const dallas = await h.as('kayla');
    const catalog = await h.http.get('/api/v1/learning/me/catalog').set(dallas);
    const titles = catalog.body.items.map((i: { title: string }) => i.title);
    expect(titles).toContain('Open Enrollment Program');
    expect(titles).not.toContain('Fort Worth Only Program');
    expect(titles).not.toContain('Assigned Only Program');
    expect(
      (await h.http.post(`/api/v1/learning/me/programs/${teamOnly.id}/enroll`).set(dallas)).body
        .error.code,
    ).toBe('NOT_IN_AUDIENCE');
    expect(
      (await h.http.post(`/api/v1/learning/me/programs/${assignedOnly.id}/enroll`).set(dallas)).body
        .error.code,
    ).toBe('SELF_ENROLLMENT_DISABLED');

    const joined = await h.http.post(`/api/v1/learning/me/programs/${open.id}/enroll`).set(dallas);
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({
      status: 'active',
      source: 'self',
      program: { title: 'Open Enrollment Program' },
    });
    expect(
      (await h.http.post(`/api/v1/learning/me/programs/${open.id}/enroll`).set(dallas)).status,
    ).toBe(200);
    expect(
      (await h.http.get('/api/v1/learning/me/catalog').set(dallas)).body.items.map(
        (i: { title: string }) => i.title,
      ),
    ).not.toContain('Open Enrollment Program');

    const naomi = await h.http.get('/api/v1/learning/me/catalog').set(await h.as('naomi'));
    expect(naomi.body.items.map((i: { title: string }) => i.title)).toContain(
      'Fort Worth Only Program',
    );
  });
});

describe('search', () => {
  it('lets builders find any program or lesson and learners find only their own', async () => {
    const built = await buildProgram(h, admin, {
      title: 'Hail Damage Masterclass',
      phases: [
        {
          key: 'p1',
          title: 'Inspection',
          lessons: [
            { key: 'a', type: 'article', title: 'Spotting hail bruises' },
            { key: 'b', type: 'article', title: 'Wind creasing basics' },
          ],
        },
      ],
    });
    await buildProgram(h, admin, {
      title: 'Hail Policy Program',
      phases: [
        { key: 'p1', lessons: [{ key: 'a', type: 'article', title: 'Hail deductible rules' }] },
      ],
    });
    await enroll(h, admin, built.id, ['jordan']);

    const adminSearch = await h.http.get('/api/v1/learning/search?q=hail').set(admin);
    expect(adminSearch.body.programs.map((p: { title: string }) => p.title).sort()).toEqual([
      'Hail Damage Masterclass',
      'Hail Policy Program',
    ]);
    expect(adminSearch.body.lessons.map((l: { title: string }) => l.title).sort()).toEqual([
      'Hail deductible rules',
      'Spotting hail bruises',
    ]);

    const mine = await h.http.get('/api/v1/learning/search?q=hail').set(await h.as('jordan'));
    expect(mine.body.programs.map((p: { title: string }) => p.title)).toEqual([
      'Hail Damage Masterclass',
    ]);
    expect(mine.body.lessons).toEqual([
      expect.objectContaining({
        title: 'Spotting hail bruises',
        programTitle: 'Hail Damage Masterclass',
        phaseTitle: 'Inspection',
      }),
    ]);
    const none = await h.http.get('/api/v1/learning/search?q=hail').set(await h.as('darius'));
    expect(none.body).toEqual({ programs: [], lessons: [] });
    expect((await h.http.get('/api/v1/learning/search?q=h').set(admin)).status).toBe(400);
  });
});
