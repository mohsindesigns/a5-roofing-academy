import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiEvents, assessmentEvents, certificationEvents, learningEvents } from '@a5/events';
import { CERTIFICATION, PEOPLE, PHASES, PROGRAM, SCENARIOS, allLessons, seedId } from '@a5/seed-data';
import { stableId } from '../src/common/ids.js';
import { FactsConsumer } from '../src/facts/facts.consumer.js';
import { createAnalyticsHarness, evt, type AnalyticsHarness } from './harness.js';

let h: AnalyticsHarness;
let consumer: FactsConsumer;

beforeAll(async () => {
  h = await createAnalyticsHarness('events');
  consumer = h.app.get(FactsConsumer, { strict: false });
});
afterAll(() => h?.close());

const lessons = allLessons();
const welcome = lessons.find((l) => l.key === 'w1-welcome')!;
const trust = lessons.find((l) => l.key === 'w1-trust')!;
const phase1 = PHASES[0]!;

const ref = (n: string, person: keyof typeof PEOPLE = 'marcus') => ({
  enrollmentId: seedId(`test-enrollment:${n}`),
  programId: PROGRAM.id,
  userId: PEOPLE[person].id,
});

function enrolled(r: ReturnType<typeof ref>, at: string, dueAt: string | null = '2026-09-29T14:00:00Z') {
  return evt(learningEvents.enrolled, { ...r, programTitle: PROGRAM.title, assignedBy: PEOPLE.danielle.id, dueAt, source: 'manual' }, at, `enrolled:${r.enrollmentId}`);
}

function lessonDone(r: ReturnType<typeof ref>, lesson: (typeof lessons)[number], at: string, key = `${r.enrollmentId}:${lesson.key}`) {
  return evt(
    learningEvents.lessonCompleted,
    {
      ...r,
      phaseId: phase1.id,
      moduleId: phase1.modules[0]!.id,
      lessonId: lesson.id,
      lessonType: lesson.type,
      lessonTitle: lesson.title,
      required: true,
      source: 'learner',
      completedAt: at,
    },
    at,
    `lesson:${key}`,
  );
}

const progressed = (r: ReturnType<typeof ref>, at: string, percent: number, done: number) =>
  evt(learningEvents.enrollmentProgressed, { ...r, progressPercent: percent, requiredCompleted: done, requiredTotal: 8, currentPhaseId: phase1.id }, at, `progress:${r.enrollmentId}:${at}`);

const enrollmentRow = (id: string) => h.db.selectFrom('fact_enrollments').selectAll().where('enrollment_id', '=', id).executeTakeFirstOrThrow();

