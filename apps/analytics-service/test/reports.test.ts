import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOURNEYS, PEOPLE, PROGRAM, TEAMS, type PersonKey } from '@a5/seed-data';
import { REPORT_KEYS } from '@a5/contracts/analytics';
import { createAnalyticsHarness, type AnalyticsHarness } from './harness.js';

let h: AnalyticsHarness;
let admin: Record<string, string>;

beforeAll(async () => {
  h = await createAnalyticsHarness('reports', { seed: true });
  admin = await h.as('grant');
});
afterAll(() => h?.close());

const report = (key: string, query = '', who: Record<string, string> = admin) => h.http.get(`/api/v1/reports/${key}${query}`).set(who);
const names = (rows: Array<{ employee: string }>) => rows.map((r) => r.employee);

describe('report catalogue', () => {
  it('lists the seven reports with sortable, typed columns', async () => {
    const res = await h.http.get('/api/v1/reports').set(admin);
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { key: string }) => r.key)).toEqual([...REPORT_KEYS]);
    for (const def of res.body.items) {
      expect(def.columns.length).toBeGreaterThan(4);
      expect(def.columns.some((c: { key: string }) => c.key === def.defaultSort.replace(/^-/, ''))).toBe(true);
    }
  });

  it('runs every report and returns one value per declared column', async () => {
    const expectedTotals: Record<string, number> = {
      'training-completion': 16,
      // learner x assessment pairs: ashlyn, sofia, destiny, brianna 4 each; naomi 3; caleb, jasmine 2; marcus, tyler 1.
      'assessment-performance': 4 * 4 + 3 + 2 + 2 + 1 + 1,
      'ai-coaching-performance': 8,
      // ashlyn 1, sofia 1, destiny 2 (the first was superseded).
      'certification-status': 4,
      'overdue-training': 6,
      'training-engagement': 16,
      // 4 assessments + 7 scenarios practised.
      'course-effectiveness': 4 + 7,
    };
    for (const key of REPORT_KEYS) {
      const res = await report(key, '?pageSize=100');
      expect(res.status, key).toBe(200);
      expect(res.body.total, key).toBe(expectedTotals[key]);
      expect(res.body.items, key).toHaveLength(expectedTotals[key]!);
      for (const row of res.body.items) {
        for (const column of res.body.columns) expect(row, `${key}.${column.key}`).toHaveProperty(column.key);
      }
    }
  });
});

describe('pagination and sorting', () => {
  it('pages through a report without gaps or repeats', async () => {
    const seen: string[] = [];
    let pageCount = 0;
    for (let page = 1; page <= 4; page++) {
      const res = await report('training-completion', `?pageSize=5&page=${page}&sort=-progressPercent`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page, pageSize: 5, total: 16, sort: '-progressPercent' });
      pageCount = res.body.pageCount;
      expect(res.body.items).toHaveLength(page === 4 ? 1 : 5);
      seen.push(...res.body.items.map((r: { userId: string }) => r.userId));
    }
    expect(pageCount).toBe(4);
    expect(new Set(seen).size).toBe(16);
    const past = await report('training-completion', '?pageSize=5&page=9');
    expect(past.body).toMatchObject({ items: [], total: 16, pageCount: 4 });
  });

  it('sorts by any listed column in both directions', async () => {
    const desc = await report('training-completion', '?pageSize=100&sort=-progressPercent');
    const progress = desc.body.items.map((r: { progressPercent: number }) => r.progressPercent);
    expect(progress).toEqual([...progress].sort((a: number, b: number) => b - a));
    expect(progress[0]).toBe(100);

    const byName = await report('training-completion', '?pageSize=100&sort=employee');
    const sorted = names(byName.body.items);
    expect(sorted).toEqual([...sorted].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    expect(sorted[0]).toBe('Ashlyn Pierce');
    expect(names((await report('training-completion', '?pageSize=100&sort=-employee')).body.items)[0]).toBe('Tyler Brennan');

    const due = await report('training-completion', '?pageSize=100&sort=completedAt');
    // Nulls (not completed) sort last.
    const completed = due.body.items.map((r: { completedAt: string | null }) => r.completedAt);
    expect(completed.slice(0, 3).every((c: string | null) => c !== null)).toBe(true);
    expect(completed.slice(3).every((c: string | null) => c === null)).toBe(true);
  });

  it('rejects unknown sort keys, page sizes and reports with actionable messages', async () => {
    const sort = await report('training-completion', '?sort=password');
    expect(sort.status).toBe(400);
    expect(sort.body.error.fields[0]).toMatchObject({ path: 'sort' });
    expect(sort.body.error.fields[0].message).toContain('employee');
    expect((await report('training-completion', '?sort=employee;drop')).status).toBe(400);
    expect((await report('training-completion', '?pageSize=101')).status).toBe(400);
    expect((await report('training-completion', '?page=0')).status).toBe(400);
    expect((await report('payroll')).status).toBe(400);
  });

  it('searches by employee name', async () => {
    const res = await report('training-completion', '?q=delgado');
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({ employee: 'Marcus Delgado', employeeId: 'A5-1201', team: 'Dallas Residential A', location: 'Dallas' });
    expect((await report('training-completion', '?q=%25')).body.total).toBe(0);
  });
});

