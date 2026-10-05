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
