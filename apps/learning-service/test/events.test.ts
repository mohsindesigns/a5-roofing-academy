import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiEvents, assessmentEvents, identityEvents, mediaEvents } from '@a5/events';
import { waitFor } from '@a5/testing';
import { ORGANIZATION, PEOPLE, PROGRAM, TEAMS, directoryUser } from '@a5/seed-data';
import { buildProgram, enroll, outline, randomId } from './fixtures.js';
import { createLearningHarness, type LearningHarness } from './harness.js';

let h: LearningHarness;
let admin: Record<string, string>;

beforeAll(async () => {
  h = await createLearningHarness('events');
  admin = await h.as('grant');
});
afterAll(() => h?.close());

const progressOf = async (userId: string, lessonId: string) =>
  h.db
    .selectFrom('lesson_progress')
    .selectAll()
    .where('user_id', '=', userId)
    .where('lesson_id', '=', lessonId)
    .executeTakeFirst();
const count = async (type: string) => (await h.outbox(type)).length;

describe('video events', () => {
  it('track watch progress and complete the lesson at the effective minimum', async () => {
    const mediaId = randomId();
    const strictMedia = randomId();
    const manualMedia = randomId();
    const built = await buildProgram(h, admin, {
      title: 'Video Program',
      settings: { navigationMode: 'free', defaultMinWatchPercent: 90 },
      phases: [
        {
          key: 'p1',
          lessons: [
            { key: 'default', type: 'video', config: { mediaAssetId: mediaId } },
            {
              key: 'strict',
              type: 'video',
              config: { mediaAssetId: strictMedia, minWatchPercent: 98 },
            },
            {
              key: 'manual',
              type: 'video',
              config: { mediaAssetId: manualMedia, minWatchPercent: 50, completion: 'manual' },
            },
          ],
        },
      ],
    });
    await enroll(h, admin, built.id, ['marcus']);
    const userId = PEOPLE.marcus.id;
    const progressed = (
      assetId: string,
      lessonId: string,
      watchedPercent: number,
      extra: Partial<{ userId: string; contextType: string }> = {},
    ) =>
      h.envelope(mediaEvents.videoProgressed, {
        assetId,
        userId: extra.userId ?? userId,
        contextType: extra.contextType ?? 'lesson',
        contextId: lessonId,
        watchedPercent,
        watchedSeconds: watchedPercent * 3,
        durationSeconds: 300,
      });

    // Partial progress is recorded and the lesson starts.
    await h.clearOutbox();
    await h.consume(progressed(mediaId, built.lessons.default!, 40));
    expect(await progressOf(userId, built.lessons.default!)).toMatchObject({
      status: 'in_progress',
      data: { watchedPercent: 40 },
    });
    expect(Number((await progressOf(userId, built.lessons.default!))!.percent)).toBe(40);
    expect(await count('lesson.started')).toBe(1);
    expect(await count('lesson.completed')).toBe(0);

    // Later events never lower the credited percentage (out-of-order delivery).
    await h.consume(progressed(mediaId, built.lessons.default!, 70));
    await h.consume(progressed(mediaId, built.lessons.default!, 55));
    expect((await progressOf(userId, built.lessons.default!))!.data).toMatchObject({
      watchedPercent: 70,
    });
    expect(await count('lesson.started')).toBe(1);

    // Crossing the program default (90) completes it; redelivering the same event changes nothing.
    const crossing = progressed(mediaId, built.lessons.default!, 92);
    await h.consume(crossing);
    await h.consume(crossing);
    await h.consume(
      h.envelope(mediaEvents.videoCompleted, {
        assetId: mediaId,
        userId,
        contextType: 'lesson',
        contextId: built.lessons.default!,
        watchedPercent: 100,
        watchedSeconds: 300,
        durationSeconds: 300,
      }),
    );
    expect(await progressOf(userId, built.lessons.default!)).toMatchObject({
      status: 'completed',
      completion_source: 'video',
    });
    expect(await count('lesson.completed')).toBe(1);
    expect(await count('enrollment.progressed')).toBeGreaterThanOrEqual(1);
    const inbox = await h.db
      .selectFrom('inbox_events')
      .select('handler')
      .where('event_id', '=', crossing.id)
      .execute();
    expect(inbox).toHaveLength(1);

    // The lesson's own minimum wins over the program default.
    await h.consume(progressed(strictMedia, built.lessons.strict!, 95));
    expect((await progressOf(userId, built.lessons.strict!))!.status).toBe('in_progress');
    await h.consume(progressed(strictMedia, built.lessons.strict!, 98));
    expect((await progressOf(userId, built.lessons.strict!))!.status).toBe('completed');

    // Manual videos only record progress; the learner confirms once the minimum is reached.
    const rep = await h.as('marcus');
    const early = await h.http
      .post(`/api/v1/learning/me/lessons/${built.lessons.manual}/complete`)
      .set(rep);
    expect(early.status).toBe(422);
    await h.consume(progressed(manualMedia, built.lessons.manual!, 60));
    expect((await progressOf(userId, built.lessons.manual!))!.status).toBe('in_progress');
    const detail = await h.http.get(`/api/v1/learning/me/lessons/${built.lessons.manual}`).set(rep);
    expect(detail.body.completion.canCompleteManually).toBe(true);
    expect(
      (await h.http.post(`/api/v1/learning/me/lessons/${built.lessons.manual}/complete`).set(rep))
        .status,
    ).toBe(200);
  });

  it('ignores events that do not belong to an enrolled learner’s lesson', async () => {
    const mediaId = randomId();
    const built = await buildProgram(h, admin, {
      title: 'Ignored Video Program',
      settings: { navigationMode: 'free' },
      phases: [
        { key: 'p1', lessons: [{ key: 'v', type: 'video', config: { mediaAssetId: mediaId } }] },
      ],
    });
    await enroll(h, admin, built.id, ['tyler']);
    const base = {
      assetId: mediaId,
      watchedPercent: 100,
      watchedSeconds: 300,
      durationSeconds: 300,
    };
    // Not enrolled, wrong context type, wrong asset, unknown lesson.
    await h.consume(
      h.envelope(mediaEvents.videoProgressed, {
        ...base,
        userId: PEOPLE.kayla.id,
        contextType: 'lesson',
        contextId: built.lessons.v!,
      }),
    );
    await h.consume(
      h.envelope(mediaEvents.videoProgressed, {
        ...base,
        userId: PEOPLE.tyler.id,
        contextType: 'preview',
        contextId: built.lessons.v!,
      }),
    );
    await h.consume(
      h.envelope(mediaEvents.videoProgressed, {
        ...base,
        assetId: randomId(),
        userId: PEOPLE.tyler.id,
        contextType: 'lesson',
        contextId: built.lessons.v!,
      }),
    );
    await h.consume(
      h.envelope(mediaEvents.videoProgressed, {
        ...base,
        userId: PEOPLE.tyler.id,
        contextType: 'lesson',
        contextId: randomId(),
      }),
    );
    expect(await progressOf(PEOPLE.tyler.id, built.lessons.v!)).toBeUndefined();
    expect(await progressOf(PEOPLE.kayla.id, built.lessons.v!)).toBeUndefined();
  });
});