describe('report content', () => {
  it('training completion shows progress, dates and overdue state per enrollment', async () => {
    const rows = (await report('training-completion', '?pageSize=100')).body.items as Array<Record<string, unknown>>;
    const ashlyn = rows.find((r) => r.employee === 'Ashlyn Pierce')!;
    expect(ashlyn).toMatchObject({ program: PROGRAM.title, status: 'completed', progressPercent: 100, overdue: false, requiredTotal: 25, requiredCompleted: 25 });
    expect(ashlyn.enrolledAt).toBe('2025-03-03T14:00:00.000Z');
    expect(ashlyn.daysToComplete).toBeGreaterThan(0);
    const marcus = rows.find((r) => r.employee === 'Marcus Delgado')!;
    expect(marcus).toMatchObject({ status: 'active', overdue: true, completedAt: null, daysToComplete: null });
    expect(rows.filter((r) => r.overdue)).toHaveLength(6);
  });

  it('assessment performance summarises attempts per learner and assessment', async () => {
    const rows = (await report('assessment-performance', '?pageSize=100&q=castillo')).body.items as Array<Record<string, unknown>>;
    const quiz2 = rows.find((r) => r.assessment === 'Week 2 Knowledge Check')!;
    expect(quiz2).toMatchObject({ employee: 'Brianna Castillo', attempts: 2, bestScore: 88, latestScore: 88, averageScore: 81, passed: true, kind: 'quiz' });
    expect(Date.parse(quiz2.firstPassedAt as string)).toBeGreaterThan(0);
    const rowsAll = (await report('assessment-performance', '?pageSize=100&sort=-attempts')).body.items as Array<{ attempts: number }>;
    expect(rowsAll[0]!.attempts).toBe(2);
    const failed = (await report('assessment-performance', '?pageSize=100')).body.items.filter((r: { passed: boolean }) => !r.passed);
    expect(failed).toHaveLength(0);
  });

  it('AI coaching performance reports sessions, pass rate and rubric strengths', async () => {
    const ashlyn = (await report('ai-coaching-performance', '?q=pierce')).body.items[0];
    expect(ashlyn).toMatchObject({ sessions: 5, averageScore: 83.6, bestScore: 88, latestScore: 88, passRate: 100, scenariosPracticed: 5 });
    expect(ashlyn.weakestCategory).toBe('Discovery questions');
    expect(ashlyn.strongestCategory).toBe('Compliance & honesty');
    const marcus = (await report('ai-coaching-performance', '?q=delgado')).body.items[0];
    expect(marcus).toMatchObject({ sessions: 1, averageScore: 71, passRate: 0 });
  });

  it('certification status shows issued, superseded and days until expiry', async () => {
    const rows = (await report('certification-status', '?pageSize=100&sort=issuedAt')).body.items as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.employee, r.status])).toEqual([
      ['Sofia Navarro', 'issued'],
      ['Ashlyn Pierce', 'issued'],
      ['Destiny Morales', 'superseded'],
      ['Destiny Morales', 'issued'],
    ]);
    const sofia = rows.find((r) => r.employee === 'Sofia Navarro')!;
    expect(sofia).toMatchObject({ certification: 'A5 Roofing Certified Sales Representative', expiresAt: '2026-11-22T16:00:00.000Z', daysUntilExpiry: 49 });
    expect(String(sofia.certificateNumber)).toMatch(/^A5-SALES-\d{4}-\d{6}$/);
    expect(rows.find((r) => r.status === 'superseded')!.daysUntilExpiry).toBeNull();
    const sorted = (await report('certification-status', '?sort=expiresAt')).body.items;
    expect(sorted[0].employee).toBe('Sofia Navarro');
  });

  it('overdue training lists past-due enrollments with their managers, most overdue first', async () => {
    const res = await report('overdue-training');
    expect(res.body.total).toBe(6);
    const days = res.body.items.map((r: { daysOverdue: number }) => r.daysOverdue);
    expect(days).toEqual([...days].sort((a: number, b: number) => b - a));
    const brianna = res.body.items[0];
    expect(brianna).toMatchObject({ employee: 'Brianna Castillo', managers: 'Andre Coleman', daysOverdue: 63 });
    const marcus = res.body.items.find((r: { employee: string }) => r.employee === 'Marcus Delgado');
    expect(marcus.managers).toBe('Danielle Okafor');
    expect(marcus.daysOverdue).toBe(7);
  });

  it('training engagement counts activity inside the date range', async () => {
    const all = (await report('training-engagement', '?pageSize=100')).body.items as Array<Record<string, unknown>>;
    const marcus = all.find((r) => r.employee === 'Marcus Delgado')!;
    expect(marcus).toMatchObject({ lessonsCompleted: 8, assessmentsTaken: 1, aiSessions: 1 });
    expect(marcus.activeDays).toBeGreaterThan(1);
    expect(marcus.daysSinceActivity).toBe(4);
    const kayla = all.find((r) => r.employee === 'Kayla Simmons')!;
    expect(kayla).toMatchObject({ lessonsCompleted: 4, assessmentsTaken: 0, aiSessions: 0 });

    const lastWeek = (await report('training-engagement', '?pageSize=100&from=2026-09-28&to=2026-10-05')).body.items as Array<Record<string, unknown>>;
    expect(lastWeek).toHaveLength(16);
    const total = (rows: Array<Record<string, unknown>>) => rows.reduce((s, r) => s + (r.lessonsCompleted as number), 0);
    expect(total(lastWeek)).toBeLessThan(total(all));
    expect(total(lastWeek)).toBeGreaterThan(0);
    expect((await report('training-engagement', '?pageSize=100&userId=' + PEOPLE.kayla.id)).body.total).toBe(1);
  });

  it('course effectiveness compares assessments and AI scenarios', async () => {
    const rows = (await report('course-effectiveness', '?pageSize=100&sort=item')).body.items as Array<Record<string, unknown>>;
    const quiz1 = rows.find((r) => r.item === 'Week 1 Knowledge Check')!;
    const quiz1Attempts = JOURNEYS.flatMap((j) => j.attempts['quiz-w1'] ?? []);
    // Nine learners made ten attempts; only tyler's first (70) failed.
    expect(quiz1).toMatchObject({ itemType: 'Assessment', program: PROGRAM.title, learners: 9, attempts: quiz1Attempts.length });
    expect(quiz1Attempts).toHaveLength(10);
    expect(quiz1.passRate).toBe(90);
    expect(quiz1.firstAttemptPassRate).toBe(88.9);
    expect(quiz1.averageAttemptsToPass).toBe(1.1);
    // Five learners, six sessions: naomi needed a second go (72, then 81).
    const spouse = rows.find((r) => r.item === 'Talk to My Spouse')!;
    expect(spouse).toMatchObject({ itemType: 'AI scenario', learners: 5, attempts: 6, passRate: 83.3, firstAttemptPassRate: 80, averageAttemptsToPass: 1.2 });
  });
});