describe('learning facts', () => {
  it('builds an enrollment from enrolled, lesson, progress and completion events', async () => {
    const r = ref('full');
    await consumer.onEnrolled(enrolled(r, '2026-09-01T14:00:00Z'));
    await consumer.onLessonStarted(evt(learningEvents.lessonStarted, { ...r, lessonId: welcome.id, lessonType: welcome.type }, '2026-09-01T14:30:00Z', 'started:full'));
    await consumer.onLessonCompleted(lessonDone(r, welcome, '2026-09-01T15:00:00Z'));
    await consumer.onProgressed(progressed(r, '2026-09-01T15:00:01Z', 12.5, 1));
    await consumer.onPhaseCompleted(
      evt(learningEvents.phaseCompleted, { ...r, phaseId: phase1.id, phaseTitle: phase1.title, completedAt: '2026-09-04T16:00:00Z' }, '2026-09-04T16:00:00Z', 'phase:full'),
    );
    await consumer.onProgramCompleted(
      evt(learningEvents.programCompleted, { ...r, programTitle: PROGRAM.title, completedAt: '2026-09-20T14:00:00Z' }, '2026-09-20T14:00:00Z', 'done:full'),
    );

    const row = await enrollmentRow(r.enrollmentId);
    expect(row).toMatchObject({
      status: 'completed',
      program_title: PROGRAM.title,
      source: 'manual',
      progress_percent: 100,
      required_completed: 8,
      required_total: 8,
      overdue: false,
    });
    expect(row.enrolled_at?.toISOString()).toBe('2026-09-01T14:00:00.000Z');
    expect(row.due_at?.toISOString()).toBe('2026-09-29T14:00:00.000Z');
    expect(row.completed_at?.toISOString()).toBe('2026-09-20T14:00:00.000Z');
    expect(row.last_activity_at?.toISOString()).toBe('2026-09-20T14:00:00.000Z');

    const lesson = await h.db.selectFrom('fact_lesson_events').selectAll().where('enrollment_id', '=', r.enrollmentId).executeTakeFirstOrThrow();
    expect(lesson).toMatchObject({ lesson_id: welcome.id, lesson_type: 'video', phase_id: phase1.id, required: true });
    expect(lesson.started_at?.toISOString()).toBe('2026-09-01T14:30:00.000Z');
    expect(lesson.completed_at?.toISOString()).toBe('2026-09-01T15:00:00.000Z');
    const phase = await h.db.selectFrom('fact_phase_completions').selectAll().where('enrollment_id', '=', r.enrollmentId).executeTakeFirstOrThrow();
    expect(phase.phase_title).toBe(phase1.title);
    const feed = await h.db.selectFrom('fact_activity').select('kind').where('user_id', '=', r.userId).execute();
    expect(feed.map((f) => f.kind).sort()).toEqual(['enrolled', 'lesson_completed', 'phase_completed', 'program_completed']);
  });

  it('is idempotent on redelivery and does not duplicate facts from distinct events', async () => {
    const r = ref('dupes', 'tyler');
    const events = [
      enrolled(r, '2026-09-02T14:00:00Z'),
      lessonDone(r, welcome, '2026-09-02T15:00:00Z'),
      progressed(r, '2026-09-02T15:00:01Z', 12.5, 1),
    ];
    for (const e of events) expect(await consumer[e.type === 'program.enrolled' ? 'onEnrolled' : e.type === 'lesson.completed' ? 'onLessonCompleted' : 'onProgressed'](e)).toBe(true);
    // Same envelopes delivered again (stream redelivery) are skipped entirely.
    for (const e of events) expect(await consumer[e.type === 'program.enrolled' ? 'onEnrolled' : e.type === 'lesson.completed' ? 'onLessonCompleted' : 'onProgressed'](e)).toBe(false);

    // A different event describing the same completion (new id, later timestamp) keeps the first one.
    expect(await consumer.onLessonCompleted(lessonDone(r, welcome, '2026-09-02T18:00:00Z', 'again'))).toBe(true);

    expect(await h.db.selectFrom('fact_enrollments').select('enrollment_id').where('enrollment_id', '=', r.enrollmentId).execute()).toHaveLength(1);
    const completions = await h.db.selectFrom('fact_lesson_events').select('completed_at').where('enrollment_id', '=', r.enrollmentId).execute();
    expect(completions).toHaveLength(1);
    expect(completions[0]!.completed_at?.toISOString()).toBe('2026-09-02T15:00:00.000Z');
    const feed = await h.db.selectFrom('fact_activity').select('occurred_at').where('user_id', '=', r.userId).where('kind', '=', 'lesson_completed').execute();
    expect(feed).toHaveLength(1);
    expect(feed[0]!.occurred_at.toISOString()).toBe('2026-09-02T15:00:00.000Z');
    const inbox = await h.db.selectFrom('inbox_events').select('event_id').where('handler', '=', 'analytics.program.enrolled').where('event_id', '=', events[0]!.id).execute();
    expect(inbox).toHaveLength(1);
  });

  it('accepts progress, lesson and overdue events before the enrollment event', async () => {
    const r = ref('early', 'kayla');
    await consumer.onProgressed(progressed(r, '2026-09-10T10:00:00Z', 25, 2));
    await consumer.onLessonCompleted(lessonDone(r, trust, '2026-09-10T09:55:00Z'));
    await consumer.onOverdue(
      evt(learningEvents.enrollmentOverdue, { ...r, programTitle: PROGRAM.title, dueAt: '2026-09-29T14:00:00Z', progressPercent: 25 }, '2026-09-29T15:00:00Z', 'overdue:early'),
    );
    const placeholder = await enrollmentRow(r.enrollmentId);
    expect(placeholder).toMatchObject({ status: 'active', progress_percent: 25, overdue: true, enrolled_at: null });

    await consumer.onEnrolled(enrolled(r, '2026-09-01T14:00:00Z', null));
    const row = await enrollmentRow(r.enrollmentId);
    expect(row.enrolled_at?.toISOString()).toBe('2026-09-01T14:00:00.000Z');
    expect(row.first_seen_at.toISOString()).toBe('2026-09-01T14:00:00.000Z');
    // Enrolment arriving late neither resets progress nor erases the due date the overdue notice carried.
    expect(row).toMatchObject({ progress_percent: 25, required_completed: 2, overdue: true, program_title: PROGRAM.title });
    expect(row.due_at?.toISOString()).toBe('2026-09-29T14:00:00.000Z');
    expect(row.last_activity_at?.toISOString()).toBe('2026-09-10T09:55:00.000Z');
  });

  it('keeps the newest progress and the latest status when events are reordered', async () => {
    const r = ref('order', 'jordan');
    await consumer.onProgressed(progressed(r, '2026-09-12T10:00:00Z', 60, 5));
    await consumer.onProgressed(progressed(r, '2026-09-11T10:00:00Z', 30, 2));
    expect(await enrollmentRow(r.enrollmentId)).toMatchObject({ progress_percent: 60, required_completed: 5 });

    // Withdrawn on the 15th, delivered before the enrollment from the 1st.
    await consumer.onWithdrawn(evt(learningEvents.enrollmentWithdrawn, r, '2026-09-15T10:00:00Z', 'withdrawn:order'));
    await consumer.onEnrolled(enrolled(r, '2026-09-01T14:00:00Z'));
    expect(await enrollmentRow(r.enrollmentId)).toMatchObject({ status: 'withdrawn' });

    // A completion that happened before the withdrawal does not resurrect the enrollment.
    await consumer.onProgramCompleted(
      evt(learningEvents.programCompleted, { ...r, programTitle: PROGRAM.title, completedAt: '2026-09-14T10:00:00Z' }, '2026-09-14T10:00:00Z', 'done:order'),
    );
    const row = await enrollmentRow(r.enrollmentId);
    expect(row.status).toBe('withdrawn');
    expect(row.completed_at?.toISOString()).toBe('2026-09-14T10:00:00.000Z');
  });

  it('clears the overdue flag on completion, whichever event arrives first', async () => {
    const overdue = (r: ReturnType<typeof ref>, key: string) =>
      evt(learningEvents.enrollmentOverdue, { ...r, programTitle: PROGRAM.title, dueAt: '2026-09-29T14:00:00Z', progressPercent: 40 }, '2026-09-29T15:00:00Z', key);
    const done = (r: ReturnType<typeof ref>, key: string) =>
      evt(learningEvents.programCompleted, { ...r, programTitle: PROGRAM.title, completedAt: '2026-10-02T14:00:00Z' }, '2026-10-02T14:00:00Z', key);

    const late = ref('overdue-then-done', 'ethan');
    await consumer.onEnrolled(enrolled(late, '2026-09-01T14:00:00Z'));
    await consumer.onOverdue(overdue(late, 'od:1'));
    expect((await enrollmentRow(late.enrollmentId)).overdue).toBe(true);
    await consumer.onProgramCompleted(done(late, 'done:1'));
    expect(await enrollmentRow(late.enrollmentId)).toMatchObject({ status: 'completed', overdue: false });

    // Delivered the other way round, the older overdue notice must not flag a completed enrollment.
    const reversed = ref('done-then-overdue', 'darius');
    await consumer.onEnrolled(enrolled(reversed, '2026-09-01T14:00:00Z'));
    await consumer.onProgramCompleted(done(reversed, 'done:2'));
    await consumer.onOverdue(overdue(reversed, 'od:2'));
    expect(await enrollmentRow(reversed.enrollmentId)).toMatchObject({ status: 'completed', overdue: false });
  });

  it('ignores events that carry no organization', async () => {
    const r = ref('orgless', 'devon');
    const e = { ...enrolled(r, '2026-09-03T14:00:00Z'), organizationId: null };
    expect(await consumer.onEnrolled(e)).toBe(false);
    expect(await h.db.selectFrom('fact_enrollments').select('enrollment_id').where('enrollment_id', '=', r.enrollmentId).execute()).toHaveLength(0);
  });
});