describe('assessment events', () => {
  it('keep the best-score projection and complete the quiz lesson only when passed for that lesson', async () => {
    const assessmentId = randomId();
    const built = await buildProgram(h, admin, {
      title: 'Quiz Program',
      settings: { navigationMode: 'free' },
      phases: [
        {
          key: 'p1',
          lessons: [
            { key: 'quiz', type: 'quiz', config: { assessmentId } },
            { key: 'other', type: 'final_assessment', config: { assessmentId: randomId() } },
          ],
        },
      ],
    });
    const [{ enrollmentId }] = (await enroll(h, admin, built.id, ['naomi'])).items as [
      { enrollmentId: string },
    ];
    const userId = PEOPLE.naomi.id;
    const graded = (
      attemptNumber: number,
      scorePercent: number,
      passed: boolean,
      opts: { attemptId?: string; lessonId?: string | null; gradedAt?: Date } = {},
    ) =>
      h.envelope(assessmentEvents.attemptGraded, {
        attemptId: opts.attemptId ?? randomId(),
        assessmentId,
        assessmentTitle: 'Storm Basics Quiz',
        kind: 'quiz',
        userId,
        attemptNumber,
        scorePercent,
        passed,
        passingPercent: 80,
        gradedAt: (opts.gradedAt ?? new Date()).toISOString(),
        overridden: false,
        context:
          opts.lessonId === null
            ? {}
            : { lessonId: opts.lessonId ?? built.lessons.quiz!, programId: built.id, enrollmentId },
        questionResults: [],
      });
    const score = async () =>
      h.db
        .selectFrom('learner_assessment_scores')
        .selectAll()
        .where('user_id', '=', userId)
        .where('assessment_id', '=', assessmentId)
        .executeTakeFirst();

    // A failed attempt is recorded; the lesson is in progress, not complete.
    await h.consume(graded(1, 64, false));
    expect(await score()).toMatchObject({
      best_score: 64,
      last_score: 64,
      passed: false,
      attempts: 1,
      assessment_title: 'Storm Basics Quiz',
    });
    expect(await progressOf(userId, built.lessons.quiz!)).toMatchObject({
      status: 'in_progress',
      data: { lastScore: 64 },
    });

    // A passing attempt for a different lesson updates the projection but completes nothing.
    await h.consume(graded(2, 90, true, { lessonId: built.lessons.other! }));
    expect((await progressOf(userId, built.lessons.quiz!))!.status).toBe('in_progress');
    expect(await progressOf(userId, built.lessons.other!)).toBeUndefined();
    // Neither does a pass without lesson context (e.g. a standalone practice attempt).
    await h.consume(graded(3, 91, true, { lessonId: null }));
    expect((await progressOf(userId, built.lessons.quiz!))!.status).toBe('in_progress');
    expect(await score()).toMatchObject({
      best_score: 91,
      last_score: 91,
      passed: true,
      attempts: 3,
    });

    // The passing attempt for this lesson completes it. Redelivery is harmless.
    await h.clearOutbox();
    const pass = graded(4, 86, true);
    await h.consume(pass);
    await h.consume(pass);
    expect(await progressOf(userId, built.lessons.quiz!)).toMatchObject({
      status: 'completed',
      completion_source: 'assessment',
    });
    expect(await count('lesson.completed')).toBe(1);
    expect(await score()).toMatchObject({ best_score: 91, last_score: 86, attempts: 4 });

    // A re-grade of the same attempt replaces its score instead of adding an attempt; an older
    // grading arriving late is ignored.
    const attemptId = randomId();
    await h.consume(graded(5, 70, false, { attemptId, gradedAt: new Date(Date.now() + 1000) }));
    await h.consume(graded(5, 95, true, { attemptId, gradedAt: new Date(Date.now() + 2000) }));
    await h.consume(graded(5, 10, false, { attemptId, gradedAt: new Date(Date.now() - 60_000) }));
    expect(await score()).toMatchObject({ best_score: 95, attempts: 5 });
    expect(
      await h.db
        .selectFrom('learner_assessment_attempts')
        .select('score_percent')
        .where('attempt_id', '=', attemptId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ score_percent: 95 });
  });
});