describe('scope and filters in reports', () => {
  it('limits managers to their teams and refuses filters outside them', async () => {
    const danielle = await h.as('danielle');
    const res = await report('training-completion', '?pageSize=100', danielle);
    expect(res.body.total).toBe(5);
    const inTeam = new Set((TEAMS[0].members as readonly PersonKey[]).map((p) => PEOPLE[p].id));
    expect(res.body.items.every((r: { userId: string }) => inTeam.has(r.userId))).toBe(true);
    for (const key of REPORT_KEYS) {
      const own = await report(key, '?pageSize=100', danielle);
      expect(own.status, key).toBe(200);
      expect(JSON.stringify(own.body), key).not.toMatch(/Naomi|Brianna|Sofia|Jasmine|Destiny/);
    }
    expect((await report('training-completion', `?teamId=${TEAMS[1].id}`, danielle)).status).toBe(403);
    expect((await report('training-completion', `?userId=${PEOPLE.naomi.id}`, danielle)).status).toBe(403);
    expect((await report('training-completion', `?managerId=${PEOPLE.andre.id}`, danielle)).body.total).toBe(0);
  });

  it('applies team, program, date and employee filters', async () => {
    expect((await report('training-completion', `?teamId=${TEAMS[2].id}`)).body.total).toBe(4);
    expect((await report('training-completion', `?programId=${PROGRAM.id}`)).body.total).toBe(16);
    expect((await report('training-completion', '?programId=0190a3b2-0000-7000-8000-0000000000ff')).body.total).toBe(0);
    // Seven people enrolled in September (four on the 14th, three on the 28th).
    expect((await report('training-completion', '?from=2026-09-01&to=2026-09-30')).body.total).toBe(7);
    expect((await report('certification-status', '?from=2025-01-01&to=2025-12-31')).body.total).toBe(3);
    expect((await report('assessment-performance', `?userId=${PEOPLE.ashlyn.id}`)).body.total).toBe(4);
  });

  it('requires reports.view', async () => {
    expect((await report('training-completion', '', await h.as('hector'))).status).toBe(403);
    expect((await report('training-completion', '', await h.as('marcus'))).status).toBe(403);
    expect((await h.http.get('/api/v1/reports/training-completion')).status).toBe(401);
    expect((await report('training-completion', '', await h.as('ruth'))).status).toBe(200);
  });
});
