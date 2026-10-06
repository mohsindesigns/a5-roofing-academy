import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assessmentEvents } from '@a5/events';
import {
  ASSESSMENTS,
  JOURNEYS,
  PEOPLE,
  PHASES,
  PROGRAM,
  SCENARIOS,
  SEED_NOW,
  TEAMS,
  allLessons,
  completedLessonKeys,
} from '@a5/seed-data';
import { outline, randomId } from './fixtures.js';
import { createLearningHarness, serviceHeaders, type LearningHarness } from './harness.js';
import { seedLearning } from '../src/seed/seed-learning.js';

let h: LearningHarness;

beforeAll(async () => {
  // The seed is dated relative to SEED_NOW; pin the clock there so attention flags are deterministic.
  vi.useFakeTimers({ toFake: ['Date'], now: SEED_NOW });
  h = await createLearningHarness('oversight', { seed: 'academy' });
});
afterAll(async () => {
  await h?.close();
  vi.useRealTimers();
});

type Row = {
  enrollmentId: string;
  learner: { id: string; displayName: string };
  attention: Array<{ code: string; message: string }>;
  progressPercent: number;
  currentPhase: { title: string } | null;
  status: string;
  overdue: boolean;
};
const team = async (who: Record<string, string>, query = '') => {
  const res = await h.http.get(`/api/v1/progress/team?pageSize=100${query}`).set(who);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as Row[];
};
const names = (rows: Row[]) => rows.map((r) => r.learner.displayName).sort();
const teamMembers = (index: number) =>
  TEAMS[index]!.members.map((m) => `${PEOPLE[m].firstName} ${PEOPLE[m].lastName}`).sort();