describe('program dimension', () => {
  it('stores the published outline, ignores older versions and flags removed lessons', async () => {
    const outline = lessons.map((l, i) => ({
      lessonId: l.id,
      phaseId: PHASES.find((p) => p.key === l.phaseKey)!.id,
      moduleId: PHASES.flatMap((p) => p.modules).find((m) => m.key === l.moduleKey)!.id,
      title: l.title,
      type: l.type,
      position: i + 1,
      required: l.required,
    }));
    const publish = (version: number, subset: typeof outline, at: string, key = `publish:${version}`) =>
      evt(
        learningEvents.programPublished,
        {
          programId: PROGRAM.id,
          title: version === 1 ? PROGRAM.title : `${PROGRAM.title} (v${version})`,
          version,
          phases: PHASES.map((p, i) => ({ phaseId: p.id, title: p.title, position: i + 1 })),
          requiredLessonIds: subset.filter((l) => l.required).map((l) => l.lessonId),
          assessments: [{ assessmentId: seedId('assessment:quiz-w1'), lessonId: welcome.id, kind: 'quiz', required: true, title: 'Week 1 Knowledge Check' }],
          aiScenarios: [{ scenarioId: SCENARIOS[0]!.id, lessonId: trust.id, minScore: 75 }],
          lessons: subset,
        },
        at,
        key,
      );
    await h.apply(publish(1, outline, '2026-07-01T10:00:00Z'));
    await h.apply(publish(2, outline.slice(0, 10), '2026-08-01T10:00:00Z'));
    // An older publish delivered again under a new event id must not roll the dimension back.
    await h.apply(publish(1, outline, '2026-07-01T10:00:00Z', 'publish:1:late'));
    const program = await h.db.selectFrom('dim_programs').selectAll().where('id', '=', PROGRAM.id).executeTakeFirstOrThrow();
    expect(program).toMatchObject({ title: `${PROGRAM.title} (v2)`, version: 2, required_lesson_count: 10, archived: false });
    const live = await h.db.selectFrom('dim_lessons').select(['id', 'position', 'in_program']).where('program_id', '=', PROGRAM.id).orderBy('position').execute();
    expect(live.filter((l) => l.in_program)).toHaveLength(10);
    expect(live.filter((l) => !l.in_program).length).toBeGreaterThan(0);
    const phases = await h.db.selectFrom('dim_phases').select(['title', 'position']).where('program_id', '=', PROGRAM.id).orderBy('position').execute();
    expect(phases.map((p) => p.title)).toEqual(PHASES.map((p) => p.title));
    expect(await h.db.selectFrom('dim_assessments').select('title').where('program_id', '=', PROGRAM.id).execute()).toHaveLength(1);

    await h.apply(evt(learningEvents.programArchived, { programId: PROGRAM.id }, '2026-09-01T10:00:00Z', 'archived'));
    expect((await h.db.selectFrom('dim_programs').select('archived').where('id', '=', PROGRAM.id).executeTakeFirstOrThrow()).archived).toBe(true);
  });
});

