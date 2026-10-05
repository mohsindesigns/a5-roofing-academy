import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateDown, migrateToLatest, sql } from '@a5/database';
import {
  ASSESSMENTS,
  CERTIFICATION,
  JOURNEYS,
  ORGANIZATION,
  PEOPLE,
  PHASES,
  PROGRAM,
  SCENARIOS,
  SEED_NOW,
  allLessons,
  completedLessonKeys,
  directoryUsers,
  seedId,
} from '@a5/seed-data';
import { createTestDatabase } from '@a5/testing';
import { migrations } from '../src/database/migrations/index.js';
import type { AnalyticsDatabase } from '../src/database/schema.js';
import { RUBRIC_CATEGORIES, buildSeedEvents, enrollmentIdFor, seedAnalytics } from '../src/seed/seed-analytics.js';
import { createAnalyticsHarness, type AnalyticsHarness } from './harness.js';

let h: AnalyticsHarness;

beforeAll(async () => {
  h = await createAnalyticsHarness('seed', { seed: true });
});
afterAll(() => h?.close());

const lessons = allLessons();
const byPerson = new Map(JOURNEYS.map((j) => [j.person, j]));
const tableCounts = async () => {
  const tables = ['fact_enrollments', 'fact_lesson_events', 'fact_assessment_attempts', 'fact_question_results', 'fact_ai_sessions', 'fact_ai_category_scores', 'fact_certificates', 'fact_activity', 'daily_rollups', 'inbox_events', 'dir_users'] as const;
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = Number((await h.db.selectFrom(t).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
  return out;
};

describe('seed', () => {
  it('is idempotent', async () => {
    const before = await tableCounts();
    const again = await seedAnalytics(h.db);
    expect(again).toEqual({ created: false, events: 0, rollupRows: 0 });
    expect(await tableCounts()).toEqual(before);
    // The event stream is deterministic, so even a forced replay would collapse into the same rows.
    expect(buildSeedEvents().map((e) => e.id)).toEqual(buildSeedEvents().map((e) => e.id));
    await h.apply(...buildSeedEvents());
    expect(await tableCounts()).toEqual(before);
  });

  it('loads the directory projection from the shared seed', async () => {
    expect(Number((await h.db.selectFrom('dir_users').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)).toBe(directoryUsers().length);
    expect((await h.db.selectFrom('dir_teams').select('id').execute()).length).toBe(4);
    expect((await h.db.selectFrom('dir_units').select('id').execute()).length).toBe(7);
  });

  it('builds enrollments from the journeys', async () => {
    const rows = await h.db.selectFrom('fact_enrollments').selectAll().execute();
    expect(rows).toHaveLength(JOURNEYS.length);
    for (const j of JOURNEYS) {
      const row = rows.find((r) => r.enrollment_id === enrollmentIdFor(j.person))!;
      expect(row.user_id, j.person).toBe(PEOPLE[j.person].id);
      expect(row.program_id).toBe(PROGRAM.id);
      expect(row.enrolled_at?.toISOString()).toBe(new Date(j.enrolledAt).toISOString());
      expect(row.due_at?.getTime()).toBe(Date.parse(j.enrolledAt) + PROGRAM.durationDays * 86_400_000);
      expect(row.status, j.person).toBe(j.stage === 'certified' ? 'completed' : 'active');
      expect(row.completed_at !== null, j.person).toBe(j.stage === 'certified');
      const required = lessons.filter((l) => l.required).length;
      const done = completedLessonKeys(j.stage).length;
      expect(row.progress_percent, j.person).toBeCloseTo(j.stage === 'certified' ? 100 : Math.round((done / required) * 1000) / 10, 1);
      expect(row.last_activity_at!.getTime()).toBeLessThanOrEqual(SEED_NOW.getTime());
      expect(row.last_activity_at!.getTime()).toBeGreaterThan(row.enrolled_at!.getTime());
    }
  });

  it('spreads lesson completions between enrolment and now, in program order', async () => {
    for (const j of JOURNEYS) {
      const keys = completedLessonKeys(j.stage);
      const events = await h.db
        .selectFrom('fact_lesson_events')
        .select(['lesson_id', 'started_at', 'completed_at'])
        .where('user_id', '=', PEOPLE[j.person].id)
        .where('completed_at', 'is not', null)
        .orderBy('completed_at')
        .execute();
      expect(events.map((e) => e.lesson_id), j.person).toEqual(keys.map((k) => lessons.find((l) => l.key === k)!.id));
      const times = events.map((e) => e.completed_at!.getTime());
      expect(times, j.person).toEqual([...times].sort((a, b) => a - b));
      expect(new Set(times).size, j.person).toBe(times.length);
      expect(times[0]!).toBeGreaterThan(Date.parse(j.enrolledAt));
      expect(times.at(-1)!).toBeLessThan(SEED_NOW.getTime());
      for (const e of events) expect(e.started_at!.getTime(), j.person).toBeLessThan(e.completed_at!.getTime());
    }
    const phases = await h.db.selectFrom('fact_phase_completions').select(['user_id']).execute();
    // Phases completed by stage: certified/awaiting 4; week4 3; week3 2; week2 1.
    const expectedPhases = JOURNEYS.reduce((n, j) => {
      const keys = new Set(completedLessonKeys(j.stage));
      return n + PHASES.filter((p) => p.modules.flatMap((m) => m.lessons).every((l) => keys.has(l.key))).length;
    }, 0);
    expect(phases).toHaveLength(expectedPhases);
  });

  it('records every assessment attempt with question results that add up to the score', async () => {
    const expected = JOURNEYS.flatMap((j) => Object.entries(j.attempts).flatMap(([key, scores]) => scores!.map((score, i) => ({ person: j.person, key, n: i + 1, score }))));
    const attempts = await h.db.selectFrom('fact_assessment_attempts').selectAll().execute();
    expect(attempts).toHaveLength(expected.length);
    for (const e of expected) {
      const a = ASSESSMENTS.find((x) => x.key === e.key)!;
      const row = attempts.find((r) => r.attempt_id === seedId(`attempt:${e.person}:${e.key}:${e.n}`))!;
      expect(row, `${e.person} ${e.key} ${e.n}`).toBeDefined();
      expect(row).toMatchObject({ user_id: PEOPLE[e.person].id, assessment_id: a.id, attempt_number: e.n, score_percent: e.score, passed: e.score >= a.passingPercent, passing_percent: a.passingPercent, kind: a.kind, overridden: false });
      const questions = await h.db.selectFrom('fact_question_results').select(['awarded_points', 'possible_points', 'correct']).where('attempt_id', '=', row.attempt_id).execute();
      expect(questions, `${e.person} ${e.key} ${e.n}`).toHaveLength(a.questionCount);
      const earned = questions.reduce((s, q) => s + q.awarded_points, 0);
      const possible = questions.reduce((s, q) => s + q.possible_points, 0);
      expect(Math.round((earned / possible) * 100)).toBe(e.score);
      expect(questions.filter((q) => q.correct).length).toBe(Math.floor((e.score * a.questionCount) / 100 + 1e-9));
    }
    // Retakes happen after the first attempt and pass attempts precede the lesson completion.
    const tyler = attempts.filter((r) => r.user_id === PEOPLE.tyler.id).sort((a, b) => a.attempt_number - b.attempt_number);
    expect(tyler.map((r) => [r.score_percent, r.passed])).toEqual([[70, false], [84, true]]);
    expect(tyler[0]!.graded_at.getTime()).toBeLessThan(tyler[1]!.graded_at.getTime());
  });

  it('records AI sessions whose category scores average to the overall score', async () => {
    const sessions = await h.db.selectFrom('fact_ai_sessions').selectAll().execute();
    expect(sessions).toHaveLength(JOURNEYS.reduce((n, j) => n + j.aiSessions.length, 0));
    for (const j of JOURNEYS) {
      const own = sessions.filter((s) => s.user_id === PEOPLE[j.person].id).sort((a, b) => a.evaluated_at.getTime() - b.evaluated_at.getTime());
      expect(own.map((s) => [s.scenario_id, s.overall_score]), j.person).toEqual(j.aiSessions.map((s) => [SCENARIOS.find((x) => x.key === s.scenario)!.id, s.score]));
      for (const [i, s] of own.entries()) {
        const sc = SCENARIOS.find((x) => x.key === j.aiSessions[i]!.scenario)!;
        expect(s).toMatchObject({ scenario_title: sc.title, scenario_category: sc.category, difficulty: sc.difficulty, passing_score: sc.passingScore, passed: s.overall_score >= sc.passingScore });
        const days = (SEED_NOW.getTime() - s.evaluated_at.getTime()) / 86_400_000;
        expect(days).toBeGreaterThan(j.aiSessions[i]!.daysAgo - 0.26);
        expect(days).toBeLessThanOrEqual(j.aiSessions[i]!.daysAgo);
        const cats = await h.db.selectFrom('fact_ai_category_scores').select(['category_key', 'score']).where('session_id', '=', s.session_id).execute();
        expect(cats.map((c) => c.category_key).sort()).toEqual(RUBRIC_CATEGORIES.map((c) => c.key).sort());
        expect(cats.every((c) => c.score >= 0 && c.score <= 100)).toBe(true);
        expect(cats.reduce((sum, c) => sum + c.score, 0) / cats.length).toBeCloseTo(s.overall_score, 6);
      }
    }
  });

  it('issues certificates with 24 months of validity and the right lifecycle', async () => {
    const certs = await h.db.selectFrom('fact_certificates').selectAll().orderBy('issued_at').execute();
    expect(certs.map((c) => [c.user_id, c.status])).toEqual([
      [PEOPLE.sofia.id, 'issued'],
      [PEOPLE.ashlyn.id, 'issued'],
      [PEOPLE.destiny.id, 'superseded'],
      [PEOPLE.destiny.id, 'issued'],
    ]);
    for (const c of certs) {
      const issued = c.issued_at!;
      const expires = new Date(issued);
      expires.setUTCMonth(expires.getUTCMonth() + CERTIFICATION.validityMonths);
      expect(c.expires_at!.toISOString()).toBe(expires.toISOString());
      expect(c.certificate_number).toMatch(/^A5-SALES-\d{4}-\d{6}$/);
    }
    expect(new Set(certs.map((c) => c.certificate_number)).size).toBe(4);
    const replacement = certs.find((c) => c.status === 'issued' && c.user_id === PEOPLE.destiny.id)!;
    expect(replacement.replaces_certificate_id).toBe(certs.find((c) => c.status === 'superseded')!.certificate_id);
    const candidates = await h.db.selectFrom('fact_certification_candidates').select(['user_id', 'eligible_at', 'first_issued_at', 'approval_requested_at']).execute();
    // Three issued plus brianna, eligible and waiting for her manager's approval.
    expect(candidates).toHaveLength(4);
    const brianna = candidates.find((c) => c.user_id === PEOPLE.brianna.id)!;
    expect(brianna.eligible_at).not.toBeNull();
    expect(brianna.approval_requested_at).not.toBeNull();
    expect(brianna.first_issued_at).toBeNull();
    for (const c of candidates.filter((x) => x.first_issued_at)) expect(c.eligible_at!.getTime()).toBeLessThan(c.first_issued_at!.getTime());
  });

  it('stores the program dimension from the shared catalogue', async () => {
    const program = await h.db.selectFrom('dim_programs').selectAll().where('id', '=', PROGRAM.id).executeTakeFirstOrThrow();
    expect(program).toMatchObject({ title: PROGRAM.title, required_lesson_count: lessons.filter((l) => l.required).length, version: 1 });
    expect((await h.db.selectFrom('dim_phases').select('title').where('program_id', '=', PROGRAM.id).orderBy('position').execute()).map((p) => p.title)).toEqual(PHASES.map((p) => p.title));
    expect(await h.db.selectFrom('dim_lessons').select('id').where('program_id', '=', PROGRAM.id).where('in_program', '=', true).execute()).toHaveLength(lessons.length);
    const assessments = await h.db.selectFrom('dim_assessments').select(['id', 'passing_percent', 'kind']).orderBy('title').execute();
    expect(assessments.map((a) => a.id).sort()).toEqual(ASSESSMENTS.map((a) => a.id).sort());
    expect(assessments.every((a) => a.passing_percent !== null)).toBe(true);
    expect(await h.db.selectFrom('dim_question_categories').select('id').execute()).toHaveLength(8);
    expect(await h.db.selectFrom('dim_questions').select('id').execute()).toHaveLength(ASSESSMENTS.reduce((n, a) => n + a.questionCount, 0));
  });

  it('runs the rollup at the end of the seed and agrees with the facts', async () => {
    expect(await h.db.selectFrom('rollup_dirty_days').select('date').execute()).toEqual([]);
    const sum = async (metric: string) =>
      Number((await h.db.selectFrom('daily_rollups').select((eb) => eb.fn.sum('value').as('v')).where('metric', '=', metric).where('dimension_type', '=', 'organization').executeTakeFirstOrThrow()).v);
    const count = async (table: 'fact_assessment_attempts' | 'fact_ai_sessions' | 'fact_certificates') =>
      Number((await h.db.selectFrom(table).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
    expect(await sum('lessons_completed')).toBe(JOURNEYS.reduce((n, j) => n + completedLessonKeys(j.stage).length, 0));
    // Lessons a learner opened but has not finished are facts too, just not completions.
    const completed = await h.db.selectFrom('fact_lesson_events').select((eb) => eb.fn.countAll().as('n')).where('completed_at', 'is not', null).executeTakeFirstOrThrow();
    expect(await sum('lessons_completed')).toBe(Number(completed.n));
    expect(await sum('assessment_attempts')).toBe(await count('fact_assessment_attempts'));
    expect(await sum('ai_sessions')).toBe(await count('fact_ai_sessions'));
    expect(await sum('certificates_issued')).toBe(await count('fact_certificates'));
    expect(await sum('programs_completed')).toBe(3);
    expect(await sum('enrollments_started')).toBe(JOURNEYS.length);
    // Every grain agrees with the organization grain.
    for (const grain of ['user', 'team', 'location', 'department'] as const) {
      const rows = await h.db.selectFrom('daily_rollups').select((eb) => eb.fn.sum('value').as('v')).where('metric', '=', 'lessons_completed').where('dimension_type', '=', grain).executeTakeFirstOrThrow();
      expect(Number(rows.v), grain).toBe(await sum('lessons_completed'));
    }
    expect(byPerson.size).toBe(JOURNEYS.length);
    expect(ORGANIZATION.id).toBeTruthy();
  });
});

describe('migrations', () => {
  it('reverse cleanly and apply again', async () => {
    const tdb = await createTestDatabase('analytics_migrations');
    const database = createDatabase<AnalyticsDatabase>({ url: tdb.url, poolMax: 2 });
    try {
      const tables = async () =>
        (await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = 'public' and table_name <> 'schema_migrations' and table_name <> 'schema_migrations_lock' order by 1`.execute(database.db)).rows.map((r) => r.table_name);
      expect(await tables()).toEqual([]);
      await migrateToLatest(database.db as never, migrations);
      const up = await tables();
      expect(up).toEqual(
        expect.arrayContaining(['daily_rollups', 'report_jobs', 'fact_enrollments', 'fact_lesson_events', 'fact_phase_completions', 'fact_assessment_attempts', 'fact_question_results', 'fact_ai_sessions', 'fact_ai_category_scores', 'fact_certificates', 'dim_programs', 'dir_users', 'inbox_events', 'outbox_events']),
      );
      expect(await migrateDown(database.db as never, migrations)).toEqual(['Down 0001_analytics']);
      expect(await tables()).toEqual([]);
      const fn = await sql<{ n: number }>`select count(*) as n from pg_proc where proname = 'set_updated_at'`.execute(database.db);
      expect(Number(fn.rows[0]!.n)).toBe(0);
      await migrateToLatest(database.db as never, migrations);
      expect(await tables()).toEqual(up);
    } finally {
      await database.destroy();
      await tdb.drop();
    }
  });
});
