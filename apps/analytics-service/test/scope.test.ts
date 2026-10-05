import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSESSMENTS, JOURNEYS, LOCATIONS, PEOPLE, SEED_NOW, TEAMS, completedLessonKeys, type PersonKey } from '@a5/seed-data';
import { principalHeaders } from '@a5/nest-kit/testing';
import { createAnalyticsHarness, type AnalyticsHarness } from './harness.js';

let h: AnalyticsHarness;

beforeAll(async () => {
  h = await createAnalyticsHarness('scope', { seed: true });
});
afterAll(() => h?.close());

const dallasA = TEAMS[0];
const teamMembers = (dallasA.members as readonly PersonKey[]).map((k) => PEOPLE[k].id);
const journeyOf = (p: PersonKey) => JOURNEYS.find((j) => j.person === p)!;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const r1 = (n: number) => Math.round(n * 10) / 10;

async function team(who: Record<string, string>, query = '') {
  return h.http.get(`/api/v1/analytics/dashboards/team${query}`).set(who);
}

describe('manager team dashboard', () => {
  it('counts only the people in the teams the manager manages', async () => {
    const res = await team(await h.as('danielle'));
    expect(res.status).toBe(200);
    expect(res.body.meta.scope).toBe('managed');
    const { kpis } = res.body;

    const people = dallasA.members as readonly PersonKey[];
    const attempts = people.flatMap((p) => Object.values(journeyOf(p).attempts).flat() as number[]);
    const sessions = people.flatMap((p) => journeyOf(p).aiSessions.map((s) => s.score));
    expect(kpis).toMatchObject({
      headcount: 5,
      activeTrainees: 4,
      enrollments: 5,
      // Only ashlyn (certified in 2025) has completed the program.
      programCompletion: { percent: 20, numerator: 1, denominator: 5 },
      assessmentAttempts: attempts.length,
      averageAssessmentScore: r1(mean(attempts)),
      aiSessions: sessions.length,
      aiRolePlayAverage: r1(mean(sessions)),
      fieldReadyCount: 1,
      certifiedCount: 1,
    });

    // Nothing from other teams leaks into any list.
    const ids = new Set(teamMembers);
    for (const item of res.body.fallingBehind.items) expect(ids.has(item.person.id)).toBe(true);
    for (const item of res.body.requiringAttention.items) expect(ids.has(item.person.id)).toBe(true);
    for (const item of res.body.recentActivity) expect(ids.has(item.person.id)).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/Naomi|Brianna|Sofia|Jasmine/);
  });

  it('lists who is falling behind and who needs attention, with the reasons', async () => {
    const { body } = await team(await h.as('danielle'));
    const behind = Object.fromEntries(body.fallingBehind.items.map((i: { person: { displayName: string }; reasons: string[] }) => [i.person.displayName, i]));
    // marcus and tyler were due on 09-28; kayla and jordan (due 10-12) are far behind the expected pace.
    expect(behind['Marcus Delgado'].reasons).toContain('overdue');
    expect(behind['Tyler Brennan'].reasons).toContain('overdue');
    expect(behind['Kayla Simmons'].reasons).toContain('behind_pace');
    expect(behind['Kayla Simmons'].reasons).not.toContain('overdue');
    expect(behind['Kayla Simmons'].expectedPercent).toBeGreaterThan(70);
    expect(behind['Kayla Simmons'].progressPercent).toBe(16);
    expect(behind['Ashlyn Pierce']).toBeUndefined();
    expect(body.fallingBehind.total).toBe(body.fallingBehind.items.length);
    expect(body.fallingBehind.items[0].reasons).toContain('overdue');

    // marcus' only AI practice (71 against a pass mark of 75) was five days ago.
    expect(body.requiringAttention.total).toBe(1);
    expect(body.requiringAttention.items[0]).toMatchObject({
      person: { displayName: 'Marcus Delgado', teamNames: [dallasA.name] },
      reasons: [{ kind: 'low_ai_score', title: 'My Roof Looks Fine', score: 71, passingScore: 75 }],
    });
  });

  it('shows the last twenty learning events with names, newest first', async () => {
    const admin = await team(await h.as('grant'));
    const feed = admin.body.recentActivity;
    expect(feed).toHaveLength(20);
    const times = feed.map((f: { at: string }) => Date.parse(f.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(times[0]).toBeLessThanOrEqual(SEED_NOW.getTime());
    expect(feed.every((f: { person: { displayName: string } }) => f.person.displayName !== 'Unknown learner')).toBe(true);
    expect(new Set(feed.map((f: { kind: string }) => f.kind)).size).toBeGreaterThan(2);
    const manager = await team(await h.as('danielle'));
    expect(manager.body.recentActivity.length).toBeLessThanOrEqual(20);
    expect(manager.body.recentActivity.length).toBeGreaterThan(0);
  });

  it('reports certifications expiring within 30, 60 and 90 days', async () => {
    const storm = await team(await h.as('luis'));
    // Sofia Navarro (Fort Worth) was certified on 2024-11-22 with 24 months of validity.
    expect(storm.body.expiringCertifications).toMatchObject({ within30Days: 0, within60Days: 1, within90Days: 1 });
    expect(storm.body.expiringCertifications.items[0]).toMatchObject({
      person: { displayName: 'Sofia Navarro' },
      certificationName: 'A5 Roofing Certified Sales Representative',
      expiresAt: '2026-11-22T16:00:00.000Z',
      daysRemaining: 49,
    });
    const dallas = await team(await h.as('danielle'));
    expect(dallas.body.expiringCertifications).toMatchObject({ within30Days: 0, within60Days: 0, within90Days: 0, items: [] });
    const admin = await team(await h.as('grant'));
    expect(admin.body.expiringCertifications.within90Days).toBe(1);
  });

  it('includes direct reports and assigned trainees for managed scope without teams', async () => {
    // Hector coaches naomi, isaiah, ethan, devon and caleb but manages no team.
    const res = await team(await h.as('hector'));
    expect(res.status).toBe(200);
    expect(res.body.kpis).toMatchObject({ headcount: 5, enrollments: 5 });
    const names = res.body.recentActivity.map((a: { person: { displayName: string } }) => a.person.displayName);
    expect(names.every((n: string) => ['Naomi Fischer', 'Isaiah Grant', 'Ethan Kowalski', 'Devon Mitchell', 'Caleb Ramirez'].includes(n))).toBe(true);
  });

  it('weakest areas rank AI categories and question categories from real results', async () => {
    const { body } = await team(await h.as('grant'));
    const ai = body.weakestAreas.aiCategories;
    expect(ai.length).toBeGreaterThan(1);
    expect(ai.map((c: { averageScore: number }) => c.averageScore)).toEqual([...ai.map((c: { averageScore: number }) => c.averageScore)].sort((a: number, b: number) => a - b));
    // The seeded rubric is weakest on discovery questions.
    expect(ai[0].key).toBe('discovery');
    const questions = body.weakestAreas.questionCategories;
    expect(questions.length).toBeGreaterThan(0);
    expect(questions[0].missRatePercent).toBeGreaterThanOrEqual(questions[questions.length - 1].missRatePercent);
  });
});

describe('scope cannot be widened with filters', () => {
  it('rejects filters naming teams or people outside the manager scope', async () => {
    const danielle = await h.as('danielle');
    const foreignTeam = await team(danielle, `?teamId=${TEAMS[2].id}`);
    expect(foreignTeam.status).toBe(403);
    expect(foreignTeam.body.error.code).toBe('FORBIDDEN');
    expect((await team(danielle, `?userId=${PEOPLE.naomi.id}`)).status).toBe(403);
    expect((await team(danielle, `?teamId=${dallasA.id}`)).status).toBe(200);
    expect((await team(danielle, `?userId=${PEOPLE.marcus.id}`)).body.kpis.headcount).toBe(1);
  });

  it('intersects every other filter with the scope instead of replacing it', async () => {
    const danielle = await h.as('danielle');
    const other = await team(danielle, `?managerId=${PEOPLE.luis.id}`);
    expect(other.status).toBe(200);
    expect(other.body.kpis).toMatchObject({ headcount: 0, enrollments: 0, aiSessions: 0 });
    expect(other.body.recentActivity).toEqual([]);
    expect((await team(danielle, `?locationId=${LOCATIONS[1].id}`)).body.kpis.headcount).toBe(0);
    expect((await team(danielle, `?locationId=${LOCATIONS[0].id}`)).body.kpis.headcount).toBe(5);
    const andre = await h.as('andre');
    expect((await team(andre, `?managerId=${PEOPLE.danielle.id}`)).body.kpis.headcount).toBe(0);
    // A program filter narrows within the scope as well.
    const programOnly = await team(danielle, `?programId=0190a3b2-0000-7000-8000-0000000000ff`);
    expect(programOnly.body.kpis).toMatchObject({ headcount: 0, enrollments: 0 });
  });

  it('keeps trends inside the scope and consistent across rollup grains', async () => {
    const range = 'from=2024-01-01&to=2026-10-05&interval=month';
    const sum = (body: { points: Array<{ value: number | null }> }) => body.points.reduce((s, p) => s + (p.value ?? 0), 0);
    const expected = (dallasA.members as readonly PersonKey[]).reduce((n, p) => n + completedLessonKeys(journeyOf(p).stage).length, 0);

    const manager = await h.http.get(`/api/v1/analytics/trends/lessons_completed?${range}`).set(await h.as('danielle'));
    expect(manager.status).toBe(200);
    expect(sum(manager.body)).toBe(expected);
    // Administrators filtering to the same team read the team grain and must agree.
    const admin = await h.http.get(`/api/v1/analytics/trends/lessons_completed?${range}&teamId=${dallasA.id}`).set(await h.as('grant'));
    expect(sum(admin.body)).toBe(expected);

    const everyone = await h.http.get(`/api/v1/analytics/trends/lessons_completed?${range}`).set(await h.as('grant'));
    const all = JOURNEYS.reduce((n, j) => n + completedLessonKeys(j.stage).length, 0);
    expect(sum(everyone.body)).toBe(all);
    expect(all).toBeGreaterThan(expected);
  });

  it('validates filters', async () => {
    const admin = await h.as('grant');
    const bad = await team(admin, '?from=2026-10-05&to=2026-09-01');
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields[0]).toMatchObject({ path: 'to' });
    expect((await team(admin, '?teamId=not-a-uuid')).status).toBe(400);
    expect((await team(admin, '?from=yesterday')).status).toBe(400);
    expect((await h.http.get('/api/v1/analytics/trends/everything').set(admin)).status).toBe(400);
  });
});