describe('events without the optional detail', () => {
  it('derives required lessons from the published ids when no outline is sent', async () => {
    const programId = seedId('test-program:minimal');
    const a = { id: seedId('test-lesson:minimal:1') };
    const b = { id: seedId('test-lesson:minimal:2') };
    await h.apply(
      evt(
        learningEvents.programPublished,
        {
          programId,
          title: 'Storm Response Basics',
          version: 1,
          phases: [{ phaseId: seedId('test-phase:minimal'), title: 'Week 1', position: 1 }],
          requiredLessonIds: [a.id, b.id],
          assessments: [],
          aiScenarios: [],
        },
        '2026-07-01T10:00:00Z',
        'publish:minimal',
      ),
    );
    expect(await h.db.selectFrom('dim_programs').select(['title', 'required_lesson_count']).where('id', '=', programId).executeTakeFirstOrThrow()).toEqual({
      title: 'Storm Response Basics',
      required_lesson_count: 2,
    });
    const rows = await h.db.selectFrom('dim_lessons').select(['id', 'required', 'title']).where('program_id', '=', programId).orderBy('id').execute();
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(rows.every((r) => r.required === true && r.title === null)).toBe(true);
  });

  it('stores question results that carry no prompt or category name', async () => {
    const attemptId = seedId('test-attempt:bare');
    await h.apply(
      evt(
        assessmentEvents.attemptGraded,
        {
          attemptId,
          assessmentId: seedId('assessment:quiz-w2'),
          assessmentTitle: 'Week 2 Knowledge Check',
          kind: 'quiz',
          userId: PEOPLE.jordan.id,
          attemptNumber: 1,
          scorePercent: 50,
          passed: false,
          passingPercent: 80,
          gradedAt: '2026-09-07T10:00:00Z',
          overridden: false,
          context: {},
          questionResults: [
            { questionId: seedId('question:bare:1'), questionVersionId: seedId('question-version:bare:1'), categoryId: null, correct: false, awardedPoints: 0, possiblePoints: 1 },
          ],
        },
        '2026-09-07T10:00:00Z',
        'bare',
      ),
    );
    expect(await h.db.selectFrom('fact_question_results').select(['category_id', 'correct']).where('attempt_id', '=', attemptId).execute()).toEqual([{ category_id: null, correct: false }]);
    expect(await h.db.selectFrom('dim_questions').select(['prompt', 'category_id']).where('id', '=', seedId('question:bare:1')).executeTakeFirstOrThrow()).toEqual({ prompt: null, category_id: null });
    expect(await h.db.selectFrom('fact_assessment_attempts').select(['program_id', 'enrollment_id']).where('attempt_id', '=', attemptId).executeTakeFirstOrThrow()).toEqual({ program_id: null, enrollment_id: null });
  });
});