describe('seeded academy', () => {
  it('publishes the A5 New Hire Sales Academy with the catalogue ids and week-by-week unlock rules', async () => {
    const program = await h.http.get(`/api/v1/programs/${PROGRAM.id}`).set(await h.as('grant'));
    expect(program.status).toBe(200);
    expect(program.body).toMatchObject({
      title: PROGRAM.title,
      slug: PROGRAM.slug,
      status: 'published',
      publishedVersion: 1,
      phaseLabel: 'Week',
      hasUnpublishedChanges: false,
      publishIssues: [],
    });
    expect(program.body.counts).toMatchObject({
      phases: 4,
      lessons: allLessons().length,
      activeEnrollments: 13,
      completedEnrollments: 3,
    });
    expect(program.body.phases.map((p: { id: string }) => p.id)).toEqual(PHASES.map((p) => p.id));
    expect(program.body.audiences).toEqual([
      { kind: 'role', ref: 'sales_rep', name: 'Sales Representative' },
    ]);

    const lessons = program.body.phases.flatMap(
      (p: {
        modules: Array<{
          lessons: Array<{
            id: string;
            type: string;
            config: Record<string, unknown>;
            body: string | null;
          }>;
        }>;
      }) => p.modules.flatMap((m) => m.lessons),
    );
    expect(lessons.map((l: { id: string }) => l.id)).toEqual(allLessons().map((l) => l.id));
    for (const seed of allLessons()) {
      const lesson = lessons.find((l: { id: string }) => l.id === seed.id)!;
      expect(lesson.type).toBe(seed.type);
      if (seed.type === 'video' || seed.type === 'pdf')
        expect(lesson.config.mediaAssetId).toBeTruthy();
      if (seed.type === 'quiz' || seed.type === 'final_assessment')
        expect(lesson.config.assessmentId).toBe(ASSESSMENTS.find((a) => a.key === seed.ref)!.id);
      if (seed.type === 'ai_simulation') {
        const scenario = SCENARIOS.find((s) => s.key === seed.ref)!;
        expect(lesson.config).toMatchObject({
          scenarioId: scenario.id,
          minScore: scenario.passingScore,
        });
      }
      if (seed.type === 'article') {
        expect(lesson.body!.split(/\n\n/).length, seed.key).toBeGreaterThanOrEqual(6);
        expect(lesson.body!.length, seed.key).toBeGreaterThan(2500);
      }
    }
    // Weeks 2-4 each require the previous week's quiz; Week 4 also needs the "busy homeowner" role-play.
    const rules = program.body.phases.map((p: { unlockRule: unknown }) => p.unlockRule);
    expect(rules[0]).toBeNull();
    expect(rules[1]).toEqual({
      type: 'all',
      rules: [{ type: 'assessment_score', assessmentId: ASSESSMENTS[0]!.id, minPercent: 80 }],
    });
    expect(rules[3]).toEqual({
      type: 'all',
      rules: [
        { type: 'assessment_score', assessmentId: ASSESSMENTS[2]!.id, minPercent: 80 },
        {
          type: 'ai_scenario_score',
          scenarioId: SCENARIOS.find((s) => s.key === 'no-time')!.id,
          minScore: 75,
        },
      ],
    });
    const published = await h.outbox('program.published');
    expect(published).toHaveLength(1);
    expect(published[0]!.payload).toMatchObject({
      programId: PROGRAM.id,
      version: 1,
      assessments: ASSESSMENTS.map((a) =>
        expect.objectContaining({ assessmentId: a.id, required: true }),
      ),
    });
    expect((published[0]!.payload as { aiScenarios: unknown[] }).aiScenarios).toHaveLength(5);
  });

  it('is idempotent', async () => {
    const before = await h.db.selectFrom('enrollments').select('id').execute();
    expect((await seedLearning(h.db)).created).toBe(false);
    expect(await h.db.selectFrom('enrollments').select('id').execute()).toHaveLength(before.length);
    expect(await h.outbox('program.published')).toHaveLength(1);
  });

  it('places every learner where their journey says, with progress computed by the same evaluator', async () => {
    const admin = await h.as('priya');
    const all = (
      await h.http.get(`/api/v1/enrollments?programId=${PROGRAM.id}&pageSize=100`).set(admin)
    ).body.items as Array<{
      learner: { id: string };
      status: string;
      requiredCompleted: number;
      progressPercent: number;
    }>;
    expect(all).toHaveLength(JOURNEYS.length);
    for (const journey of JOURNEYS) {
      const row = all.find((e) => e.learner.id === PEOPLE[journey.person].id)!;
      expect(row.requiredCompleted, journey.person).toBe(
        completedLessonKeys(journey.stage).filter(
          (k) => allLessons().find((l) => l.key === k)!.required,
        ).length,
      );
      expect(row.status, journey.person).toBe(
        journey.stage === 'certified' ? 'completed' : 'active',
      );
    }
    // Stored progress agrees with a fresh evaluation through the API.
    for (const person of ['marcus', 'naomi', 'brianna', 'ashlyn'] as const) {
      const o = await outline(h, await h.as(person), PROGRAM.id);
      const stored = all.find((e) => e.learner.id === PEOPLE[person].id)!;
      expect(o.percent, person).toBe(stored.progressPercent);
    }
  });

  it('keeps Brianna’s manager sign-off pending and explains what holds other learners back', async () => {
    const brianna = await outline(h, await h.as('brianna'), PROGRAM.id);
    expect(brianna.phases.map((p) => p.state)).toEqual([
      'completed',
      'completed',
      'completed',
      'in_progress',
    ]);
    const lessons = brianna.phases[3]!.modules[1]!.lessons as Array<{ id: string; state: string }>;
    expect(
      lessons.find((l) => l.id === allLessons().find((x) => x.key === 'w4-signoff')!.id)!.state,
    ).toBe('available');
    const detail = await h.http
      .get(`/api/v1/learning/me/lessons/${allLessons().find((x) => x.key === 'w4-signoff')!.id}`)
      .set(await h.as('brianna'));
    expect(detail.body).toMatchObject({
      state: 'available',
      approval: { kind: 'manager_approval', status: 'pending' },
    });

    // Marcus is in Week 2: Week 3 states exactly what he still needs.
    const marcus = await outline(h, await h.as('marcus'), PROGRAM.id);
    expect(marcus.phases.map((p) => p.state)).toEqual([
      'completed',
      'in_progress',
      'locked',
      'locked',
    ]);
    expect(marcus.phases[2]!.requirements.map((r) => [r.description, r.satisfied])).toEqual([
      ['Complete Week 2: Roofing & Insurance Fundamentals', false],
      ['Score 80% or higher on "Week 2 Knowledge Check"', false],
    ]);
    expect(marcus.phases[2]!.requirements[0]!.progress).toEqual({
      current: 2,
      target: 6,
      unit: 'count',
    });

    // Caleb has the Week 3 practice lesson but not yet the Week 3 quiz or all role-plays.
    const caleb = await outline(h, await h.as('caleb'), PROGRAM.id);
    expect(caleb.phases[3]!.state).toBe('locked');
    expect(caleb.phases[3]!.requirements.map((r) => [r.description, r.satisfied])).toEqual([
      ['Complete Week 3: Sales Execution', false],
      ['Score 80% or higher on "Week 3 Knowledge Check"', false],
      // His 76 on the busy-homeowner role-play already clears the Week 4 threshold of 75.
      ['Score 75 or higher on "Practice: The Busy Homeowner"', true],
    ]);
  });
});