describe('permissions', () => {
  it('denies the company dashboard to managers, trainers and representatives', async () => {
    for (const who of ['danielle', 'hector', 'marcus'] as const) {
      const res = await h.http.get('/api/v1/analytics/dashboards/company').set(await h.as(who));
      expect(res.status, who).toBe(403);
    }
    const rep = await team(await h.as('marcus'));
    expect(rep.status).toBe(403);
    expect((await h.http.get('/api/v1/analytics/dashboards/company')).status).toBe(401);
    const company = await h.http.get('/api/v1/analytics/dashboards/company').set(await h.as('ruth'));
    expect(company.status).toBe(200);
    expect(company.body.meta.scope).toBe('organization');
  });

  it('gives platform administrators the same organization numbers, never other organizations', async () => {
    const platform = await h.http.get('/api/v1/analytics/dashboards/company').set(await h.as('priya'));
    expect(platform.status).toBe(200);
    expect(platform.body.meta.scope).toBe('platform');
    const admin = await h.http.get('/api/v1/analytics/dashboards/company').set(await h.as('grant'));
    expect(platform.body.kpis).toEqual(admin.body.kpis);
  });

  it('never shows one organization\'s data to another, whatever the scope', async () => {
    const foreign = '0190a3b2-0000-7000-8000-0000000000b2';
    for (const scope of ['organization', 'platform'] as const) {
      const who = await principalHeaders({
        userId: '0190a3b2-0000-7000-8000-0000000000c3',
        organizationId: foreign,
        permissions: { 'analytics.view': scope, 'reports.view': scope, 'reports.export': scope },
      });
      const company = await h.http.get('/api/v1/analytics/dashboards/company').set(who);
      expect(company.status, scope).toBe(200);
      expect(company.body.kpis, scope).toMatchObject({ headcount: 0, enrollments: 0, assessmentAttempts: 0, aiSessions: 0, certifiedCount: 0 });
      expect(company.body.breakdowns, scope).toEqual({ byLocation: [], byTeam: [] });
      expect(company.body.dropOffLessons, scope).toEqual([]);
      expect(JSON.stringify(company.body), scope).not.toMatch(/Marcus|Ashlyn|Dallas/);
      const team = await h.http.get('/api/v1/analytics/dashboards/team').set(who);
      expect(team.body.recentActivity, scope).toEqual([]);
      for (const key of ['training-completion', 'assessment-performance', 'certification-status', 'course-effectiveness']) {
        expect((await h.http.get(`/api/v1/reports/${key}`).set(who)).body.total, `${scope} ${key}`).toBe(0);
      }
      const trend = await h.http.get('/api/v1/analytics/trends/lessons_completed?from=2024-01-01&to=2026-10-05&interval=month').set(who);
      expect(trend.body.points.every((p: { value: number }) => p.value === 0), scope).toBe(true);
      const summary = await h.http.get(`/api/v1/analytics/learners/${PEOPLE.marcus.id}/summary`).set(who);
      expect(summary.status, scope).toBe(404);
    }
  });

  it('keeps rollup rebuilds and settings changes for organization administrators', async () => {
    expect((await h.http.post('/api/v1/analytics/rollups/refresh').set(await h.as('danielle')).send({})).status).toBe(403);
    const queued = await h.http.post('/api/v1/analytics/rollups/refresh').set(await h.as('grant')).send({ from: '2026-09-01', to: '2026-09-30' });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ status: 'queued', from: '2026-09-01', to: '2026-09-30' });
    expect((await h.http.patch('/api/v1/analytics/settings').set(await h.as('danielle')).send({ minCohortSize: 5 })).status).toBe(403);
  });
});