describe('assessment facts', () => {
  const attemptEvent = (attemptId: string, at: string, score: number, passed: boolean, overridden: boolean, q1: boolean, key: string) =>
    evt(
      assessmentEvents.attemptGraded,
      {
        attemptId,
        assessmentId: seedId('assessment:quiz-w1'),
        assessmentTitle: 'Week 1 Knowledge Check',
        kind: 'quiz',
        userId: PEOPLE.marcus.id,
        attemptNumber: 1,
        scorePercent: score,
        passed,
        passingPercent: 80,
        gradedAt: at,
        overridden,
        context: { programId: PROGRAM.id, enrollmentId: seedId('test-enrollment:full'), lessonId: lessons.find((l) => l.key === 'w1-quiz')!.id },
        questionResults: [
          {
            questionId: seedId('question:quiz-w1:1'),
            questionVersionId: seedId('question-version:quiz-w1:1:1'),
            categoryId: seedId('question-category:company-culture'),
            categoryName: 'Company & culture',
            prompt: 'What is the first commitment A5 makes to every homeowner?',
            correct: q1,
            awardedPoints: q1 ? 1 : 0,
            possiblePoints: 1,
          },
          {
            questionId: seedId('question:quiz-w1:2'),
            questionVersionId: seedId('question-version:quiz-w1:2:1'),
            categoryId: seedId('question-category:company-culture'),
            categoryName: 'Company & culture',
            correct: null,
            awardedPoints: 0,
            possiblePoints: 1,
          },
        ],
      },
      at,
      key,
    );

  const rowsFor = async (attemptId: string) => ({
    attempt: await h.db.selectFrom('fact_assessment_attempts').selectAll().where('attempt_id', '=', attemptId).executeTakeFirstOrThrow(),
    questions: await h.db.selectFrom('fact_question_results').select(['question_id', 'correct']).where('attempt_id', '=', attemptId).orderBy('question_id').execute(),
    feed: await h.db.selectFrom('fact_activity').select(['kind', 'score']).where('id', '=', stableId('attempt', attemptId)).execute(),
  });

  it('keeps the latest grading, so an override replaces the automatic grade in either order', async () => {
    for (const order of ['in-order', 'reversed'] as const) {
      const attemptId = seedId(`test-attempt:${order}`);
      const auto = attemptEvent(attemptId, '2026-09-05T10:00:00Z', 60, false, false, false, `${order}:auto`);
      const override = attemptEvent(attemptId, '2026-09-05T11:00:00Z', 82, true, true, true, `${order}:override`);
      await h.apply(...(order === 'in-order' ? [auto, override] : [override, auto]));
      const { attempt, questions, feed } = await rowsFor(attemptId);
      expect(attempt).toMatchObject({ score_percent: 82, passed: true, overridden: true, attempt_number: 1, kind: 'quiz' });
      expect(attempt.graded_at.toISOString()).toBe('2026-09-05T11:00:00.000Z');
      expect(questions).toHaveLength(2);
      expect(questions.find((q) => q.question_id === seedId('question:quiz-w1:1'))!.correct).toBe(true);
      expect(feed).toEqual([{ kind: 'assessment_passed', score: 82 }]);
    }
    const categories = await h.db.selectFrom('dim_question_categories').select('name').execute();
    expect(categories).toEqual([{ name: 'Company & culture' }]);
    const question = await h.db.selectFrom('dim_questions').select(['prompt', 'category_id']).where('id', '=', seedId('question:quiz-w1:1')).executeTakeFirstOrThrow();
    expect(question.prompt).toBe('What is the first commitment A5 makes to every homeowner?');
  });

  it('stores ungraded (open-answer) questions with a null result', async () => {
    const attemptId = seedId('test-attempt:open');
    await h.apply(attemptEvent(attemptId, '2026-09-06T10:00:00Z', 90, true, false, true, 'open'));
    const { questions } = await rowsFor(attemptId);
    expect(questions.map((q) => q.correct).sort()).toEqual([null, true].sort());
  });
});