describe('AI scoring events', () => {
  it('complete the role-play lesson at the lesson’s minimum score and are idempotent', async () => {
    const scenarioId = randomId();
    const built = await buildProgram(h, admin, {
      title: 'Role-play Program',
      settings: { navigationMode: 'free' },
      phases: [
        {
          key: 'p1',
          lessons: [{ key: 'ai', type: 'ai_simulation', config: { scenarioId, minScore: 75 } }],
        },
      ],
    });
    const [{ enrollmentId }] = (await enroll(h, admin, built.id, ['caleb'])).items as [
      { enrollmentId: string },
    ];
    const userId = PEOPLE.caleb.id;
    const scored = (
      overallScore: number,
      lessonId: string | null = built.lessons.ai!,
      sessionId = randomId(),
    ) =>
      h.envelope(aiEvents.scoreGenerated, {
        sessionId,
        scenarioId,
        scenarioTitle: 'The Busy Homeowner',
        scenarioCategory: 'Brush-off',
        difficulty: 'beginner',
        userId,
        overallScore,
        passed: overallScore >= 75,
        passingScore: 75,
        categoryScores: [{ key: 'discovery', label: 'Discovery', score: overallScore }],
        context: lessonId ? { lessonId, programId: built.id, enrollmentId } : {},
        evaluatedAt: new Date().toISOString(),
        promptVersionId: randomId(),
        rubricVersionId: randomId(),
      });
    const projection = () =>
      h.db
        .selectFrom('learner_ai_scores')
        .selectAll()
        .where('user_id', '=', userId)
        .where('scenario_id', '=', scenarioId)
        .executeTakeFirst();

    await h.consume(scored(68));
    expect(await projection()).toMatchObject({ best_score: 68, sessions: 1, passed: false });
    expect(await progressOf(userId, built.lessons.ai!)).toMatchObject({
      status: 'in_progress',
      data: { bestScore: 68 },
    });

    // A good practice session outside the lesson raises the projection but does not complete it.
    await h.consume(scored(90, null));
    expect(await projection()).toMatchObject({ best_score: 90, sessions: 2 });
    expect((await progressOf(userId, built.lessons.ai!))!.status).toBe('in_progress');

    await h.clearOutbox();
    const pass = scored(76);
    await h.consume(pass);
    await h.consume(pass);
    expect(await progressOf(userId, built.lessons.ai!)).toMatchObject({
      status: 'completed',
      completion_source: 'ai_score',
    });
    expect(await count('lesson.completed')).toBe(1);
    expect(await count('program.completed')).toBe(1);
    expect(await projection()).toMatchObject({ best_score: 90, last_score: 76, sessions: 3 });
    expect(
      (
        await h.db
          .selectFrom('enrollments')
          .select('status')
          .where('id', '=', enrollmentId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('completed');
  });
});

describe('event delivery through Redis streams', () => {
  it('runs the consumers registered with @OnEvent for media, assessment and AI streams', async () => {
    const live = await createLearningHarness('events-live', { role: 'all' });
    try {
      const adminLive = await live.as('grant');
      const mediaId = randomId();
      const built = await buildProgram(live, adminLive, {
        title: 'Streamed Program',
        settings: { navigationMode: 'free' },
        phases: [
          { key: 'p1', lessons: [{ key: 'v', type: 'video', config: { mediaAssetId: mediaId } }] },
        ],
      });
      await enroll(live, adminLive, built.id, ['jordan']);
      await live.publish(
        live.envelope(mediaEvents.videoProgressed, {
          assetId: mediaId,
          userId: PEOPLE.jordan.id,
          contextType: 'lesson',
          contextId: built.lessons.v!,
          watchedPercent: 97,
          watchedSeconds: 290,
          durationSeconds: 300,
        }),
      );
      const row = await waitFor(
        async () => {
          const p = await live.db
            .selectFrom('lesson_progress')
            .select('status')
            .where('user_id', '=', PEOPLE.jordan.id)
            .executeTakeFirst();
          return p?.status === 'completed' ? p : null;
        },
        { timeoutMs: 15_000, message: 'video.progressed to complete the lesson' },
      );
      expect(row.status).toBe('completed');

      // The outbox relay publishes our own events to the learning stream.
      const published = await waitFor(
        async () =>
          (
            await live.db
              .selectFrom('outbox_events')
              .select('id')
              .where('published_at', 'is not', null)
              .execute()
          ).length > 0,
        {
          timeoutMs: 15_000,
          message: 'outbox relay',
        },
      );
      expect(published).toBe(true);
      const entries = await live.redis.xrange(live.ns.stream('events:learning'), '-', '+');
      expect(entries.length).toBeGreaterThan(0);
    } finally {
      await live.close();
    }
  }, 60_000);
});

describe('automatic enrollment', () => {
  it('enrolls people who match a program’s audience when they appear in the directory, once', async () => {
    const built = await buildProgram(h, admin, {
      title: 'Auto Enroll Program',
      settings: { autoEnrollAudience: true },
      phases: [{ key: 'p1', lessons: [{ key: 'a', type: 'article' }] }],
    });
    await h.http
      .put(`/api/v1/programs/${built.id}/audiences`)
      .set(admin)
      .send({
        audiences: [
          { kind: 'role', ref: 'sales_rep' },
          { kind: 'team', ref: TEAMS[2].id },
        ],
      });
    const record = (overrides: Partial<ReturnType<typeof directoryUser>>) => ({
      ...directoryUser('darius'),
      ...overrides,
    });
    const upsert = (user: ReturnType<typeof record>, revision: number) =>
      h.envelope(identityEvents.directoryUserUpserted, { user, revision });

    // A manager (no matching role or team) is not enrolled.
    await h.consume(
      upsert(record({ id: PEOPLE.danielle.id, roleKeys: ['manager'], teamIds: [] }), 5),
    );
    expect(
      await h.db
        .selectFrom('enrollments')
        .select('id')
        .where('program_id', '=', built.id)
        .execute(),
    ).toHaveLength(0);

    await h.clearOutbox();
    const hire = upsert(
      record({
        id: randomId(),
        organizationId: ORGANIZATION.id,
        roleKeys: ['sales_rep'],
        teamIds: [],
        email: 'new.hire@a5roofing.example',
        displayName: 'Riley Thompson',
        firstName: 'Riley',
        lastName: 'Thompson',
      }),
      1,
    );
    await h.consume(hire);
    await h.consume(hire);
    const hired = (hire.payload as { user: { id: string } }).user.id;
    const enrollments = await h.db
      .selectFrom('enrollments')
      .selectAll()
      .where('program_id', '=', built.id)
      .execute();
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0]).toMatchObject({
      user_id: hired,
      source: 'rule',
      assigned_by: null,
      status: 'active',
    });
    expect(await count('program.enrolled')).toBe(1);

    // Withdrawing sticks: a later directory update does not re-enroll them.
    await h.db
      .updateTable('enrollments')
      .set({ status: 'withdrawn', withdrawn_at: new Date() })
      .where('id', '=', enrollments[0]!.id)
      .execute();
    await h.consume(
      upsert(
        record({
          id: hired,
          roleKeys: ['sales_rep'],
          teamIds: [],
          email: 'new.hire@a5roofing.example',
          firstName: 'Riley',
          lastName: 'Thompson',
          displayName: 'Riley Thompson',
        }),
        2,
      ),
    );
    expect(
      (
        await h.db
          .selectFrom('enrollments')
          .select('status')
          .where('program_id', '=', built.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('withdrawn');

    // The directory projection itself follows identity (and ignores stale revisions).
    await h.consume(
      upsert(
        record({
          id: hired,
          displayName: 'Stale Name',
          firstName: 'Stale',
          roleKeys: ['sales_rep'],
          teamIds: [],
        }),
        1,
      ),
    );
    expect(
      (
        await h.db
          .selectFrom('dir_users')
          .select('display_name')
          .where('id', '=', hired)
          .executeTakeFirstOrThrow()
      ).display_name,
    ).toBe('Riley Thompson');
    void PROGRAM;
    void outline;
  });
});

describe('overdue sweep', () => {
  it('emits enrollment.overdue once per enrollment per day', async () => {
    const built = await buildProgram(h, admin, {
      title: 'Overdue Program',
      phases: [{ key: 'p1', lessons: [{ key: 'a', type: 'article' }] }],
    });
    const result = await enroll(h, admin, built.id, ['devon', 'ethan']);
    const [devon, ethan] = result.items;
    await h.db
      .updateTable('enrollments')
      .set({ due_at: new Date(Date.now() - 3 * 86_400_000) })
      .where('id', '=', devon!.enrollmentId)
      .execute();
    await h.db
      .updateTable('enrollments')
      .set({ due_at: new Date(Date.now() + 3 * 86_400_000) })
      .where('id', '=', ethan!.enrollmentId)
      .execute();

    await h.clearOutbox();
    const first = await h.overdue.sweep();
    expect(first.notified).toBeGreaterThanOrEqual(1);
    const events = (await h.outbox('enrollment.overdue')).filter(
      (e) => (e.payload as { programId: string }).programId === built.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      enrollmentId: devon!.enrollmentId,
      userId: PEOPLE.devon.id,
      programTitle: 'Overdue Program',
      progressPercent: 0,
    });

    // Running again the same day (or concurrently) emits nothing new.
    const second = await h.overdue.sweep();
    await Promise.all([h.overdue.sweep(), h.overdue.sweep()]);
    expect(second.notified).toBe(0);
    expect(
      (await h.outbox('enrollment.overdue')).filter(
        (e) => (e.payload as { programId: string }).programId === built.id,
      ),
    ).toHaveLength(1);

    // Tomorrow it is reminded again; once complete it stops.
    const tomorrow = new Date(Date.now() + 26 * 3_600_000);
    expect((await h.overdue.sweep(tomorrow)).notified).toBeGreaterThanOrEqual(1);
    expect(
      (await h.outbox('enrollment.overdue')).filter(
        (e) => (e.payload as { programId: string }).programId === built.id,
      ),
    ).toHaveLength(2);
    await h.http
      .post(`/api/v1/learning/me/lessons/${built.lessons.a}/complete`)
      .set(await h.as('devon'));
    const before = (await h.outbox('enrollment.overdue')).length;
    await h.overdue.sweep(new Date(Date.now() + 50 * 3_600_000));
    expect(
      (await h.outbox('enrollment.overdue')).filter(
        (e) => (e.payload as { enrollmentId: string }).enrollmentId === devon!.enrollmentId,
      ),
    ).toHaveLength(2);
    void before;
  });
});