describe('learner summary', () => {
  const me = (who: Record<string, string>, query = '') => h.http.get(`/api/v1/analytics/me/summary${query}`).set(who);

  it('returns only the caller\'s own data, with anonymised cohort comparisons', async () => {
    const res = await me(await h.as('marcus'));
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.person).toEqual({ id: PEOPLE.marcus.id, displayName: 'Marcus Delgado' });

    expect(body.enrollments).toHaveLength(1);
    expect(body.enrollments[0]).toMatchObject({ status: 'active', progressPercent: 32, overdue: true });
    // Week 2 learner: eight of the 25 required lessons.
    expect(body.progressTrend.requiredTotal).toBe(25);
    expect(body.progressTrend.points.at(-1)).toMatchObject({ completedLessons: 8, progressPercent: 32 });
    const counts = body.progressTrend.points.map((p: { completedLessons: number }) => p.completedLessons);
    expect(counts).toEqual([...counts].sort((a: number, b: number) => a - b));

    expect(body.quizScores).toHaveLength(1);
    const quiz = ASSESSMENTS.find((a) => a.key === 'quiz-w1')!;
    const peerBest = JOURNEYS.filter((j) => j.person !== 'marcus' && j.attempts['quiz-w1']).map((j) => Math.max(...j.attempts['quiz-w1']!));
    expect(body.quizScores[0]).toMatchObject({
      assessmentId: quiz.id,
      title: quiz.title,
      bestScore: 86,
      passed: true,
      passingPercent: 80,
      cohortAverage: r1(mean(peerBest)),
    });
    expect(body.quizScores[0].attempts).toHaveLength(1);

    expect(body.aiScores.sessions).toHaveLength(1);
    expect(body.aiScores.sessions[0]).toMatchObject({ scenarioTitle: 'My Roof Looks Fine', overallScore: 71, passed: false });
    expect(body.aiScores.categories).toHaveLength(6);
    const avg = mean(body.aiScores.categories.map((c: { myAverage: number }) => c.myAverage));
    expect(Math.abs(avg - 71)).toBeLessThan(0.51);
    expect(body.aiScores.categories.every((c: { cohortAverage: number | null }) => typeof c.cohortAverage === 'number')).toBe(true);

    expect(body.comparisons).toMatchObject({ cohortSize: 15, minimumCohortSize: 3 });
    expect(body.comparisons.aiAverage.mine).toBe(71);
    expect(typeof body.comparisons.aiAverage.cohort).toBe('number');

    // Comparisons are anonymous aggregates: nobody else appears anywhere in the response.
    const text = JSON.stringify(body);
    for (const [key, p] of Object.entries(PEOPLE)) {
      if (key === 'marcus') continue;
      expect(text).not.toContain(p.id);
      expect(text).not.toContain(p.firstName);
    }
  });

  it('shows empty states for a learner who has not been assessed yet', async () => {
    const body = (await me(await h.as('kayla'))).body;
    expect(body.quizScores).toEqual([]);
    expect(body.aiScores).toEqual({ sessions: [], categories: [] });
    expect(body.comparisons.assessmentAverage.mine).toBeNull();
    expect(body.comparisons.aiAverage.mine).toBeNull();
    expect(body.progressTrend.points.at(-1).completedLessons).toBe(4);
  });

  it('is available to anyone who can take training, and to nobody else', async () => {
    expect((await me(await h.as('danielle'))).status).toBe(200);
    expect((await me(await h.as('danielle'))).body.person.id).toBe(PEOPLE.danielle.id);
    expect((await me(await h.custom(PEOPLE.ruth.id, { 'analytics.view': 'organization' }))).status).toBe(403);
    expect((await h.http.get('/api/v1/analytics/me/summary')).status).toBe(401);
  });

  it('never lets a representative read someone else\'s summary', async () => {
    const rep = await h.as('marcus');
    expect((await h.http.get(`/api/v1/analytics/learners/${PEOPLE.tyler.id}/summary`).set(rep)).status).toBe(403);
    expect((await h.http.get(`/api/v1/analytics/learners/${PEOPLE.marcus.id}/summary`).set(rep)).status).toBe(403);
    // The query string cannot redirect the self-service endpoint to another learner.
    const sneaky = await me(rep, `?userId=${PEOPLE.tyler.id}`);
    expect(sneaky.body.person.id).toBe(PEOPLE.marcus.id);
  });

  it('lets managers read their own people and answers 404 for everyone else', async () => {
    const danielle = await h.as('danielle');
    const own = await h.http.get(`/api/v1/analytics/learners/${PEOPLE.tyler.id}/summary`).set(danielle);
    expect(own.status).toBe(200);
    expect(own.body.person.displayName).toBe('Tyler Brennan');
    expect(own.body.quizScores[0].attempts.map((a: { scorePercent: number }) => a.scorePercent)).toEqual([70, 84]);
    const foreign = await h.http.get(`/api/v1/analytics/learners/${PEOPLE.naomi.id}/summary`).set(danielle);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('NOT_FOUND');
    expect((await h.http.get(`/api/v1/analytics/learners/${PEOPLE.naomi.id}/summary`).set(await h.as('grant'))).status).toBe(200);
  });

  it('hides cohort averages when the cohort is below the configured minimum', async () => {
    const patched = await h.http.patch('/api/v1/analytics/settings').set(await h.as('grant')).send({ minCohortSize: 20 });
    expect(patched.status).toBe(200);
    expect(patched.body.settings.minCohortSize).toBe(20);
    const body = (await me(await h.as('marcus'))).body;
    expect(body.comparisons).toMatchObject({ cohortSize: 15, minimumCohortSize: 20 });
    expect(body.comparisons.aiAverage.cohort).toBeNull();
    expect(body.comparisons.progressPercent.cohort).toBeNull();
    expect(body.quizScores[0].cohortAverage).toBeNull();
    expect(body.aiScores.categories.every((c: { cohortAverage: number | null }) => c.cohortAverage === null)).toBe(true);
    const audit = await h.db.selectFrom('outbox_events').select('type').where('type', '=', 'audit.recorded').execute();
    expect(audit.length).toBeGreaterThan(0);
  });
});
