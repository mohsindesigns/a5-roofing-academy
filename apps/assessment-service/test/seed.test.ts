import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assessment } from '@a5/contracts';
import {
  ASSESSMENTS,
  JOURNEYS,
  PEOPLE,
  PROGRAM,
  QUESTION_BANK,
  SEED_NOW,
  allLessons,
  directoryTeams,
  directoryUnits,
  directoryUsers,
} from '@a5/seed-data';
import { ASSESSMENT_DEFINITIONS } from '../src/seed/content/assessments.js';
import { CATEGORIES, QUESTIONS } from '../src/seed/content/question-bank.js';
import { seedAssessment } from '../src/seed/seed-assessment.js';
import { createAssessmentHarness, type AssessmentHarness } from './harness.js';

let h: AssessmentHarness;

beforeAll(async () => {
  h = await createAssessmentHarness('seed');
});
afterAll(() => h?.close());

describe('question bank content', () => {
  it('has the A5 Sales Core bank with the required categories', async () => {
    const bank = await h.http
      .get(`/api/v1/question-banks/${QUESTION_BANK.id}`)
      .set(await h.as('priya'));
    expect(bank.status).toBe(200);
    expect(bank.body.title).toBe('A5 Sales Core');
    expect(bank.body.categories.map((c: { name: string }) => c.name)).toEqual([
      'Company Standards',
      'Roofing Systems',
      'Storm Damage',
      'Insurance Process',
      'Sales Conversation',
      'Objection Handling',
      'Compliance',
    ]);
    expect(bank.body.categories.every((c: { questionCount: number }) => c.questionCount >= 5)).toBe(
      true,
    );
    expect(bank.body.competencies.length).toBeGreaterThanOrEqual(5);
    expect(bank.body.activeQuestionCount).toBe(QUESTIONS.length);
  });

  it('has at least 50 questions covering every question type, each with an explanation', async () => {
    expect(QUESTIONS.length).toBeGreaterThanOrEqual(50);
    const rows = await h.db
      .selectFrom('question_versions')
      .select(['type', 'prompt', 'explanation', 'config', 'difficulty', 'points'])
      .execute();
    expect(rows).toHaveLength(QUESTIONS.length);
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(assessment.QUESTION_TYPES));
    for (const type of assessment.QUESTION_TYPES) {
      expect(
        rows.filter((r) => r.type === type).length,
        `questions of type ${type}`,
      ).toBeGreaterThanOrEqual(3);
    }
    expect(new Set(rows.map((r) => r.difficulty))).toEqual(new Set(['easy', 'medium', 'hard']));
    for (const r of rows) {
      expect(r.explanation, r.prompt).toBeTruthy();
      expect(r.explanation!.length, r.prompt).toBeGreaterThan(60);
      expect(r.prompt.length, r.prompt).toBeGreaterThan(20);
      expect(r.points).toBeGreaterThan(0);
    }
  });

  it('stores valid answer keys for every question', async () => {
    const rows = await h.db
      .selectFrom('question_versions')
      .select(['type', 'config', 'prompt'])
      .execute();
    for (const r of rows) {
      const parsed = assessment.questionDefinitionSchema.safeParse({
        type: r.type,
        config: r.config,
      });
      expect(
        parsed.success,
        `${r.prompt}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
      ).toBe(true);
    }
  });

  it('uses real A5 content, not placeholders', async () => {
    const text = JSON.stringify(QUESTIONS).toLowerCase();
    for (const bad of [
      'lorem',
      'ipsum',
      'john doe',
      'jane doe',
      'foo',
      'bar baz',
      'todo',
      'tbd',
      'placeholder',
      'sample question',
      'test question',
    ]) {
      expect(text, bad).not.toMatch(new RegExp(`\\b${bad}\\b`));
    }
    for (const topic of [
      'granule',
      'deductible',
      'recoverable depreciation',
      'underlayment',
      'adjuster',
      'discovery',
      'objection',
      'actual cash value',
    ]) {
      expect(text, topic).toContain(topic);
    }
  });

  it('is browsable through the admin API by category, type and tag', async () => {
    const admin = await h.as('shelby');
    const insurance = CATEGORIES.find((c) => c.key === 'insurance-process')!;
    const bank = (await h.http.get(`/api/v1/question-banks/${QUESTION_BANK.id}`).set(admin)).body;
    const categoryId = bank.categories.find((c: { name: string }) => c.name === insurance.name).id;
    const list = await h.http
      .get('/api/v1/questions')
      .query({ bankId: QUESTION_BANK.id, categoryId, pageSize: '100' })
      .set(admin);
    expect(list.body.total).toBe(
      QUESTIONS.filter((q) => q.category === 'insurance-process').length,
    );
    const manual = await h.http
      .get('/api/v1/questions')
      .query({ bankId: QUESTION_BANK.id, type: 'long_answer', pageSize: '100' })
      .set(admin);
    expect(manual.body.items.every((i: { manualReview: boolean }) => i.manualReview)).toBe(true);
    const week2 = await h.http
      .get('/api/v1/questions')
      .query({ tags: 'week-2', pageSize: '100' })
      .set(admin);
    expect(week2.body.total).toBe(10);
    const search = await h.http
      .get('/api/v1/questions')
      .query({ q: 'granule', pageSize: '100' })
      .set(admin);
    expect(search.body.total).toBeGreaterThanOrEqual(2);
  });
});

describe('academy assessments', () => {
  it('matches the shared catalogue', async () => {
    const admin = await h.as('priya');
    for (const seed of ASSESSMENTS) {
      const res = await h.http.get(`/api/v1/assessments/${seed.id}`).set(admin);
      expect(res.status, seed.key).toBe(200);
      expect(res.body).toMatchObject({
        title: seed.title,
        kind: seed.kind,
        status: 'published',
        questionCount: seed.questionCount,
      });
      expect(res.body.config.passingPercent).toBe(seed.passingPercent);
      expect(res.body.description).toBeTruthy();
      expect(ASSESSMENT_DEFINITIONS[seed.key]!.items.length).toBe(res.body.itemCount);
    }
  });

  it('weekly quizzes use fixed questions; the final mixes fixed items and pools', async () => {
    const admin = await h.as('priya');
    const kinds = async (key: string) =>
      (
        await h.http
          .get(`/api/v1/assessments/${ASSESSMENTS.find((a) => a.key === key)!.id}`)
          .set(admin)
      ).body.items.map((i: { kind: string }) => i.kind);
    for (const key of ['quiz-w1', 'quiz-w2', 'quiz-w3'])
      expect(new Set(await kinds(key))).toEqual(new Set(['question']));
    const final = await kinds('final');
    expect(final.filter((k: string) => k === 'pool').length).toBeGreaterThanOrEqual(5);
    expect(final.filter((k: string) => k === 'question').length).toBeGreaterThanOrEqual(5);
    const detail = (
      await h.http
        .get(`/api/v1/assessments/${ASSESSMENTS.find((a) => a.key === 'final')!.id}`)
        .set(admin)
    ).body as assessment.AssessmentDetail;
    expect(
      detail.items
        .filter((i) => i.kind === 'pool')
        .every((i) => i.kind === 'pool' && i.available >= i.count),
    ).toBe(true);
    expect(detail.config).toMatchObject({
      passingPercent: 85,
      maxAttempts: 2,
      randomizeQuestions: true,
      retryCooldownMinutes: 1440,
      notifyManagerOn: ['failed', 'passed'],
    });
  });

  it('every assessment validates and previews with exactly its question count', async () => {
    const admin = await h.as('shelby');
    for (const seed of ASSESSMENTS) {
      const validation = await h.http.get(`/api/v1/assessments/${seed.id}/validation`).set(admin);
      expect(validation.body, seed.key).toMatchObject({
        valid: true,
        questionCount: seed.questionCount,
        issues: [],
      });
      const preview = (await h.http.post(`/api/v1/assessments/${seed.id}/preview`).set(admin))
        .body as assessment.AssessmentPreview;
      expect(preview.questionCount, seed.key).toBe(seed.questionCount);
      expect(new Set(preview.questions.map((q) => q.questionId)).size).toBe(seed.questionCount);
    }
  });

  it('the final draws a different mix each time but always honours its pool rules', async () => {
    const admin = await h.as('shelby');
    const finalId = ASSESSMENTS.find((a) => a.key === 'final')!.id;
    const draws = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const preview = (await h.http.post(`/api/v1/assessments/${finalId}/preview`).set(admin))
        .body as assessment.AssessmentPreview;
      const byItem = new Map<string, typeof preview.questions>();
      for (const q of preview.questions) byItem.set(q.itemId, [...(byItem.get(q.itemId) ?? []), q]);
      // Pools with a difficulty rule only yield that difficulty.
      const roofing = preview.questions.filter(
        (q) => q.source === 'pool' && q.category?.name === 'Roofing Systems',
      );
      expect(roofing).toHaveLength(2);
      expect(roofing.every((q) => q.difficulty === 'medium')).toBe(true);
      draws.add(
        preview.questions
          .map((q) => q.questionId)
          .sort()
          .join(),
      );
    }
    expect(draws.size).toBeGreaterThan(1);
  });
});

describe('historical attempts follow the learner journeys', () => {
  const expectedAttempts = JOURNEYS.flatMap((j) =>
    ASSESSMENTS.flatMap((a) =>
      (j.attempts[a.key] ?? []).map((percent, index) => ({
        journey: j,
        seed: a,
        percent,
        number: index + 1,
      })),
    ),
  );

  it('creates one attempt per listed score', async () => {
    const count = await h.db
      .selectFrom('attempts')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(expectedAttempts.length);
    expect(expectedAttempts.length).toBeGreaterThanOrEqual(25);
  });

  it('scores each attempt within one question of the listed percentage, with a consistent pass result', async () => {
    for (const e of expectedAttempts) {
      const row = await h.db
        .selectFrom('attempts')
        .select(['score_percent', 'passed', 'status', 'max_points'])
        .where('user_id', '=', PEOPLE[e.journey.person].id)
        .where('assessment_id', '=', e.seed.id)
        .where('attempt_number', '=', e.number)
        .executeTakeFirst();
      const label = `${e.journey.person} ${e.seed.key} #${e.number}`;
      expect(row, label).toBeTruthy();
      expect(row!.status, label).toBe('graded');
      const oneQuestion = 100 / e.seed.questionCount;
      expect(
        Math.abs(row!.score_percent! - e.percent),
        `${label}: ${row!.score_percent} vs ${e.percent}`,
      ).toBeLessThanOrEqual(oneQuestion);
      expect(row!.passed, label).toBe(e.percent >= e.seed.passingPercent);
      expect(row!.passed, label).toBe(row!.score_percent! >= e.seed.passingPercent);
    }
  });

  it('keeps contexts, timestamps and ordering believable', async () => {
    const lessons = allLessons();
    for (const e of expectedAttempts) {
      const row = await h.db
        .selectFrom('attempts')
        .selectAll()
        .where('user_id', '=', PEOPLE[e.journey.person].id)
        .where('assessment_id', '=', e.seed.id)
        .where('attempt_number', '=', e.number)
        .executeTakeFirstOrThrow();
      const label = `${e.journey.person} ${e.seed.key} #${e.number}`;
      expect(row.context, label).toEqual({
        programId: PROGRAM.id,
        lessonId: lessons.find((l) => l.key === e.seed.lessonKey)!.id,
      });
      expect(row.started_at.getTime(), label).toBeGreaterThan(
        new Date(e.journey.enrolledAt).getTime(),
      );
      expect(row.submitted_at!.getTime(), label).toBeGreaterThan(row.started_at.getTime());
      expect(row.submitted_at!.getTime(), label).toBeLessThan(SEED_NOW.getTime());
      expect(row.graded_at!.getTime(), label).toBeGreaterThanOrEqual(row.submitted_at!.getTime());
      expect(row.graded_at!.getTime(), label).toBeLessThan(SEED_NOW.getTime());
      expect(row.expires_at!.getTime(), label).toBeGreaterThan(row.submitted_at!.getTime());
      expect(row.auto_submitted).toBe(false);
    }
    // Retakes happen after the first attempt.
    const tyler = await h.db
      .selectFrom('attempts')
      .select(['attempt_number', 'submitted_at', 'passed'])
      .where('user_id', '=', PEOPLE.tyler.id)
      .orderBy('attempt_number')
      .execute();
    expect(tyler.map((t) => [t.attempt_number, t.passed])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(tyler[1]!.submitted_at!.getTime()).toBeGreaterThan(tyler[0]!.submitted_at!.getTime());
    // Weekly quizzes are taken in order.
    const ashlyn = await h.db
      .selectFrom('attempts as t')
      .innerJoin('assessments as a', 'a.id', 't.assessment_id')
      .select(['a.title', 't.submitted_at'])
      .where('t.user_id', '=', PEOPLE.ashlyn.id)
      .orderBy('t.submitted_at')
      .execute();
    expect(ashlyn.map((r) => r.title)).toEqual([
      'Week 1 Knowledge Check',
      'Week 2 Knowledge Check',
      'Week 3 Knowledge Check',
      'Final Sales Readiness Assessment',
    ]);
  });

  it('had the final’s written answers graded by a trainer with feedback', async () => {
    const reviewed = await h.db
      .selectFrom('attempt_answers as aa')
      .innerJoin('attempts as t', 't.id', 'aa.attempt_id')
      .select([
        'aa.graded_by_name',
        'aa.feedback',
        'aa.awarded_points',
        'aa.graded_at',
        't.submitted_at',
      ])
      .where('aa.graded_by', 'is not', null)
      .execute();
    expect(reviewed.length).toBeGreaterThanOrEqual(8);
    expect(reviewed.every((r) => r.feedback && r.graded_at! > r.submitted_at!)).toBe(true);
    expect(new Set(reviewed.map((r) => r.graded_by_name))).toEqual(new Set(['Shelby Hartman']));
  });

  it('is visible to the right people', async () => {
    const own = await h.http.get('/api/v1/attempts/mine').set(await h.as('ashlyn'));
    expect(own.body.items).toHaveLength(4);
    expect(own.body.items.map((i: { passed: boolean }) => i.passed)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    const naomiAttempts = await h.http
      .get('/api/v1/attempts')
      .query({ userId: PEOPLE.naomi.id })
      .set(await h.as('luis'));
    expect(naomiAttempts.body.total).toBe(3);
    expect(
      (
        await h.http
          .get('/api/v1/attempts')
          .query({ userId: PEOPLE.naomi.id })
          .set(await h.as('danielle'))
      ).body.total,
    ).toBe(0);
    const stats = (
      await h.http.get(`/api/v1/assessments/${ASSESSMENTS[0]!.id}/stats`).set(await h.as('priya'))
    ).body as assessment.AssessmentStats;
    expect(stats.attempts.graded).toBe(
      expectedAttempts.filter((e) => e.seed.key === 'quiz-w1').length,
    );
    expect(stats.hardestQuestions.length).toBeGreaterThan(0);
  });

  it('shows a seeded learner their result under the reveal policy', async () => {
    const mine = await h.http
      .get('/api/v1/attempts/mine')
      .query({ assessmentId: ASSESSMENTS[1]!.id })
      .set(await h.as('brianna'));
    expect(mine.body.items).toHaveLength(2);
    const failed = mine.body.items.find((i: { attemptNumber: number }) => i.attemptNumber === 1);
    const result = await h.http
      .get(`/api/v1/attempts/${failed.id}/result`)
      .set(await h.as('brianna'));
    expect(result.body).toMatchObject({
      status: 'graded',
      passed: false,
      answersRevealed: true,
      attemptsUsed: 2,
    });
    expect(result.body.questions.every((q: { explanation: string | null }) => q.explanation)).toBe(
      true,
    );
    // The final reveals answers only after a pass.
    const finals = await h.http
      .get('/api/v1/attempts/mine')
      .query({ assessmentId: ASSESSMENTS[3]!.id })
      .set(await h.as('brianna'));
    const finalResult = await h.http
      .get(`/api/v1/attempts/${finals.body.items[0].id}/result`)
      .set(await h.as('brianna'));
    expect(finalResult.body).toMatchObject({ passed: true, answersRevealed: true });
  });
});

describe('directory projection', () => {
  it('holds the seeded people, teams and units', async () => {
    const users = await h.db.selectFrom('dir_users').select('id').execute();
    expect(users).toHaveLength(directoryUsers().length);
    expect(await h.db.selectFrom('dir_teams').select('id').execute()).toHaveLength(
      directoryTeams().length,
    );
    expect(await h.db.selectFrom('dir_units').select('id').execute()).toHaveLength(
      directoryUnits().length,
    );
    const memberships = await h.db
      .selectFrom('dir_user_teams')
      .select('user_id')
      .where('user_id', '=', PEOPLE.kayla.id)
      .execute();
    expect(memberships).toHaveLength(1);
    const managers = await h.db.selectFrom('dir_team_managers').select('user_id').execute();
    expect(managers.map((m) => m.user_id)).toContain(PEOPLE.danielle.id);
  });
});

describe('idempotency', () => {
  it('seeding again changes nothing', async () => {
    const counts = async () => ({
      questions: Number(
        (
          await h.db
            .selectFrom('questions')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      ),
      versions: Number(
        (
          await h.db
            .selectFrom('question_versions')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      ),
      attempts: Number(
        (
          await h.db
            .selectFrom('attempts')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      ),
      answers: Number(
        (
          await h.db
            .selectFrom('attempt_answers')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      ),
      users: Number(
        (
          await h.db
            .selectFrom('dir_users')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      ),
    });
    const before = await counts();
    const again = await seedAssessment(h.db);
    expect(again).toEqual({ created: false, questions: 0, attempts: 0 });
    expect(await counts()).toEqual(before);
  });
});