describe('manager scope', () => {
  it('shows each manager only the teams they manage', async () => {
    expect(names(await team(await h.as('danielle')))).toEqual(teamMembers(0));
    expect(names(await team(await h.as('andre')))).toEqual(teamMembers(1));
    expect(names(await team(await h.as('luis')))).toEqual(teamMembers(2));
    expect(names(await team(await h.as('meilin')))).toEqual(teamMembers(3));
    expect(await team(await h.as('priya'))).toHaveLength(16);
  });

  it('limits trainers to their assigned trainees, wherever those sit', async () => {
    const hector = names(await team(await h.as('hector')));
    expect(hector).toEqual([
      'Caleb Ramirez',
      'Devon Mitchell',
      'Ethan Kowalski',
      'Isaiah Grant',
      'Naomi Fischer',
    ]);
  });

  it('answers 404 for other managers’ teams and learners, and 403 without the permission', async () => {
    const danielle = await h.as('danielle');
    expect((await h.http.get(`/api/v1/progress/teams/${TEAMS[1].id}`).set(danielle)).status).toBe(
      404,
    );
    expect(
      (await h.http.get(`/api/v1/progress/team?teamId=${TEAMS[2].id}`).set(danielle)).status,
    ).toBe(404);
    expect((await h.http.get(`/api/v1/progress/teams/${TEAMS[0].id}`).set(danielle)).status).toBe(
      200,
    );
    expect(
      (await h.http.get(`/api/v1/progress/learners/${PEOPLE.naomi.id}`).set(danielle)).status,
    ).toBe(404);
    expect(
      (await h.http.get(`/api/v1/progress/learners/${PEOPLE.marcus.id}`).set(danielle)).status,
    ).toBe(200);
    expect(
      (await h.http.get(`/api/v1/progress/learners/${randomId()}`).set(await h.as('priya'))).status,
    ).toBe(404);
    const naomiEnrollment = (
      await h.db
        .selectFrom('enrollments')
        .select('id')
        .where('user_id', '=', PEOPLE.naomi.id)
        .executeTakeFirstOrThrow()
    ).id;
    expect((await h.http.get(`/api/v1/enrollments/${naomiEnrollment}`).set(danielle)).status).toBe(
      404,
    );
    expect(
      (await h.http.get(`/api/v1/enrollments/${naomiEnrollment}`).set(await h.as('luis'))).status,
    ).toBe(200);
    expect(
      (await h.http.get(`/api/v1/enrollments?teamId=${TEAMS[0].id}&pageSize=50`).set(danielle)).body
        .total,
    ).toBe(5);
    expect((await h.http.get('/api/v1/progress/team').set(await h.as('marcus'))).status).toBe(403);
    expect(
      (await h.http.get('/api/v1/progress/team').set(await h.as('marcus'))).body.error.code,
    ).toBe('FORBIDDEN');
  });

  it('only lets a manager approve for people in scope', async () => {
    const pending = (await h.http.get('/api/v1/learning/approvals').set(await h.as('andre'))).body
      .items as Array<{
      id: string;
      learner: { displayName: string };
      lesson: { title: string };
      kind: string;
    }>;
    expect(pending.map((a) => [a.learner.displayName, a.lesson.title, a.kind])).toEqual([
      ['Brianna Castillo', 'Manager Field-Ready Sign-off', 'manager_approval'],
    ]);
    for (const other of ['danielle', 'luis', 'meilin'] as const) {
      expect(
        (await h.http.get('/api/v1/learning/approvals').set(await h.as(other))).body.items,
      ).toEqual([]);
      expect(
        (
          await h.http
            .post(`/api/v1/learning/approvals/${pending[0]!.id}/decision`)
            .set(await h.as(other))
            .send({ decision: 'approved' })
        ).status,
      ).toBe(404);
    }
  });
});