describe('ai coaching facts', () => {
  const sessionId = seedId('test-ai-session:1');
  const score = (overall: number, at: string, categories: Array<[string, string, number]>, key: string) =>
    evt(
      aiEvents.scoreGenerated,
      {
        sessionId,
        scenarioId: SCENARIOS[1]!.id,
        scenarioTitle: SCENARIOS[1]!.title,
        scenarioCategory: SCENARIOS[1]!.category,
        difficulty: SCENARIOS[1]!.difficulty,
        userId: PEOPLE.marcus.id,
        overallScore: overall,
        passed: overall >= 75,
        passingScore: 75,
        categoryScores: categories.map(([k, label, s]) => ({ key: k, label, score: s })),
        context: {},
        evaluatedAt: at,
        promptVersionId: seedId('ai-prompt-version:spouse:1'),
        rubricVersionId: seedId('ai-rubric-version:1'),
      },
      at,
      key,
    );

  it('normalises category scores and lets a later re-evaluation replace them', async () => {
    await h.apply(
      score(70, '2026-09-08T10:00:00Z', [['rapport', 'Rapport & tone', 80], ['discovery', 'Discovery questions', 60], ['value', 'Value & credibility', 70]], 'first'),
    );
    const session = await h.db.selectFrom('fact_ai_sessions').selectAll().where('session_id', '=', sessionId).executeTakeFirstOrThrow();
    expect(session).toMatchObject({ overall_score: 70, passed: false, scenario_id: SCENARIOS[1]!.id, scenario_category: SCENARIOS[1]!.category });
    const first = await h.db.selectFrom('fact_ai_category_scores').select(['category_key', 'score']).where('session_id', '=', sessionId).orderBy('category_key').execute();
    expect(first).toEqual([
      { category_key: 'discovery', score: 60 },
      { category_key: 'rapport', score: 80 },
      { category_key: 'value', score: 70 },
    ]);

    await h.apply(score(84, '2026-09-08T12:00:00Z', [['rapport', 'Rapport & tone', 90], ['discovery', 'Discovery questions', 78]], 'second'));
    // The superseded evaluation arriving late changes nothing.
    await h.apply(score(40, '2026-09-08T09:00:00Z', [['rapport', 'Rapport & tone', 40]], 'stale'));
    const after = await h.db.selectFrom('fact_ai_sessions').select(['overall_score', 'passed']).where('session_id', '=', sessionId).executeTakeFirstOrThrow();
    expect(after).toEqual({ overall_score: 84, passed: true });
    const cats = await h.db.selectFrom('fact_ai_category_scores').select(['category_key', 'score']).where('session_id', '=', sessionId).orderBy('category_key').execute();
    expect(cats).toEqual([
      { category_key: 'discovery', score: 78 },
      { category_key: 'rapport', score: 90 },
    ]);
    expect(await h.db.selectFrom('fact_activity').select('score').where('id', '=', stableId('ai', sessionId)).execute()).toEqual([{ score: 84 }]);
  });
});

