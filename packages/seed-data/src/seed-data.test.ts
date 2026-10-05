import { describe, expect, it } from 'vitest';
import { PEOPLE, TEAMS, emailOf, seedId } from './index.js';

describe('seed data', () => {
  it('produces stable, valid UUIDs', () => {
    expect(seedId('x')).toBe(seedId('x'));
    expect(seedId('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('has unique people, emails and employee ids', () => {
    const people = Object.values(PEOPLE);
    expect(new Set(people.map((p) => p.id)).size).toBe(people.length);
    expect(new Set(people.map(emailOf)).size).toBe(people.length);
    expect(new Set(people.map((p) => p.employeeId)).size).toBe(people.length);
  });
  it('puts every rep in exactly one team', () => {
    const reps = Object.entries(PEOPLE).filter(([, p]) => p.roles.includes('sales_rep')).map(([k]) => k);
    for (const rep of reps) expect(TEAMS.filter((t) => (t.members as readonly string[]).includes(rep))).toHaveLength(1);
  });
});

import { ASSESSMENTS, JOURNEYS, PHASES, SCENARIOS, allLessons, completedLessonKeys } from './index.js';

describe('academy catalogue', () => {
  it('references existing assessments and scenarios from lessons', () => {
    for (const l of allLessons()) {
      if (l.type === 'quiz' || l.type === 'final_assessment') expect(ASSESSMENTS.some((a) => a.key === l.ref), l.key).toBe(true);
      if (l.type === 'ai_simulation') expect(SCENARIOS.some((s) => s.key === l.ref), l.key).toBe(true);
    }
  });
  it('has unique ids', () => {
    const ids = [...PHASES.map((p) => p.id), ...allLessons().map((l) => l.id), ...ASSESSMENTS.map((a) => a.id), ...SCENARIOS.map((s) => s.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('journeys reference known lessons and scenarios', () => {
    const lessonKeys = new Set(allLessons().map((l) => l.key));
    for (const j of JOURNEYS) {
      for (const key of completedLessonKeys(j.stage)) expect(lessonKeys.has(key), key).toBe(true);
      for (const s of j.aiSessions) expect(SCENARIOS.some((x) => x.key === s.scenario)).toBe(true);
    }
  });
});
