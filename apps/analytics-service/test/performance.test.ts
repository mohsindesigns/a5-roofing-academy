import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@a5/database';
import { ASSESSMENTS, DEPARTMENTS, LOCATIONS, ORGANIZATION, PROGRAM, SCENARIOS, SEED_NOW } from '@a5/seed-data';
import { ExportsService } from '../src/reports/exports.service.js';
import { refreshRollups } from '../src/rollups/rollup-builder.js';
import { createAnalyticsHarness, rolePermissions, type AnalyticsHarness } from './harness.js';
import { programPublished } from './fixture.js';

const LEARNERS = 4_000;
const TEAMS_N = 120;
const timings: Array<[string, number]> = [];

let h: AnalyticsHarness;
let admin: Record<string, string>;

const SCRATCH = '/tmp/claude-0/-home-user-a5-roofing-academy/90f9d363-7d99-515d-a423-7b48c334d4a1/scratchpad';

function dumpIfFailed(label: string, res: { status: number; body: unknown }) {
  if (res.status !== 200) appendFileSync(`${SCRATCH}/perf-errors.txt`, `${label}: ${res.status} ${JSON.stringify(res.body)}\n`);
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  const ms = Math.round(performance.now() - started);
  timings.push([label, ms]);
  return { value, ms };
}