describe('certificate facts', () => {
  const cert = (n: string) => ({
    certificateId: seedId(`test-certificate:${n}`),
    definitionId: CERTIFICATION.id,
    definitionName: CERTIFICATION.name,
    userId: PEOPLE.tyler.id,
  });
  const row = (id: string) => h.db.selectFrom('fact_certificates').selectAll().where('certificate_id', '=', id).executeTakeFirstOrThrow();

  it('resolves issue, revoke, expire and reissue regardless of delivery order', async () => {
    const a = cert('a');
    const issuedA = evt(certificationEvents.issued, { ...a, certificateNumber: 'A5-SALES-2026-000001', issuedAt: '2026-09-24T10:00:00Z', expiresAt: '2028-09-24T10:00:00Z', mode: 'automatic' }, '2026-09-24T10:00:00Z', 'issued:a');
    const revokedA = evt(certificationEvents.revoked, { ...a, certificateNumber: 'A5-SALES-2026-000001', reason: 'Issued in error' }, '2026-10-01T09:00:00Z', 'revoked:a');
    await h.apply(revokedA, issuedA);
    expect(await row(a.certificateId)).toMatchObject({ status: 'revoked', certificate_number: 'A5-SALES-2026-000001', revoke_reason: 'Issued in error' });
    expect((await row(a.certificateId)).issued_at?.toISOString()).toBe('2026-09-24T10:00:00.000Z');
    expect((await row(a.certificateId)).expires_at?.toISOString()).toBe('2028-09-24T10:00:00.000Z');

    const b = cert('b');
    const c = cert('c');
    await h.apply(
      evt(certificationEvents.issued, { ...b, certificateNumber: 'A5-SALES-2026-000002', issuedAt: '2026-09-25T10:00:00Z', expiresAt: '2028-09-25T10:00:00Z', mode: 'automatic' }, '2026-09-25T10:00:00Z', 'issued:b'),
      evt(certificationEvents.reissued, { ...c, originalCertificateId: b.certificateId, reason: 'Corrected legal name' }, '2026-09-26T10:00:00Z', 'reissued:c'),
      evt(certificationEvents.issued, { ...c, certificateNumber: 'A5-SALES-2026-000003', issuedAt: '2026-09-26T10:00:00Z', expiresAt: '2028-09-26T10:00:00Z', mode: 'reissue' }, '2026-09-26T10:00:00Z', 'issued:c'),
    );
    expect(await row(b.certificateId)).toMatchObject({ status: 'superseded' });
    expect(await row(c.certificateId)).toMatchObject({ status: 'issued', replaces_certificate_id: b.certificateId, certificate_number: 'A5-SALES-2026-000003' });

    const d = cert('d');
    await h.apply(
      evt(certificationEvents.expired, { ...d, expiredAt: '2026-10-02T00:00:00Z' }, '2026-10-02T00:00:00Z', 'expired:d'),
      evt(certificationEvents.issued, { ...d, certificateNumber: 'A5-SALES-2024-000009', issuedAt: '2024-10-02T00:00:00Z', expiresAt: '2026-10-02T00:00:00Z', mode: 'automatic' }, '2024-10-02T00:00:00Z', 'issued:d'),
    );
    expect(await row(d.certificateId)).toMatchObject({ status: 'expired' });
  });

  it('tracks the path from eligible to issued per person and certification', async () => {
    const user = PEOPLE.naomi.id;
    const base = { definitionId: CERTIFICATION.id, definitionName: CERTIFICATION.name, userId: user };
    await h.apply(
      evt(certificationEvents.approvalRequested, { approvalId: seedId('test-approval:1'), ...base }, '2026-09-29T15:00:00Z', 'approval'),
      evt(certificationEvents.eligible, { candidateId: seedId('test-candidate:1'), ...base, requiresApproval: true }, '2026-09-29T14:00:00Z', 'eligible'),
    );
    let candidate = await h.db.selectFrom('fact_certification_candidates').selectAll().where('user_id', '=', user).executeTakeFirstOrThrow();
    expect(candidate.eligible_at?.toISOString()).toBe('2026-09-29T14:00:00.000Z');
    expect(candidate.approval_requested_at?.toISOString()).toBe('2026-09-29T15:00:00.000Z');
    expect(candidate.first_issued_at).toBeNull();
    await h.apply(
      evt(certificationEvents.issued, { ...base, certificateId: seedId('test-certificate:naomi'), certificateNumber: 'A5-SALES-2026-000010', issuedAt: '2026-09-30T14:00:00Z', expiresAt: null, mode: 'approval' }, '2026-09-30T14:00:00Z', 'issued:naomi'),
    );
    candidate = await h.db.selectFrom('fact_certification_candidates').selectAll().where('user_id', '=', user).executeTakeFirstOrThrow();
    expect(candidate.first_issued_at?.toISOString()).toBe('2026-09-30T14:00:00.000Z');
  });
});