describe('attention flags', () => {
  it('flags overdue, inactive and waiting learners from the data', async () => {
    const rows = await team(await h.as('priya'));
    const flags = (name: string) =>
      rows
        .find((r) => r.learner.displayName === name)!
        .attention.map((a) => a.code)
        .sort();
    expect(flags('Brianna Castillo')).toEqual(['awaiting_approval', 'overdue']);
    expect(flags('Naomi Fischer')).toEqual(['overdue']);
    // Colton last did something 11 days ago; Isaiah 5 days ago (within the 7-day window).
    expect(flags('Colton Hayes')).toEqual(['inactive']);
    expect(flags('Isaiah Grant')).toEqual([]);
    expect(flags('Ashlyn Pierce')).toEqual([]);
    const colton = rows.find((r) => r.learner.displayName === 'Colton Hayes')!;
    expect(colton.attention[0]!.message).toMatch(/^No activity in 1[01] days$/);
    expect(colton.currentPhase?.title).toBe('A5 Fundamentals');

    const attention = await team(await h.as('priya'), '&attention=true');
    expect(names(attention)).toEqual(['Brianna Castillo', 'Colton Hayes', 'Naomi Fischer']);
    expect(names(await team(await h.as('priya'), '&status=completed'))).toEqual([
      'Ashlyn Pierce',
      'Destiny Morales',
      'Sofia Navarro',
    ]);
    expect(names(await team(await h.as('priya'), '&q=castillo'))).toEqual(['Brianna Castillo']);
  });

  it('flags a learner whose assessment results are all failing, and clears it when they pass', async () => {
    const danielle = await h.as('danielle');
    const kayla = await h.as('kayla');
    const quiz = ASSESSMENTS[0]!;
    const lessonId = allLessons().find((l) => l.key === 'w1-quiz')!.id;
    const mapId = allLessons().find((l) => l.key === 'w1-journey-map')!.id;
    const enrollment = await h.db
      .selectFrom('enrollments')
      .select('id')
      .where('user_id', '=', PEOPLE.kayla.id)
      .executeTakeFirstOrThrow();
    // Kayla opens the customer journey map, then sits the Week 1 quiz twice.
    await h.http.post(`/api/v1/learning/me/lessons/${mapId}/start`).set(kayla);
    expect(
      (await h.http.post(`/api/v1/learning/me/lessons/${mapId}/complete`).set(kayla)).status,
    ).toBe(200);
    const grade = (score: number, passed: boolean, attemptNumber: number) =>
      h.consume(
        h.envelope(assessmentEvents.attemptGraded, {
          attemptId: randomId(),
          assessmentId: quiz.id,
          assessmentTitle: quiz.title,
          kind: 'quiz',
          userId: PEOPLE.kayla.id,
          attemptNumber,
          scorePercent: score,
          passed,
          passingPercent: 80,
          gradedAt: new Date().toISOString(),
          overridden: false,
          context: { lessonId, programId: PROGRAM.id, enrollmentId: enrollment.id },
          questionResults: [],
        }),
      );
    await grade(58, false, 1);
    const flagged = (await team(danielle)).find((r) => r.learner.displayName === 'Kayla Simmons')!;
    expect(flagged.attention.find((a) => a.code === 'failing_assessment')!.message).toBe(
      'Week 1 Knowledge Check: best score 58% after 1 attempt',
    );
    const detail = await h.http.get(`/api/v1/progress/learners/${PEOPLE.kayla.id}`).set(danielle);
    expect(detail.body.assessments).toEqual([
      expect.objectContaining({ title: quiz.title, bestScore: 58, passed: false, attempts: 1 }),
    ]);
    expect((await outline(h, kayla, PROGRAM.id)).phases[1]!.state).toBe('locked');

    await grade(88, true, 2);
    const cleared = (await team(danielle)).find((r) => r.learner.displayName === 'Kayla Simmons')!;
    expect(cleared.attention.map((a) => a.code)).not.toContain('failing_assessment');
    // Week 1 is done and the quiz clears the Week 2 rule, so Week 2 opens.
    const after = await outline(h, kayla, PROGRAM.id);
    expect(after.phases.map((p) => p.state)).toEqual([
      'completed',
      'available',
      'locked',
      'locked',
    ]);
    expect(
      (
        await h.db
          .selectFrom('phase_completions')
          .select('phase_id')
          .where('enrollment_id', '=', enrollment.id)
          .execute()
      ).map((r) => r.phase_id),
    ).toEqual([PHASES[0]!.id]);
  });
});