beforeAll(async () => {
  h = await createAnalyticsHarness('perf', { now: SEED_NOW });
  await h.apply(programPublished());
  const db = h.db;
  const org = ORGANIZATION.id;
  const now = SEED_NOW.toISOString();
  const locations = LOCATIONS.map((l) => l.id);
  const departments = DEPARTMENTS.map((d) => d.id);

  // Valid (version 4 / variant 8) UUIDs derived from text, so response contracts accept them.
  await sql`
    create function gen_uuid_from(text) returns uuid language sql immutable as $$
      select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
      from (select md5($1) as h) x $$`.execute(db);
  await sql`create table gen_users as select i, gen_random_uuid() as id, gen_random_uuid() as enrollment_id from generate_series(1, ${LEARNERS}) i`.execute(db);
  await sql`
    insert into dir_teams (id, organization_id, name, location_id, department_id, archived, revision)
    select gen_random_uuid(), ${org}::uuid, 'Crew ' || n, (${sql.val(locations)}::uuid[])[1 + n % 3], (${sql.val(departments)}::uuid[])[1 + n % 2], false, 1
    from generate_series(1, ${TEAMS_N}) n`.execute(db);
  await sql`
    create table gen_teams as select row_number() over (order by name) as n, id from dir_teams where name like 'Crew %'`.execute(db);
  await sql`
    insert into dir_users (id, organization_id, first_name, last_name, display_name, email, employee_id, status, location_id, department_id, role_keys, revision)
    select u.id, ${org}::uuid, 'Rep', 'No. ' || u.i, 'Rep No. ' || u.i, 'rep' || u.i || '@a5roofing.example', 'A5-' || (5000 + u.i), 'active',
      (${sql.val(locations)}::uuid[])[1 + u.i % 3], (${sql.val(departments)}::uuid[])[1 + u.i % 2], '{sales_rep}', 1
    from gen_users u`.execute(db);
  await sql`insert into dir_user_teams (user_id, team_id) select u.id, t.id from gen_users u join gen_teams t on t.n = 1 + u.i % ${TEAMS_N}`.execute(db);

  // 30% completed, 60% active (one third of them overdue), 10% withdrawn.
  await sql`
    insert into fact_enrollments (enrollment_id, organization_id, user_id, program_id, program_title, source, status, status_at, enrolled_at, first_seen_at, due_at,
      progress_percent, required_completed, required_total, completed_at, withdrawn_at, overdue, last_activity_at, progress_at)
    select u.enrollment_id, ${org}::uuid, u.id, ${PROGRAM.id}::uuid, ${PROGRAM.title}, 'manual',
      case when u.i % 10 < 3 then 'completed' when u.i % 10 = 9 then 'withdrawn' else 'active' end,
      e.enrolled_at + interval '10 days', e.enrolled_at, e.enrolled_at, e.enrolled_at + interval '28 days',
      case when u.i % 10 < 3 then 100 else (u.i % 24 + 1) * 4 end, case when u.i % 10 < 3 then 25 else u.i % 24 + 1 end, 25,
      case when u.i % 10 < 3 then e.enrolled_at + interval '24 days' end,
      case when u.i % 10 = 9 then e.enrolled_at + interval '5 days' end,
      false, e.enrolled_at + interval '9 days', e.enrolled_at + interval '9 days'
    from gen_users u
    cross join lateral (select ${now}::timestamptz - ((u.i % 330 + 36) * interval '1 day') as enrolled_at) e`.execute(db);
  await sql`
    insert into fact_lesson_events (enrollment_id, lesson_id, organization_id, user_id, program_id, phase_id, module_id, lesson_type, required, started_at, completed_at, completion_source)
    select e.enrollment_id, l.id, ${org}::uuid, e.user_id, ${PROGRAM.id}::uuid, l.phase_id, l.module_id, l.lesson_type, true,
      e.enrolled_at + l.position * interval '20 hours', e.enrolled_at + l.position * interval '20 hours' + interval '30 minutes', 'learner'
    from fact_enrollments e
    join dim_lessons l on l.program_id = e.program_id and l.in_program
    where l.position <= case when e.status = 'completed' then 25 else e.required_completed end`.execute(db);
  await sql`
    create table gen_assessments as
    select a.n, a.id, a.passing from unnest(${sql.val(ASSESSMENTS.map((a) => a.id))}::uuid[], ${sql.val(ASSESSMENTS.map((a) => a.passingPercent))}::numeric[]) with ordinality as a(id, passing, n)`.execute(db);
  await sql`
    insert into fact_assessment_attempts (attempt_id, organization_id, user_id, assessment_id, assessment_title, kind, attempt_number, score_percent, passed, passing_percent, overridden, graded_at, program_id, enrollment_id)
    select gen_random_uuid(), ${org}::uuid, e.user_id, a.id, 'Assessment ' || a.n, case when a.n = 4 then 'final' else 'quiz' end, 1,
      s.score, s.score >= a.passing, a.passing, false, e.enrolled_at + a.n * interval '6 days', e.program_id, e.enrollment_id
    from fact_enrollments e cross join gen_assessments a
    cross join lateral (select 55 + ((hashtext(e.enrollment_id::text) & 2147483647) + a.n * 13) % 46 as score) s
    where e.status <> 'withdrawn' and (e.status = 'completed' or a.n <= 1 + (e.required_completed / 7))`.execute(db);
  await sql`
    insert into fact_question_results (attempt_id, question_id, organization_id, user_id, assessment_id, question_version_id, category_id, correct, awarded_points, possible_points, graded_at)
    select a.attempt_id, gen_uuid_from(a.assessment_id::text || q.n), a.organization_id, a.user_id, a.assessment_id, gen_uuid_from('v' || a.assessment_id::text || q.n),
      gen_uuid_from('category' || (q.n % 8)), ok.correct, ok.correct::int, 1, a.graded_at
    from fact_assessment_attempts a cross join generate_series(1, 10) q(n)
    cross join lateral (select ((hashtext(a.attempt_id::text) & 2147483647) + q.n * 3) % 5 <> 0 as correct) ok`.execute(db);
  await sql`
    insert into fact_ai_sessions (session_id, organization_id, user_id, scenario_id, scenario_title, scenario_category, difficulty, overall_score, passed, passing_score, evaluated_at, program_id, enrollment_id, prompt_version_id, rubric_version_id)
    select gen_random_uuid(), ${org}::uuid, e.user_id, sc.id, 'Scenario ' || sc.n, 'Category ' || sc.n, 'intermediate', s.score, s.score >= 75, 75,
      e.enrolled_at + (10 + sc.n) * interval '1 day', e.program_id, e.enrollment_id, gen_random_uuid(), gen_random_uuid()
    from fact_enrollments e
    cross join unnest(${sql.val(SCENARIOS.slice(0, 5).map((s) => s.id))}::uuid[]) with ordinality as sc(id, n)
    cross join lateral (select 60 + ((hashtext(e.enrollment_id::text) & 2147483647) + sc.n * 11) % 36 as score) s
    where e.status <> 'withdrawn' and sc.n <= 1 + (e.required_completed / 6)`.execute(db);
  await sql`
    insert into fact_ai_category_scores (session_id, category_key, organization_id, user_id, category_label, score, evaluated_at)
    select s.session_id, c.key, s.organization_id, s.user_id, 'Category ' || c.key, least(100, greatest(0, s.overall_score + c.bias)), s.evaluated_at
    from fact_ai_sessions s cross join (values ('rapport', 4), ('discovery', -6), ('objection', -3), ('value', 1), ('next_step', -2), ('compliance', 6)) c(key, bias)`.execute(db);
  await sql`
    insert into fact_certificates (certificate_id, organization_id, user_id, definition_id, definition_name, certificate_number, mode, status, status_at, issued_at, expires_at)
    select gen_random_uuid(), ${org}::uuid, e.user_id, gen_uuid_from('definition'), 'A5 Roofing Certified Sales Representative', 'A5-SALES-2026-' || lpad(row_number() over ()::text, 6, '0'), 'automatic', 'issued',
      e.completed_at + interval '1 day', e.completed_at + interval '1 day', e.completed_at + interval '1 day' + interval '24 months'
    from fact_enrollments e where e.status = 'completed'`.execute(db);
  await sql`
    insert into fact_certification_candidates (definition_id, user_id, organization_id, definition_name, eligible_at, first_issued_at)
    select gen_uuid_from('definition'), c.user_id, c.organization_id, c.definition_name, c.issued_at - interval '2 hours', c.issued_at from fact_certificates c`.execute(db);
  await sql`
    insert into fact_activity (id, organization_id, user_id, occurred_at, kind, title, program_id, score, passed)
    select gen_random_uuid(), organization_id, user_id, graded_at, case when passed then 'assessment_passed' else 'assessment_failed' end, assessment_title, program_id, score_percent, passed
    from fact_assessment_attempts
    union all
    select gen_random_uuid(), organization_id, user_id, evaluated_at, 'ai_session_scored', scenario_title, program_id, overall_score, passed
    from fact_ai_sessions`.execute(db);
  await sql`
    insert into learner_activity (user_id, organization_id, first_activity_at, last_activity_at)
    select user_id, organization_id, min(at), max(at) from (
      select user_id, organization_id, completed_at as at from fact_lesson_events
      union all select user_id, organization_id, graded_at from fact_assessment_attempts
      union all select user_id, organization_id, evaluated_at from fact_ai_sessions) x
    group by user_id, organization_id`.execute(db);
  await sql`update fact_enrollments set overdue = true where status = 'active' and enrollment_id::text < '5'`.execute(db);
  await sql`analyze`.execute(db);
  await sql`drop table gen_users, gen_teams, gen_assessments`.execute(db);

  const rollup = await timed('rollup rebuild (all history)', () =>
    refreshRollups(db, { organizationId: org, from: '2025-09-01', to: '2026-10-05', timezone: h.config.analytics.timezone }),
  );
  expect(rollup.value).toBeGreaterThan(10_000);
  admin = await h.as('grant');
  appendFileSync(`${SCRATCH}/perf-db.txt`, `${h.databaseName}\n`);
}, 180_000);

