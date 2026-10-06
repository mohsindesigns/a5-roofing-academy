import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyLessonGrant } from '@a5/auth';
import { aiEvents, assessmentEvents } from '@a5/events';
import { PEOPLE } from '@a5/seed-data';
import { buildProgram, enroll, lessonStates, outline, randomId } from './fixtures.js';
import { TEST_INTERNAL_SECRET, createLearningHarness, type LearningHarness } from './harness.js';

let h: LearningHarness;
let admin: Record<string, string>;

beforeAll(async () => {
  h = await createLearningHarness('progression');
  admin = await h.as('grant');
});
afterAll(() => h?.close());

const complete = (who: Record<string, string>, lessonId: string) =>
  h.http.post(`/api/v1/learning/me/lessons/${lessonId}/complete`).set(who);
const types = async () =>
  (await h.outbox()).filter((e) => e.type !== 'audit.recorded').map((e) => e.type);

describe('sequential navigation', () => {
  it('unlocks lessons and phases one after another and keeps progress in step', async () => {
    const built = await buildProgram(h, admin, {
      title: 'Sequential Program',
      phases: [
        {
          key: 'p1',
          title: 'Basics',
          lessons: [
            { key: 'a1', type: 'article', title: 'First read' },
            { key: 'a2', type: 'article', title: 'Second read' },
            { key: 'a3', type: 'article', title: 'Optional read', isRequired: false },
          ],
        },
        {
          key: 'p2',
          title: 'Advanced',
          lessons: [{ key: 'b1', type: 'article', title: 'Advanced read' }],
        },
      ],
    });
    const [{ enrollmentId }] = (await enroll(h, admin, built.id, ['marcus'])).items as [
      { enrollmentId: string },
    ];
    const rep = await h.as('marcus');
    const { a1, a2, a3, b1 } = built.lessons as Record<string, string>;

    let o = await outline(h, rep, built.id);
    expect(lessonStates(o)).toEqual({
      [a1]: 'available',
      [a2]: 'locked',
      [a3]: 'locked',
      [b1]: 'locked',
    });
    expect(o.phases[1]).toMatchObject({ state: 'locked' });
    expect(o.phases[1]!.requirements).toEqual([
      {
        description: 'Complete Week 1: Basics',
        satisfied: false,
        progress: { current: 0, target: 2, unit: 'count' },
      },
    ]);
    expect(o.phases[0]!.modules[0]!.lessons[1]!.requirements.map((r) => r.description)).toEqual([
      'Complete "First read"',
    ]);
    expect(o.nextLessonId).toBe(a1);

    // A locked lesson reveals nothing and cannot be started or completed.
    const locked = await h.http.get(`/api/v1/learning/me/lessons/${a2}`).set(rep);
    expect(locked.body).toMatchObject({
      state: 'locked',
      grant: null,
      lesson: { body: null, config: null },
    });
    expect(locked.body.requirements[0].description).toBe('Complete "First read"');
    const start = await h.http.post(`/api/v1/learning/me/lessons/${a2}/start`).set(rep);
    expect(start.status).toBe(422);
    expect(start.body.error.code).toBe('LESSON_LOCKED');
    expect((await complete(rep, a2)).status).toBe(422);

    await h.clearOutbox();
    const first = await complete(rep, a1);
    expect(first.status).toBe(200);
    expect(first.body.progress).toMatchObject({
      status: 'completed',
      percent: 100,
      completionSource: 'learner',
    });
    expect(first.body.enrollment).toMatchObject({
      progressPercent: 33.3,
      requiredCompleted: 1,
      requiredTotal: 3,
      status: 'active',
    });
    o = await outline(h, rep, built.id);
    expect(lessonStates(o)).toEqual({
      [a1]: 'completed',
      [a2]: 'available',
      [a3]: 'locked',
      [b1]: 'locked',
    });
    expect(o.percent).toBe(33.3);

    // Completing again changes nothing and emits nothing.
    const outboxSize = (await h.outbox()).length;
    expect((await complete(rep, a1)).status).toBe(200);
    expect((await h.outbox()).length).toBe(outboxSize);

    // The optional lesson does not hold back the next phase.
    const second = await complete(rep, a2);
    expect(second.body.enrollment.requiredCompleted).toBe(2);
    o = await outline(h, rep, built.id);
    expect(o.phases[0]).toMatchObject({ state: 'completed', percent: 100 });
    expect(lessonStates(o)[b1]).toBe('available');
    expect(lessonStates(o)[a3]).toBe('available');

    const last = await complete(rep, b1);
    expect(last.body.enrollment).toMatchObject({ status: 'completed', progressPercent: 100 });
    expect(last.body.enrollment.completedAt).not.toBeNull();

    expect(await types()).toEqual([
      'lesson.started',
      'lesson.completed',
      'enrollment.progressed',
      'lesson.started',
      'lesson.completed',
      'phase.completed',
      'enrollment.progressed',
      'lesson.started',
      'lesson.completed',
      'phase.completed',
      'enrollment.progressed',
      'program.completed',
    ]);
    const phaseEvents = (await h.outbox('phase.completed')).map(
      (e) => (e.payload as { phaseId: string }).phaseId,
    );
    expect(phaseEvents).toEqual([built.phases.p1, built.phases.p2]);
    const progressed = (await h.outbox('enrollment.progressed')).map(
      (e) => (e.payload as { progressPercent: number }).progressPercent,
    );
    expect(progressed).toEqual([33.3, 66.7, 100]);

    // The admin view of the enrollment agrees with the denormalised columns.
    const detail = await h.http.get(`/api/v1/enrollments/${enrollmentId}`).set(admin);
    expect(detail.body).toMatchObject({
      status: 'completed',
      progressPercent: 100,
      requiredCompleted: 3,
      requiredTotal: 3,
    });
    expect(
      detail.body.lessons.filter((l: { state: string }) => l.state === 'completed'),
    ).toHaveLength(3);
    const row = await h.db
      .selectFrom('enrollments')
      .selectAll()
      .where('id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    expect(row.current_lesson_id).toBeNull();
    expect(Number(row.progress_percent)).toBe(100);
  });

  it('does not let one learner open another learner’s lessons', async () => {
    const built = await buildProgram(h, admin, {
      title: 'Private Program',
      phases: [{ key: 'p1', lessons: [{ key: 'a', type: 'article' }] }],
    });
    await enroll(h, admin, built.id, ['jordan']);
    const stranger = await h.as('devon');
    expect(
      (await h.http.get(`/api/v1/learning/me/lessons/${built.lessons.a}`).set(stranger)).status,
    ).toBe(404);
    expect(
      (await h.http.get(`/api/v1/learning/me/programs/${built.id}/outline`).set(stranger)).status,
    ).toBe(404);
  });
});

describe('manual completion', () => {
  it('is refused for lesson types that complete through another service or a reviewer', async () => {
    const built = await buildProgram(h, admin, {
      title: 'Manual Program',
      settings: { navigationMode: 'free' },
      phases: [
        {
          key: 'p1',
          lessons: [
            { key: 'quiz', type: 'quiz', config: { assessmentId: randomId() } },
            { key: 'ai', type: 'ai_simulation', config: { scenarioId: randomId(), minScore: 75 } },
            { key: 'final', type: 'final_assessment', config: { assessmentId: randomId() } },
            { key: 'task', type: 'assignment', config: { instructions: 'Write a reflection.' } },
            {
              key: 'signoff',
              type: 'manager_approval',
              config: { instructions: 'Confirm readiness.' },
            },
            {
              key: 'ack',
              type: 'acknowledgment',
              config: { statement: 'I will follow the code.' },
            },
            { key: 'video', type: 'video', config: { mediaAssetId: randomId() } },
            { key: 'doc', type: 'pdf', config: { mediaAssetId: randomId() } },
            { key: 'read', type: 'article' },
          ],
        },
      ],
    });
    await enroll(h, admin, built.id, ['kayla']);
    const rep = await h.as('kayla');
    const reasons: Record<string, string> = {
      quiz: 'pass the assessment',
      final: 'pass the assessment',
      ai: 'scores 75 or higher',
      task: 'approves it',
      signoff: 'manager completes',
      ack: 'typing your full name',
      video: 'completes automatically',
    };
    for (const [key, reason] of Object.entries(reasons)) {
      const res = await complete(rep, built.lessons[key]!);
      expect(res.status, key).toBe(422);
      expect(res.body.error.code).toBe('COMPLETION_NOT_ALLOWED');
      expect(res.body.error.message, key).toContain(reason);
      const detail = await h.http.get(`/api/v1/learning/me/lessons/${built.lessons[key]}`).set(rep);
      expect(detail.body.completion.canCompleteManually, key).toBe(false);
    }
    // Documents must be opened first; articles can be marked complete.
    const early = await complete(rep, built.lessons.doc!);
    expect(early.body.error.message).toContain('Open the document');
    await h.http.post(`/api/v1/learning/me/lessons/${built.lessons.doc}/start`).set(rep);
    expect((await complete(rep, built.lessons.doc!)).status).toBe(200);
    expect((await complete(rep, built.lessons.read!)).status).toBe(200);
  });
});

describe('lesson grants', () => {
  it('issues verifiable grants for unlocked lessons only', async () => {
    const mediaId = randomId();
    const docId = randomId();
    const assessmentId = randomId();
    const scenarioId = randomId();
    const built = await buildProgram(h, admin, {
      title: 'Grant Program',
      phases: [
        {
          key: 'p1',
          lessons: [
            {
              key: 'video',
              type: 'video',
              config: { mediaAssetId: mediaId, allowSkipping: false, maxCreditedPlaybackRate: 1.5 },
            },
            { key: 'doc', type: 'pdf', config: { mediaAssetId: docId } },
            { key: 'quiz', type: 'quiz', config: { assessmentId } },
            { key: 'ai', type: 'scenario', config: { scenarioId, minScore: 80 } },
          ],
        },
      ],
    });
    const [{ enrollmentId }] = (await enroll(h, admin, built.id, ['isaiah'])).items as [
      { enrollmentId: string },
    ];
    const rep = await h.as('isaiah');
    const open = async (key: string) =>
      (await h.http.get(`/api/v1/learning/me/lessons/${built.lessons[key]}`).set(rep)).body;

    const video = await open('video');
    expect(video.state).toBe('available');
    const grant = await verifyLessonGrant(video.grant.token, TEST_INTERNAL_SECRET);
    expect(grant).toMatchObject({
      userId: PEOPLE.isaiah.id,
      programId: built.id,
      enrollmentId,
      lessonId: built.lessons.video,
      resource: { type: 'media', id: mediaId },
      // 90 is the program default watch percentage; the lesson did not set its own. The keys are
      // the ones media-service reads (allowSkipping is sent as allowSeekAhead).
      policy: { minWatchPercent: 90, allowSeekAhead: false, maxCreditedPlaybackRate: 1.5 },
    });
    expect(grant.policy).not.toHaveProperty('allowSkipping');
    expect(grant.policy).not.toHaveProperty('completion');
    expect(video.grant.resource).toEqual({ type: 'media', id: mediaId });
    expect(new Date(video.grant.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Later lessons are locked, so they come without a grant.
    for (const key of ['doc', 'quiz', 'ai']) {
      const locked = await open(key);
      expect(locked.state, key).toBe('locked');
      expect(locked.grant, key).toBeNull();
    }
    // A forged or expired token never verifies.
    await expect(
      verifyLessonGrant(`${video.grant.token}x`, TEST_INTERNAL_SECRET),
    ).rejects.toThrow();
    await expect(
      verifyLessonGrant(video.grant.token, 'another-secret-another-secret-123456'),
    ).rejects.toThrow();

    // Completing the video unlocks the document, then the assessment and the AI scenario.
    await h.consume(
      h.envelope((await import('@a5/events')).mediaEvents.videoCompleted, {
        assetId: mediaId,
        userId: PEOPLE.isaiah.id,
        contextType: 'lesson',
        contextId: built.lessons.video!,
        watchedPercent: 100,
        watchedSeconds: 300,
        durationSeconds: 300,
      }),
    );
    const doc = await open('doc');
    expect(doc.state).toBe('available');
    expect((await verifyLessonGrant(doc.grant.token, TEST_INTERNAL_SECRET)).resource).toEqual({
      type: 'document',
      id: docId,
    });
    await h.http.post(`/api/v1/learning/me/lessons/${built.lessons.doc}/start`).set(rep);
    await complete(rep, built.lessons.doc!);

    const quiz = await open('quiz');
    expect((await verifyLessonGrant(quiz.grant.token, TEST_INTERNAL_SECRET)).resource).toEqual({
      type: 'assessment',
      id: assessmentId,
    });
    await h.consume(
      h.envelope(assessmentEvents.attemptGraded, {
        attemptId: randomId(),
        assessmentId,
        assessmentTitle: 'Check',
        kind: 'quiz',
        userId: PEOPLE.isaiah.id,
        attemptNumber: 1,
        scorePercent: 90,
        passed: true,
        passingPercent: 80,
        gradedAt: new Date().toISOString(),
        overridden: false,
        context: { lessonId: built.lessons.quiz!, programId: built.id, enrollmentId },
        questionResults: [],
      }),
    );
    const ai = await open('ai');
    expect(ai.state).toBe('available');
    const aiGrant = await verifyLessonGrant(ai.grant.token, TEST_INTERNAL_SECRET);
    expect(aiGrant.resource).toEqual({ type: 'ai_scenario', id: scenarioId });
    expect(aiGrant.policy).toMatchObject({ minScore: 80 });
  });
});

describe('video grant policy', () => {
  it('maps lesson settings onto the policy keys media-service reads', async () => {
    const mediaId = randomId();
    const built = await buildProgram(h, admin, {
      title: 'Seekable Video Program',
      phases: [
        {
          key: 'p1',
          lessons: [
            {
              key: 'video',
              type: 'video',
              config: { mediaAssetId: mediaId, allowSkipping: true, minWatchPercent: 80 },
            },
          ],
        },
      ],
    });
    await enroll(h, admin, built.id, ['ethan']);
    const detail = await h.http
      .get(`/api/v1/learning/me/lessons/${built.lessons.video}`)
      .set(await h.as('ethan'));
    expect(detail.body.grant.resource).toEqual({ type: 'media', id: mediaId });
    expect(detail.body.grant.policy).toEqual({
      minWatchPercent: 80,
      allowSeekAhead: true,
      maxCreditedPlaybackRate: 2,
    });
    const verified = await verifyLessonGrant(detail.body.grant.token, TEST_INTERNAL_SECRET);
    expect(verified.policy).toEqual({
      minWatchPercent: 80,
      allowSeekAhead: true,
      maxCreditedPlaybackRate: 2,
    });
  });
});

describe('rule-based unlocking', () => {
  it('opens Week 2 only when Week 1 is done, the quiz reaches 80 and the AI role-play reaches 75', async () => {
    const quizId = randomId();
    const scenarioId = randomId();
    const built = await buildProgram(h, admin, {
      title: 'Rule Program',
      // Free navigation: only the explicit rule gates Week 2.
      settings: { navigationMode: 'free' },
      phases: [
        {
          key: 'w1',
          title: 'Foundations',
          lessons: [
            { key: 'read', type: 'article', title: 'Foundations reading' },
            // Passing the quiz lesson (70) is easier than the thresholds Week 2 asks for.
            {
              key: 'quiz',
              type: 'quiz',
              title: 'Foundations quiz',
              config: { assessmentId: quizId },
            },
            {
              key: 'ai',
              type: 'ai_simulation',
              title: 'Busy homeowner',
              config: { scenarioId, minScore: 70 },
            },
          ],
        },
        {
          key: 'w2',
          title: 'Execution',
          unlockRule: (b) => ({
            type: 'all',
            rules: [
              { type: 'phase_completed', phaseId: b.phases.w1! },
              { type: 'assessment_score', assessmentId: quizId, minPercent: 80 },
              { type: 'ai_scenario_score', scenarioId, minScore: 75 },
            ],
          }),
          lessons: [{ key: 'w2read', type: 'article', title: 'Execution reading' }],
        },
      ],
    });
    const [{ enrollmentId }] = (await enroll(h, admin, built.id, ['jasmine'])).items as [
      { enrollmentId: string },
    ];
    const rep = await h.as('jasmine');
    const week2 = async () => (await outline(h, rep, built.id)).phases[1]!;
    const grade = (score: number, passed: boolean, attempt: number, at = new Date()) =>
      h.consume(
        h.envelope(assessmentEvents.attemptGraded, {
          attemptId: randomId(),
          assessmentId: quizId,
          assessmentTitle: 'Foundations quiz',
          kind: 'quiz',
          userId: PEOPLE.jasmine.id,
          attemptNumber: attempt,
          scorePercent: score,
          passed,
          passingPercent: 70,
          gradedAt: at.toISOString(),
          overridden: false,
          context: { lessonId: built.lessons.quiz!, programId: built.id, enrollmentId },
          questionResults: [],
        }),
      );
    const rolePlay = (score: number) =>
      h.consume(
        h.envelope(aiEvents.scoreGenerated, {
          sessionId: randomId(),
          scenarioId,
          scenarioTitle: 'The Busy Homeowner',
          scenarioCategory: 'Brush-off',
          difficulty: 'beginner',
          userId: PEOPLE.jasmine.id,
          overallScore: score,
          passed: score >= 70,
          passingScore: 70,
          categoryScores: [],
          context: { lessonId: built.lessons.ai!, programId: built.id, enrollmentId },
          evaluatedAt: new Date().toISOString(),
          promptVersionId: randomId(),
          rubricVersionId: randomId(),
        }),
      );

    let w = await week2();
    expect(w.state).toBe('locked');
    expect(w.requirements.map((r) => [r.description, r.satisfied])).toEqual([
      ['Complete Week 1: Foundations', false],
      ['Score 80% or higher on "Foundations quiz"', false],
      ['Score 75 or higher on "Busy homeowner"', false],
    ]);

    // Week 1 lessons done, but the scores clear the lessons' own pass marks, not the Week 2 thresholds.
    await complete(rep, built.lessons.read!);
    await grade(78, true, 1);
    await rolePlay(72);
    w = await week2();
    expect(w.state).toBe('locked');
    expect(w.requirements.map((r) => [r.satisfied, r.progress])).toEqual([
      [true, { current: 1, target: 1, unit: 'boolean' }],
      [false, { current: 78, target: 80, unit: 'percent' }],
      [false, { current: 72, target: 75, unit: 'percent' }],
    ]);
    expect((await outline(h, rep, built.id)).phases[0]!.state).toBe('completed');
    const locked = await h.http.get(`/api/v1/learning/me/lessons/${built.lessons.w2read}`).set(rep);
    expect(locked.body.state).toBe('locked');
    expect(locked.body.requirements.length).toBeGreaterThan(0);

    // Meeting only one of the two score thresholds is still not enough.
    await grade(86, true, 2);
    w = await week2();
    expect(w.state).toBe('locked');
    expect(w.requirements.filter((r) => !r.satisfied).map((r) => r.description)).toEqual([
      'Score 75 or higher on "Busy homeowner"',
    ]);

    await rolePlay(77);
    w = await week2();
    expect(w.state).toBe('available');
    expect(w.requirements).toEqual([]);
    expect(
      (await h.http.get(`/api/v1/learning/me/lessons/${built.lessons.w2read}`).set(rep)).body.state,
    ).toBe('available');

    // Thresholds are rule parameters: raising one re-locks Week 2 after the next publish.
    await h.http
      .patch(`/api/v1/programs/${built.id}/phases/${built.phases.w2}`)
      .set(admin)
      .send({
        unlockRule: {
          type: 'all',
          rules: [{ type: 'assessment_score', assessmentId: quizId, minPercent: 90 }],
        },
      });
    await h.http
      .post(`/api/v1/programs/${built.id}/publish`)
      .set(admin)
      .send({ changeNote: 'Raise the quiz bar to 90' });
    w = await week2();
    expect(w.state).toBe('locked');
    expect(w.requirements[0]!.description).toBe('Score 90% or higher on "Foundations quiz"');
    expect(w.requirements[0]!.progress).toEqual({ current: 86, target: 90, unit: 'percent' });
  });
});

describe('acknowledgments', () => {
  it('require the learner’s full name and are recorded immutably', async () => {
    const statement = 'I have read and will follow the A5 Sales Code of Conduct.';
    const built = await buildProgram(h, admin, {
      title: 'Ack Program',
      phases: [
        {
          key: 'p1',
          lessons: [
            { key: 'ack', type: 'acknowledgment', config: { statement } },
            { key: 'next', type: 'article' },
          ],
        },
      ],
    });
    await enroll(h, admin, built.id, ['colton']);
    const rep = await h.as('colton');
    const url = `/api/v1/learning/me/lessons/${built.lessons.ack}/acknowledge`;

    for (const typedName of ['Colton', 'Hayes', 'Colt Hayes', 'Colton Hays', 'Someone Else']) {
      const res = await h.http.post(url).set(rep).send({ typedName });
      expect(res.status, typedName).toBe(422);
      expect(res.body.error.code).toBe('NAME_MISMATCH');
      expect(res.body.error.message).toContain('Colton Hayes');
    }
    expect((await h.http.post(url).set(rep).send({ typedName: '   ' })).status).toBe(400);
    expect(await h.db.selectFrom('acknowledgments').selectAll().execute()).toHaveLength(0);
    expect(
      (await h.http.get(`/api/v1/learning/me/lessons/${built.lessons.next}`).set(rep)).body.state,
    ).toBe('locked');

    const ok = await h.http.post(url).set(rep).send({ typedName: '  colton   HAYES ' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ lessonId: built.lessons.ack, typedName: 'colton HAYES' });
    expect(ok.body.statementHash).toMatch(/^[0-9a-f]{64}$/);

    const stored = await h.db.selectFrom('acknowledgments').selectAll().executeTakeFirstOrThrow();
    expect(stored.statement_text).toBe(statement);
    expect(stored.user_id).toBe(PEOPLE.colton.id);
    await expect(
      h.db.updateTable('acknowledgments').set({ typed_name: 'Forged Name' }).execute(),
    ).rejects.toThrow(/immutable/);
    await expect(h.db.deleteFrom('acknowledgments').execute()).rejects.toThrow(/immutable/);

    // The lesson is complete, the next one is open, and repeating the request is harmless.
    expect(
      (await h.http.get(`/api/v1/learning/me/lessons/${built.lessons.next}`).set(rep)).body.state,
    ).toBe('available');
    const detail = await h.http.get(`/api/v1/learning/me/lessons/${built.lessons.ack}`).set(rep);
    expect(detail.body).toMatchObject({
      state: 'completed',
      acknowledgment: { typedName: 'colton HAYES' },
      progress: { completionSource: 'acknowledgment' },
    });
    const again = await h.http.post(url).set(rep).send({ typedName: 'Colton Hayes' });
    expect(again.body.id).toBe(ok.body.id);
    expect(await h.db.selectFrom('acknowledgments').selectAll().execute()).toHaveLength(1);
    expect(
      (await h.outbox('lesson.completed')).filter(
        (e) => (e.payload as { lessonId: string }).lessonId === built.lessons.ack,
      ),
    ).toHaveLength(1);
  });
});

describe('notes', () => {
  it('lets a learner keep private notes with optional video timestamps', async () => {
    const built = await buildProgram(h, admin, {
      title: 'Notes Program',
      phases: [{ key: 'p1', lessons: [{ key: 'a', type: 'article' }] }],
    });
    await enroll(h, admin, built.id, ['ethan']);
    const rep = await h.as('ethan');
    const base = `/api/v1/learning/me/lessons/${built.lessons.a}/notes`;
    const note = await h.http
      .post(base)
      .set(rep)
      .send({ body: 'Ask about ridge vent spacing', videoTimestampSeconds: 95 });
    expect(note.status).toBe(201);
    expect(note.body).toMatchObject({
      body: 'Ask about ridge vent spacing',
      videoTimestampSeconds: 95,
    });
    expect((await h.http.post(base).set(rep).send({ body: '   ' })).status).toBe(400);
    const edited = await h.http
      .patch(`/api/v1/learning/me/notes/${note.body.id}`)
      .set(rep)
      .send({ body: 'Ridge vent spacing: ask Hector' });
    expect(edited.body.body).toBe('Ridge vent spacing: ask Hector');
    expect(
      (await h.http.get(`/api/v1/learning/me/lessons/${built.lessons.a}`).set(rep)).body.notes,
    ).toHaveLength(1);
    // Nobody else can read or change it.
    expect(
      (
        await h.http
          .patch(`/api/v1/learning/me/notes/${note.body.id}`)
          .set(await h.as('darius'))
          .send({ body: 'hijack' })
      ).status,
    ).toBe(404);
    expect(
      (await h.http.delete(`/api/v1/learning/me/notes/${note.body.id}`).set(rep)).body,
    ).toEqual({ ok: true });
    expect((await h.http.get(base).set(rep)).body.items).toHaveLength(0);
  });
});

describe('dashboard', () => {
  it('summarises enrollments, the next lesson and remaining time', async () => {
    const built = await buildProgram(h, admin, {
      title: 'Dashboard Program',
      phases: [
        {
          key: 'p1',
          title: 'Intro',
          lessons: [
            { key: 'a', type: 'article', title: 'Warm-up', estimatedMinutes: 10 },
            { key: 'b', type: 'article', title: 'Deep dive', estimatedMinutes: 20 },
          ],
        },
      ],
    });
    await enroll(h, admin, built.id, ['darius']);
    const rep = await h.as('darius');
    const mine = await h.http.get('/api/v1/learning/me/enrollments').set(rep);
    expect(mine.status).toBe(200);
    expect(mine.body.items[0]).toMatchObject({
      program: { title: 'Dashboard Program', phaseCount: 1 },
      nextLesson: { id: built.lessons.a, title: 'Warm-up', phaseTitle: 'Intro' },
      estimatedRemainingMinutes: 30,
      progressPercent: 0,
      currentPhase: { title: 'Intro', label: 'Week 1' },
    });
    const next = await h.http.get('/api/v1/learning/me/continue').set(rep);
    expect(next.body.item).toMatchObject({
      program: { title: 'Dashboard Program' },
      lesson: { id: built.lessons.a, state: 'available' },
    });
    await complete(rep, built.lessons.a!);
    const after = await h.http.get('/api/v1/learning/me/enrollments').set(rep);
    expect(after.body.items[0]).toMatchObject({
      estimatedRemainingMinutes: 20,
      nextLesson: { id: built.lessons.b },
    });
    await complete(rep, built.lessons.b!);
    expect((await h.http.get('/api/v1/learning/me/continue').set(rep)).body.item).toBeNull();
    expect(
      (await h.http.get('/api/v1/learning/me/enrollments').set(rep)).body.items[0],
    ).toMatchObject({ status: 'completed', progressPercent: 100, nextLesson: null });
  });
});
