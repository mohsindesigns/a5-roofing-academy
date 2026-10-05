import { describe, expect, it } from 'vitest';
import { checklist, describeRule, evaluateRule, ruleSchema, unmetLeaves, type Rule } from './index.js';

const W1 = '0190a3b2-0000-7000-8000-000000000001';
const QUIZ = '0190a3b2-0000-7000-8000-000000000002';
const SCEN = '0190a3b2-0000-7000-8000-000000000003';
const PROGRAM = '0190a3b2-0000-7000-8000-000000000004';

const week2Unlock: Rule = {
  type: 'all',
  rules: [
    { type: 'phase_completed', phaseId: W1 },
    { type: 'assessment_score', assessmentId: QUIZ, minPercent: 80 },
    { type: 'ai_scenario_score', scenarioId: SCEN, minScore: 75 },
  ],
};

describe('ruleSchema', () => {
  it('parses nested rules and applies defaults', () => {
    const parsed = ruleSchema.parse({
      type: 'all',
      rules: [{ type: 'program_completed', programId: PROGRAM }, week2Unlock],
    });
    expect(parsed.type).toBe('all');
    const first = (parsed as Extract<Rule, { type: 'all' }>).rules[0];
    expect(first).toMatchObject({ type: 'program_completed', minPercent: 100 });
  });

  it('rejects out-of-range thresholds', () => {
    expect(() =>
      ruleSchema.parse({ type: 'assessment_score', assessmentId: QUIZ, minPercent: 120 }),
    ).toThrow();
  });
});

describe('evaluateRule', () => {
  it('unlocks week 2 only when every condition holds', () => {
    const base = {
      phaseCompleted: () => true,
      assessmentBestScore: () => 85,
      aiScenarioBestScore: () => 70,
    };
    const locked = evaluateRule(week2Unlock, base);
    expect(locked.satisfied).toBe(false);
    expect(unmetLeaves(locked).map((r) => r.rule.type)).toEqual(['ai_scenario_score']);

    const unlocked = evaluateRule(week2Unlock, { ...base, aiScenarioBestScore: () => 75 });
    expect(unlocked.satisfied).toBe(true);
    expect(unlocked.progress).toEqual({ current: 3, target: 3, unit: 'count' });
  });

  it('treats missing facts as unknown and unmet', () => {
    const result = evaluateRule({ type: 'approval', kind: 'manager' }, {});
    expect(result).toMatchObject({ satisfied: false, unknown: true });
  });

  it('counts AI sessions with an optional minimum score', () => {
    const sessions = [80, 90, 60, 85, 82].map((score) => ({ scenarioId: SCEN, score }));
    const rule: Rule = { type: 'ai_sessions_count', minCount: 4, minScore: 80 };
    const result = evaluateRule(rule, { aiSessions: () => sessions });
    expect(result.satisfied).toBe(true);
    expect(result.progress?.current).toBe(4);
  });

  it('averages AI scores over the most recent N sessions', () => {
    const sessions = [90, 90, 50, 50].map((score) => ({ scenarioId: SCEN, score }));
    expect(
      evaluateRule({ type: 'ai_average_score', minScore: 80, lastN: 2 }, { aiSessions: () => sessions })
        .satisfied,
    ).toBe(true);
    expect(
      evaluateRule({ type: 'ai_average_score', minScore: 80 }, { aiSessions: () => sessions }).satisfied,
    ).toBe(false);
  });

  it('does not satisfy program assessment rules when the program has no assessments', () => {
    const rule: Rule = { type: 'program_assessments_score', programId: PROGRAM, minPercent: 80, kinds: ['quiz'] };
    expect(evaluateRule(rule, { programAssessments: () => [] }).satisfied).toBe(false);
    expect(
      evaluateRule(rule, {
        programAssessments: () => [
          { assessmentId: QUIZ, bestScore: 92 },
          { assessmentId: W1, bestScore: 81 },
        ],
      }).satisfied,
    ).toBe(true);
  });

  it('any-groups pass when one child passes', () => {
    const rule: Rule = {
      type: 'any',
      rules: [
        { type: 'approval', kind: 'manager' },
        { type: 'approval', kind: 'trainer' },
      ],
    };
    const result = evaluateRule(rule, { approval: (kind) => kind === 'trainer' });
    expect(result.satisfied).toBe(true);
    expect(unmetLeaves(result)).toEqual([]);
  });

  it('days since enrollment uses the injected clock', () => {
    const rule: Rule = { type: 'days_since_enrollment', days: 7 };
    const enrolledAt = () => new Date('2026-01-01T00:00:00Z');
    expect(evaluateRule(rule, { enrolledAt, now: () => new Date('2026-01-05T00:00:00Z') }).satisfied).toBe(false);
    expect(evaluateRule(rule, { enrolledAt, now: () => new Date('2026-01-08T00:00:00Z') }).satisfied).toBe(true);
  });

  it('builds a checklist from a root all-group', () => {
    const result = evaluateRule(week2Unlock, {
      phaseCompleted: () => true,
      assessmentBestScore: () => 60,
      aiScenarioBestScore: () => 90,
    });
    expect(checklist(result).map((c) => c.satisfied)).toEqual([true, false, true]);
  });
});

describe('describeRule', () => {
  it('uses resolved names and thresholds from the rule', () => {
    const text = describeRule(
      { type: 'assessment_score', assessmentId: QUIZ, minPercent: 80 },
      { assessment: () => 'Week 1 Knowledge Check' },
    );
    expect(text).toBe('Score 80% or higher on "Week 1 Knowledge Check"');
  });

  it('prefers administrator labels', () => {
    expect(describeRule({ type: 'approval', kind: 'manager', label: 'Field Ready sign-off' })).toBe(
      'Field Ready sign-off',
    );
  });
});