describe('enrollment listing', () => {
  it('filters by overdue, team, status and learner name', async () => {
    const admin = await h.as('priya');
    const list = async (query: string) =>
      (await h.http.get(`/api/v1/enrollments?${query}&pageSize=100`).set(admin)).body
        .items as Array<{ learner: { displayName: string }; overdue: boolean; status: string }>;
    expect((await list('overdue=true')).map((e) => e.learner.displayName).sort()).toEqual([
      'Brianna Castillo',
      'Naomi Fischer',
    ]);
    expect((await list('overdue=false')).length).toBe(14);
    expect((await list(`teamId=${TEAMS[3].id}`)).map((e) => e.learner.displayName).sort()).toEqual(
      teamMembers(3),
    );
    expect((await list('status=completed')).length).toBe(3);
    expect((await list('q=delg')).map((e) => e.learner.displayName)).toEqual(['Marcus Delgado']);
    const sorted = await h.http.get(`/api/v1/enrollments?sort=-progress&pageSize=3`).set(admin);
    expect(sorted.body.items.map((e: { progressPercent: number }) => e.progressPercent)).toEqual([
      100, 100, 100,
    ]);
    expect(sorted.body.total).toBe(16);
  });
});

describe('republishing', () => {
  it('keeps every learner’s progress when a new version is published', async () => {
    const admin = await h.as('grant');
    const before = (
      await h.http.get(`/api/v1/enrollments?programId=${PROGRAM.id}&pageSize=100`).set(admin)
    ).body.items as Array<{ id: string; progressPercent: number; requiredCompleted: number }>;
    const lessonId = allLessons().find((l) => l.key === 'w2-adjusters')!.id;
    await h.http.patch(`/api/v1/lessons/${lessonId}`).set(admin).send({ estimatedMinutes: 11 });
    const res = await h.http
      .post(`/api/v1/programs/${PROGRAM.id}/publish`)
      .set(admin)
      .send({ changeNote: 'Adjusted reading time for the adjuster article' });
    expect(res.status).toBe(200);
    expect(res.body.version.version).toBe(2);
    const after = (
      await h.http.get(`/api/v1/enrollments?programId=${PROGRAM.id}&pageSize=100`).set(admin)
    ).body.items as typeof before;
    expect(after.map((e) => [e.id, e.progressPercent, e.requiredCompleted]).sort()).toEqual(
      before.map((e) => [e.id, e.progressPercent, e.requiredCompleted]).sort(),
    );
  });

  it('adds a new required lesson without reopening completed work or re-locking finished weeks', async () => {
    const admin = await h.as('grant');
    const added = await h.http.post('/api/v1/lessons').set(admin).send({
      moduleId: PHASES[0]!.modules[0]!.id,
      type: 'article',
      title: 'Meet your trainer',
      body: '# Meet your trainer\n\nYour trainer is your first call when you have a question in the field.',
      estimatedMinutes: 4,
    });
    expect(added.status).toBe(201);
    await h.clearOutbox();
    expect(
      (
        await h.http
          .post(`/api/v1/programs/${PROGRAM.id}/publish`)
          .set(admin)
          .send({ changeNote: 'Added a trainer introduction to week 1' })
      ).status,
    ).toBe(200);

    const rows = (
      await h.http.get(`/api/v1/enrollments?programId=${PROGRAM.id}&pageSize=100`).set(admin)
    ).body.items as Array<{
      learner: { displayName: string };
      status: string;
      requiredTotal: number;
      requiredCompleted: number;
      progressPercent: number;
    }>;
    const byName = (name: string) => rows.find((r) => r.learner.displayName === name)!;
    // Ashlyn is certified: her record is final.
    expect(byName('Ashlyn Pierce')).toMatchObject({
      status: 'completed',
      requiredTotal: 25,
      requiredCompleted: 25,
      progressPercent: 100,
    });
    // Everyone still in the program now has one more required lesson.
    expect(byName('Marcus Delgado')).toMatchObject({
      status: 'active',
      requiredTotal: 26,
      requiredCompleted: 8,
      progressPercent: 30.8,
    });
    expect(byName('Brianna Castillo')).toMatchObject({ requiredTotal: 26, requiredCompleted: 24 });
    expect((await h.outbox('enrollment.progressed')).length).toBe(13);

    // Marcus keeps Week 2 because he already finished Week 1; the new lesson is simply open to him.
    const o = await outline(h, await h.as('marcus'), PROGRAM.id);
    expect(o.phases.map((p) => p.state)).toEqual(['completed', 'in_progress', 'locked', 'locked']);
    const newLesson = o.phases[0]!.modules[0]!.lessons.find((l) => l.id === added.body.id)!;
    expect(newLesson.state).toBe('available');
  });
});

describe('internal API', () => {
  it('serves the published requirement map to other services with a service token', async () => {
    const res = await h.http
      .get(`/internal/programs/${PROGRAM.id}/summary`)
      .set(await serviceHeaders('certification-service'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: PROGRAM.id,
      title: PROGRAM.title,
      status: 'published',
      phaseLabel: 'Week',
    });
    expect(res.body.phases).toHaveLength(4);
    expect(res.body.assessments).toHaveLength(4);
    expect(res.body.aiScenarios).toHaveLength(5);
    expect(res.body.requiredLessonIds.length).toBeGreaterThanOrEqual(25);
    expect(
      (await h.http.get(`/internal/programs/${PROGRAM.id}/summary`).set(await h.as('priya')))
        .status,
    ).toBe(401);
    expect((await h.http.get(`/internal/programs/${PROGRAM.id}/summary`)).status).toBe(401);
  });
});