afterAll(async () => {
  appendFileSync(
    '/tmp/claude-0/-home-user-a5-roofing-academy/90f9d363-7d99-515d-a423-7b48c334d4a1/scratchpad/perf-timings.txt',
    timings.map(([k, v]) => `${k}: ${v} ms`).join('\n') + '\n',
  );
  await h?.close();
});

const BUDGET_MS = 6_000;

describe(`${LEARNERS.toLocaleString('en-US')} learners`, () => {
  it('has the expected volume', async () => {
    const count = async (t: 'fact_enrollments' | 'fact_lesson_events' | 'fact_question_results' | 'fact_ai_category_scores' | 'daily_rollups') =>
      Number((await h.db.selectFrom(t).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
    expect(await count('fact_enrollments')).toBe(LEARNERS);
    expect(await count('fact_lesson_events')).toBeGreaterThan(40_000);
    expect(await count('fact_question_results')).toBeGreaterThan(80_000);
    expect(await count('fact_ai_category_scores')).toBeGreaterThan(50_000);
  });

  it('answers the company dashboard from aggregates, with bounded lists', async () => {
    const cold = await timed('company dashboard (cold)', () => h.http.get('/api/v1/analytics/dashboards/company').set(admin));
    dumpIfFailed('company', cold.value);
    expect(cold.value.status).toBe(200);
    expect(cold.ms).toBeLessThan(BUDGET_MS);
    const { kpis, breakdowns, dropOffLessons, hardestQuestions, mostFailedObjections } = cold.value.body;
    expect(kpis.headcount).toBe(LEARNERS + 16);
    expect(kpis.enrollments).toBe(Math.round(LEARNERS * 0.9));
    expect(kpis.programCompletion.numerator).toBe(LEARNERS * 0.3);
    expect(kpis.certifiedCount).toBe(LEARNERS * 0.3);
    // Lists are top-N, never thousands of rows.
    expect(breakdowns.byTeam.length).toBeLessThanOrEqual(TEAMS_N + 4);
    expect(breakdowns.byLocation).toHaveLength(3);
    expect(dropOffLessons.length).toBeLessThanOrEqual(10);
    expect(hardestQuestions.length).toBeLessThanOrEqual(10);
    expect(mostFailedObjections.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(cold.value.body).length).toBeLessThan(120_000);

    const warm = await timed('company dashboard (cached)', () => h.http.get('/api/v1/analytics/dashboards/company').set(admin));
    expect(warm.value.status).toBe(200);
    expect(warm.value.body.meta.generatedAt).toBe(cold.value.body.meta.generatedAt);
    expect(warm.ms).toBeLessThan(500);
  });

  it('answers the team dashboard for a manager of ten crews quickly and within their scope', async () => {
    const crews = await h.db.selectFrom('dir_teams').select('id').where('name', 'like', 'Crew %').orderBy('name').limit(10).execute();
    const manager = await h.custom('0190a3b2-0000-7000-8000-00000000aaaa', rolePermissions('manager'), { managedTeamIds: crews.map((c) => c.id) });
    const res = await timed('team dashboard (10 teams, cold)', () => h.http.get('/api/v1/analytics/dashboards/team').set(manager));
    dumpIfFailed('team', res.value);
    expect(res.value.status).toBe(200);
    expect(res.ms).toBeLessThan(BUDGET_MS);
    // Crews hold 33 or 34 reps each; the manager sees exactly the members of their ten.
    const members = await h.db.selectFrom('dir_user_teams').select((eb) => eb.fn.countAll().as('n')).where('team_id', 'in', crews.map((c) => c.id)).executeTakeFirstOrThrow();
    expect(res.value.body.kpis.headcount).toBe(Number(members.n));
    expect(Number(members.n)).toBeGreaterThanOrEqual(330);
    expect(res.value.body.recentActivity).toHaveLength(20);
    expect(res.value.body.fallingBehind.items.length).toBeLessThanOrEqual(10);
    expect(res.value.body.requiringAttention.items.length).toBeLessThanOrEqual(10);
    const admin20 = await timed('team dashboard (organization scope, cold)', () => h.http.get('/api/v1/analytics/dashboards/team').set(admin));
    expect(admin20.value.status).toBe(200);
    expect(admin20.ms).toBeLessThan(BUDGET_MS);
  });

  it('reads trends from rollups without scanning facts', async () => {
    const org = await timed('trend (organization grain)', () => h.http.get('/api/v1/analytics/trends/lessons_completed?from=2025-10-01&to=2026-10-05&interval=week').set(admin));
    expect(org.value.status).toBe(200);
    expect(org.value.body.points.length).toBeGreaterThan(50);
    expect(org.ms).toBeLessThan(2_000);
    const crews = await h.db.selectFrom('dir_teams').select('id').where('name', 'like', 'Crew %').orderBy('name').limit(10).execute();
    const manager = await h.custom('0190a3b2-0000-7000-8000-00000000aaaa', rolePermissions('manager'), { managedTeamIds: crews.map((c) => c.id) });
    const managed = await timed('trend (managed scope, user grain)', () => h.http.get('/api/v1/analytics/trends/ai_score?from=2025-10-01&to=2026-10-05&interval=month').set(manager));
    expect(managed.value.status).toBe(200);
    expect(managed.ms).toBeLessThan(BUDGET_MS);
  });

  it('pages reports in bounded time and never returns more than the page size', async () => {
    for (const key of ['training-completion', 'assessment-performance', 'ai-coaching-performance', 'certification-status', 'overdue-training', 'training-engagement', 'course-effectiveness']) {
      const res = await timed(`report ${key} (page 1, 25 rows)`, () => h.http.get(`/api/v1/reports/${key}?pageSize=25`).set(admin));
      expect(res.value.status, key).toBe(200);
      expect(res.value.body.items.length, key).toBeLessThanOrEqual(25);
      expect(res.value.body.total, key).toBeGreaterThan(0);
      expect(res.ms, key).toBeLessThan(BUDGET_MS);
    }
    const sorted = await timed('report training-completion (page 40, sorted)', () => h.http.get('/api/v1/reports/training-completion?pageSize=25&page=40&sort=-progressPercent').set(admin));
    expect(sorted.value.body.items).toHaveLength(25);
    expect(sorted.ms).toBeLessThan(BUDGET_MS);
  });

  it('streams a large export to storage in batches', async () => {
    const created = await h.http.post('/api/v1/reports/exports').set(admin).send({ report: 'training-completion', format: 'csv' });
    const exportsService = h.app.get(ExportsService, { strict: false });
    const run = await timed('csv export of training completion', () => exportsService.run(created.body.id));
    // One row per enrollment, withdrawn ones included.
    expect(run.value).toEqual({ rowCount: LEARNERS });
    expect(run.ms).toBeLessThan(20_000);
    const xlsx = await h.http.post('/api/v1/reports/exports').set(admin).send({ report: 'training-engagement', format: 'xlsx' });
    const x = await timed('xlsx export of training engagement', () => exportsService.run(xlsx.body.id));
    expect(x.value!.rowCount).toBeGreaterThan(LEARNERS);
    expect(x.ms).toBeLessThan(30_000);
  }, 60_000);

  it('rebuilds a single day cheaply, as the 15 minute job does', async () => {
    const one = await timed('rollup rebuild (one day)', () =>
      refreshRollups(h.db, { organizationId: ORGANIZATION.id, from: '2026-09-20', to: '2026-09-20', timezone: h.config.analytics.timezone }),
    );
    expect(one.value).toBeGreaterThan(0);
    expect(one.ms).toBeLessThan(1_500);
    const before = await h.db.selectFrom('daily_rollups').select((eb) => eb.fn.countAll().as('n')).where('date', '=', '2026-09-20').executeTakeFirstOrThrow();
    await refreshRollups(h.db, { organizationId: ORGANIZATION.id, from: '2026-09-20', to: '2026-09-20', timezone: h.config.analytics.timezone });
    const after = await h.db.selectFrom('daily_rollups').select((eb) => eb.fn.countAll().as('n')).where('date', '=', '2026-09-20').executeTakeFirstOrThrow();
    // Rebuilding is idempotent: same rows, no duplicates.
    expect(Number(after.n)).toBe(Number(before.n));
  });

  it('uses the indexes for the hot access paths', async () => {
    const plan = async (query: ReturnType<typeof sql>) => {
      const result = await h.db.transaction().execute(async (trx) => {
        await sql`set local enable_seqscan = off`.execute(trx);
        return sql<{ 'QUERY PLAN': string }>`explain ${query}`.execute(trx);
      });
      return result.rows.map((r) => r['QUERY PLAN']).join('\n');
    };
    const org = ORGANIZATION.id;
    expect(await plan(sql`select * from fact_activity where organization_id = ${org} order by occurred_at desc limit 20`)).toMatch(/fact_activity_org_time_idx/);
    expect(await plan(sql`select * from fact_assessment_attempts where organization_id = ${org} and graded_at >= ${SEED_NOW}`)).toMatch(/fact_attempts_org_graded_idx/);
    expect(await plan(sql`select * from fact_ai_sessions where user_id = ${PROGRAM.id} order by evaluated_at desc`)).toMatch(/fact_ai_sessions_user_idx/);
    expect(await plan(sql`select * from fact_enrollments where organization_id = ${org} and program_id = ${PROGRAM.id} and status = 'active'`)).toMatch(/fact_enrollments_(org_program_status|active_due)_idx/);
    expect(await plan(sql`select * from fact_lesson_events where enrollment_id = ${PROGRAM.id} order by completed_at`)).toMatch(/fact_lesson_events_pkey|fact_lesson_events_enrollment_completed_idx/);
    expect(await plan(sql`select * from daily_rollups where organization_id = ${org} and metric = 'lessons_completed' and dimension_type = 'organization' and dimension_id = ${org} and date >= '2026-01-01'`)).toMatch(/daily_rollups_pkey/);
    expect(await plan(sql`select * from dir_user_teams where team_id = ${PROGRAM.id}`)).toMatch(/dir_user_teams_team_idx/);
    expect(await plan(sql`select * from report_jobs where organization_id = ${org} and requested_by = ${PROGRAM.id} order by created_at desc`)).toMatch(/report_jobs_requester_idx/);
  });
});
