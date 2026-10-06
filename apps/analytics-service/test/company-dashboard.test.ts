import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEPARTMENTS, LOCATIONS, PEOPLE, PROGRAM, TEAMS } from '@a5/seed-data';
import { RollupService } from '../src/rollups/rollup.service.js';
import { createAnalyticsHarness, type AnalyticsHarness } from './harness.js';
import { NOW, fixtureEvents } from './fixture.js';

let h: AnalyticsHarness;
let admin: Record<string, string>;

beforeAll(async () => {
  h = await createAnalyticsHarness('company', { now: NOW });
  await h.apply(...fixtureEvents());
  await h.app.get(RollupService, { strict: false }).processDirty();
  admin = await h.as('grant');
});
afterAll(() => h?.close());

const company = async (query = '') => {
  const res = await h.http.get(`/api/v1/analytics/dashboards/company${query}`).set(admin);
  expect(res.status).toBe(200);
  return res.body;
};

const pct = (percent: number | null, numerator: number, denominator: number) => ({
  percent,
  numerator,
  denominator,
});

describe('company dashboard (hand-computed fixture)', () => {
  it('computes the headline KPIs from the facts', async () => {
    const { kpis, meta } = await company();
    expect(meta).toMatchObject({
      scope: 'organization',
      timezone: 'America/Chicago',
      generatedAt: NOW.toISOString(),
    });
    expect(kpis).toMatchObject({
      // All sixteen team members of the directory, whether or not they have started.
      headcount: 16,
      // marcus and isaiah still have an active enrollment.
      activeTrainees: 2,
      enrollments: 5,
      // tyler, ashlyn and naomi completed: 3 of 5.
      programCompletion: pct(60, 3, 5),
      // (30 + 100 + 100 + 50 + 100) / 5
      averageProgressPercent: 76,
      // (60 + 90 + 80 + 70 + 88 + 100 + 91) / 7 = 82.71
      averageAssessmentScore: 82.7,
      assessmentAttempts: 7,
      // (60 + 80 + 70 + 90 + 50) / 5
      aiRolePlayAverage: 70,
      aiSessions: 5,
      // Completed and passed the final: tyler, naomi, ashlyn.
      fieldReadyCount: 3,
      // Active certificates: tyler and ashlyn (naomi awaits approval).
      certifiedCount: 2,
      // 3 completed against 1 overdue active enrollment (marcus; isaiah is due on 10-08).
      trainingCompletionRate: pct(75, 3, 4),
      // (19 + 18 + 24) / 3
      averageCompletionDays: 20.3,
      overdueEnrollments: 1,
      // Failed attempts: marcus 60 and naomi 70, of 7.
      quizFailureRate: pct(28.6, 2, 7),
      // Eligible: ashlyn, tyler, naomi; issued: ashlyn, tyler.
      certificationConversion: pct(66.7, 2, 3),
      // tyler 09-01 14:00 -> 09-24 10:00 = 22.83 d, ashlyn 08-01 14:00 -> 08-27 14:00 = 26.0 d.
      averageDaysToCertification: 24.4,
      medianDaysToCertification: 24.4,
    });
  });

  it('breaks the numbers down by location and team', async () => {
    const { breakdowns } = await company();
    const byName = (rows: Array<{ name: string }>, name: string) =>
      rows.find((r) => r.name === name)!;
    expect(breakdowns.byLocation.map((r: { name: string }) => r.name)).toEqual([
      'Austin',
      'Dallas',
      'Fort Worth',
    ]);
    expect(byName(breakdowns.byLocation, 'Dallas')).toMatchObject({
      id: LOCATIONS[0].id,
      headcount: 8,
      activeTrainees: 1,
      programCompletion: pct(66.7, 2, 3),
      averageProgressPercent: 76.7,
      // marcus 60, 90; tyler 80, 88; ashlyn 91.
      averageAssessmentScore: 81.8,
      // marcus 60, 80; tyler 70.
      aiRolePlayAverage: 70,
      certifiedCount: 2,
      overdueEnrollments: 1,
    });
    expect(byName(breakdowns.byLocation, 'Fort Worth')).toMatchObject({
      headcount: 4,
      activeTrainees: 1,
      programCompletion: pct(50, 1, 2),
      averageProgressPercent: 75,
      averageAssessmentScore: 85,
      aiRolePlayAverage: 70,
      certifiedCount: 0,
      overdueEnrollments: 0,
    });
    // No enrollments yet: real empty values, not zeros.
    expect(byName(breakdowns.byLocation, 'Austin')).toMatchObject({
      headcount: 4,
      programCompletion: pct(null, 0, 0),
      averageProgressPercent: null,
      averageAssessmentScore: null,
      aiRolePlayAverage: null,
    });
    expect(byName(breakdowns.byTeam, TEAMS[0].name)).toMatchObject({
      headcount: 5,
      programCompletion: pct(66.7, 2, 3),
      certifiedCount: 2,
    });
    expect(byName(breakdowns.byTeam, TEAMS[1].name)).toMatchObject({
      headcount: 3,
      programCompletion: pct(null, 0, 0),
    });
  });

  it('finds the hardest question, the most failed objection and the weakest areas', async () => {
    const { hardestQuestions, mostFailedObjections, weakestAreas } = await company();
    expect(hardestQuestions).toHaveLength(2);
    expect(hardestQuestions[0]).toMatchObject({
      prompt: 'What is the first commitment A5 makes to every homeowner?',
      assessmentTitle: 'Week 1 Knowledge Check',
      categoryName: 'Company & culture',
      answered: 4,
      incorrect: 2,
      missRatePercent: 50,
    });
    expect(hardestQuestions[1]).toMatchObject({
      answered: 4,
      incorrect: 1,
      missRatePercent: 25,
      categoryName: 'Customer journey',
    });

    expect(mostFailedObjections[0]).toMatchObject({
      title: 'Talk to My Spouse',
      category: 'Decision maker',
      sessions: 3,
      failed: 2,
      failureRatePercent: 66.7,
      averageScore: 73.3,
    });
    expect(mostFailedObjections[1]).toMatchObject({
      title: 'Another Roofer Is Cheaper',
      sessions: 1,
      failed: 1,
      failureRatePercent: 100,
      averageScore: 50,
    });
    expect(mostFailedObjections).toHaveLength(2);

    expect(weakestAreas.aiCategories).toEqual([
      { key: 'discovery', label: 'Discovery questions', averageScore: 60, sessions: 5 },
      { key: 'rapport', label: 'Rapport & tone', averageScore: 80, sessions: 5 },
    ]);
    expect(
      weakestAreas.questionCategories.map((c: { name: string; missRatePercent: number }) => [
        c.name,
        c.missRatePercent,
      ]),
    ).toEqual([
      ['Company & culture', 50],
      ['Customer journey', 25],
    ]);
  });

  it('ranks drop-off lessons by how long learners stay on them, including those still stuck', async () => {
    const { dropOffLessons } = await company();
    expect(dropOffLessons.map((l: { title: string }) => l.title)).toEqual([
      'From Door Knock to Final Walkthrough',
      'Sales Code of Conduct Acknowledgment',
      'How A5 Earns Homeowner Trust',
      'Welcome from Leadership',
    ]);
    // isaiah has been on the journey lesson since 09-12 15:00: exactly 23 days.
    expect(dropOffLessons[0]).toMatchObject({
      completions: 0,
      stalledLearners: 1,
      averageDwellDays: 23,
      averageDaysStalled: 23,
      phaseTitle: 'A5 Fundamentals',
      position: 4,
    });
    // isaiah took 1.0 d; marcus has been stuck since 09-02 16:00 (32.96 d): mean 16.98.
    expect(dropOffLessons[1]).toMatchObject({
      completions: 1,
      stalledLearners: 1,
      averageDwellDays: 17,
      averageDaysStalled: 33,
      lessonType: 'acknowledgment',
    });
    // marcus 1.0, isaiah 1.0, tyler 2.0.
    expect(dropOffLessons[2]).toMatchObject({
      completions: 3,
      stalledLearners: 0,
      averageDwellDays: 1.3,
      averageDaysStalled: null,
    });
    // 2 h, 1 h, 1 h.
    expect(dropOffLessons[3]).toMatchObject({ completions: 3, averageDwellDays: 0.1 });
  });

  it('reads trends from the daily rollups', async () => {
    const body = await company('?from=2026-09-01&to=2026-09-30&interval=month');
    expect(body.aiScoreTrend).toEqual({
      interval: 'month',
      from: '2026-09-01',
      to: '2026-09-30',
      points: [{ date: '2026-09-01', value: 70, count: 5 }],
    });
    const series = Object.fromEntries(
      body.aiCompetencyTrend.series.map((s: { key: string; points: unknown[] }) => [
        s.key,
        s.points,
      ]),
    );
    expect(series.discovery).toEqual([{ date: '2026-09-01', value: 60, count: 5 }]);
    expect(series.rapport).toEqual([{ date: '2026-09-01', value: 80, count: 5 }]);
    expect(body.completionTrend.lessonsCompleted.points).toEqual([
      { date: '2026-09-01', value: 7, count: 7 },
    ]);
    expect(body.completionTrend.programsCompleted.points).toEqual([
      { date: '2026-09-01', value: 2, count: 2 },
    ]);
    // Within September: attempts 6 (ashlyn's final was in August), 2 failed; mean 81.3.
    expect(body.assessmentTrend.averageScore.points).toEqual([
      { date: '2026-09-01', value: 81.3, count: 6 },
    ]);
    expect(body.assessmentTrend.failureRate.points).toEqual([
      { date: '2026-09-01', value: 33.3, count: 6 },
    ]);

    const weekly = await h.http
      .get('/api/v1/analytics/trends/lessons_completed?from=2026-08-31&to=2026-09-20&interval=week')
      .set(admin);
    expect(weekly.status).toBe(200);
    expect(weekly.body.metric).toBe('lessons_completed');
    // Week of 08-31: marcus 2 + tyler 2. Week of 09-07: isaiah 3. Nothing in the week of 09-14.
    expect(
      weekly.body.points.map((p: { date: string; value: number }) => [p.date, p.value]),
    ).toEqual([
      ['2026-08-31', 4],
      ['2026-09-07', 3],
      ['2026-09-14', 0],
    ]);
  });

  it('narrows every figure with the date range and keeps point-in-time figures current', async () => {
    const { kpis, hardestQuestions } = await company('?from=2026-09-01&to=2026-09-30');
    expect(kpis).toMatchObject({
      // ashlyn enrolled in August.
      enrollments: 4,
      programCompletion: pct(50, 2, 4),
      assessmentAttempts: 6,
      averageAssessmentScore: 81.3,
      quizFailureRate: pct(33.3, 2, 6),
      aiSessions: 5,
      // Eligible in September: tyler, naomi; tyler was issued.
      certificationConversion: pct(50, 1, 2),
      // Only tyler's first certificate was issued in September.
      averageDaysToCertification: 22.8,
      // Point-in-time: still two active certificates, everyone counted in the headcount.
      certifiedCount: 2,
      headcount: 16,
    });
    expect(hardestQuestions[0]).toMatchObject({ answered: 4, missRatePercent: 50 });
  });

  it('filters by program, team, location, department, manager and employee', async () => {
    expect((await company(`?programId=${PROGRAM.id}`)).kpis).toMatchObject({
      enrollments: 5,
      programCompletion: pct(60, 3, 5),
      headcount: 5,
    });
    expect((await company(`?teamId=${TEAMS[0].id}`)).kpis).toMatchObject({
      headcount: 5,
      enrollments: 3,
      programCompletion: pct(66.7, 2, 3),
      aiSessions: 3,
    });
    expect((await company(`?locationId=${LOCATIONS[1].id}`)).kpis).toMatchObject({
      headcount: 4,
      enrollments: 2,
      aiSessions: 2,
      assessmentAttempts: 2,
    });
    expect((await company(`?departmentId=${DEPARTMENTS[0].id}`)).kpis).toMatchObject({
      headcount: 16,
      enrollments: 5,
    });
    // Danielle manages Dallas Residential A (marcus, tyler, ashlyn have data).
    expect((await company(`?managerId=${PEOPLE.danielle.id}`)).kpis).toMatchObject({
      headcount: 5,
      enrollments: 3,
    });
    const one = (await company(`?userId=${PEOPLE.naomi.id}`)).kpis;
    expect(one).toMatchObject({
      headcount: 1,
      enrollments: 1,
      programCompletion: pct(100, 1, 1),
      assessmentAttempts: 2,
      averageAssessmentScore: 85,
      aiRolePlayAverage: 70,
      fieldReadyCount: 1,
      certifiedCount: 0,
    });
    // The trend reads the matching rollup grain.
    const team = await h.http
      .get(
        `/api/v1/analytics/trends/lessons_completed?from=2026-09-01&to=2026-09-30&interval=month&teamId=${TEAMS[2].id}`,
      )
      .set(admin);
    expect(team.body.points).toEqual([{ date: '2026-09-01', value: 3, count: 3 }]);
    const person = await h.http
      .get(
        `/api/v1/analytics/trends/ai_score?from=2026-09-01&to=2026-09-30&interval=month&userId=${PEOPLE.naomi.id}`,
      )
      .set(admin);
    expect(person.body.points).toEqual([{ date: '2026-09-01', value: 70, count: 2 }]);
  });

  it('returns honest empty states instead of fabricated numbers', async () => {
    const none = await company(`?programId=0190a3b2-0000-7000-8000-0000000000ff`);
    expect(none.kpis).toMatchObject({
      enrollments: 0,
      programCompletion: pct(null, 0, 0),
      averageAssessmentScore: null,
      aiRolePlayAverage: null,
      trainingCompletionRate: pct(null, 0, 0),
      averageDaysToCertification: null,
      fieldReadyCount: 0,
    });
    expect(none.hardestQuestions).toEqual([]);
    expect(none.dropOffLessons).toEqual([]);
    expect(none.aiScoreTrend.points.every((p: { value: number | null }) => p.value === null)).toBe(
      true,
    );
    const quiet = await company(`?userId=${PEOPLE.kayla.id}`);
    expect(quiet.kpis).toMatchObject({ headcount: 1, enrollments: 0, aiSessions: 0 });
    expect(quiet.mostFailedObjections).toEqual([]);
  });

  it('serves repeat requests from a 60 second cache keyed by scope and filters', async () => {
    const first = await company('?teamId=' + TEAMS[0].id);
    await h.db.deleteFrom('fact_ai_sessions').where('user_id', '=', PEOPLE.marcus.id).execute();
    const second = await company('?teamId=' + TEAMS[0].id);
    expect(second.kpis.aiSessions).toBe(first.kpis.aiSessions);
    const otherFilters = await company('?teamId=' + TEAMS[0].id + '&from=2026-01-01');
    expect(otherFilters.kpis.aiSessions).toBe(1);
  });
});
