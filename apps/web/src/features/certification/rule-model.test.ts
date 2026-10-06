import { describe, expect, it } from 'vitest';
import { ruleSchema, type Rule } from '@a5/rules';
import {
  UNSET,
  appendAt,
  asGroup,
  cleanRule,
  countLeaves,
  newLeaf,
  nodeAt,
  removeAt,
  replaceAt,
  ruleProblems,
  stripApprovals,
} from './rule-model';

const ID = '0190aaaa-0000-7000-8000-0000000000a1';

describe('newLeaf', () => {
  it('starts every threshold blank so the administrator chooses it', () => {
    expect(newLeaf('assessment_score')).toMatchObject({ assessmentId: '', minPercent: UNSET });
    expect(Number.isNaN((newLeaf('ai_average_score') as { minScore: number }).minScore)).toBe(true);
    expect(Number.isNaN((newLeaf('days_since_enrollment') as { days: number }).days)).toBe(true);
  });
});

describe('ruleProblems', () => {
  it('flags blank choices and thresholds with a message and the path of the requirement', () => {
    const rule: Rule = {
      type: 'all',
      rules: [
        { type: 'program_completed', programId: ID, minPercent: 100 },
        newLeaf('assessment_score'),
        { type: 'any', rules: [newLeaf('ai_sessions_count')] },
      ],
    };
    expect(ruleProblems(rule)).toEqual([
      { path: [1], message: 'Choose an assessment.' },
      { path: [2, 0], message: 'Enter a number of sessions between 1 and 1,000.' },
    ]);
  });

  it('checks ranges and whole numbers', () => {
    const at = (r: Rule) => ruleProblems({ type: 'all', rules: [r] })[0]?.message;
    expect(at({ type: 'assessment_score', assessmentId: ID, minPercent: 101 })).toMatch(
      /between 0 and 100/,
    );
    expect(at({ type: 'ai_sessions_count', minCount: 2.5 })).toMatch(/between 1 and 1,000/);
    expect(at({ type: 'ai_average_score', minScore: 80, lastN: 0 })).toMatch(/between 1 and 1,000/);
    expect(
      at({ type: 'program_assessments_score', programId: ID, minPercent: 80, kinds: [] }),
    ).toMatch(/at least one kind/);
    expect(at({ type: 'date_reached', date: '' })).toBe('Choose a date.');
    expect(at({ type: 'assessment_score', assessmentId: ID, minPercent: 85 })).toBeUndefined();
  });

  it('does not accept an empty choice group', () => {
    expect(ruleProblems({ type: 'all', rules: [{ type: 'any', rules: [] }] })).toEqual([
      { path: [0], message: 'Add at least one requirement to this group, or remove it.' },
    ]);
  });
});

describe('editing a tree', () => {
  const a: Rule = { type: 'program_completed', programId: ID, minPercent: 100 };
  const b: Rule = { type: 'assessment_score', assessmentId: ID, minPercent: 80 };
  const root: Rule = { type: 'all', rules: [a, { type: 'any', rules: [b] }] };

  it('reads, replaces, appends and removes by path without mutating the original', () => {
    expect(nodeAt(root, [1, 0])).toEqual(b);
    const changed = replaceAt(root, [1, 0], { ...b, minPercent: 90 } as Rule);
    expect(nodeAt(changed, [1, 0])).toMatchObject({ minPercent: 90 });
    expect(nodeAt(root, [1, 0])).toMatchObject({ minPercent: 80 });

    const grown = appendAt(root, [1], a);
    expect(countLeaves(grown)).toBe(3);
    expect(countLeaves(root)).toBe(2);

    const shrunk = removeAt(root, [0]);
    expect(countLeaves(shrunk)).toBe(1);
    expect(removeAt(root, [])).toBe(root);
  });

  it('turns a lone requirement into a group the editor can work with', () => {
    expect(asGroup(a)).toEqual({ type: 'all', rules: [a] });
    expect(asGroup(root)).toBe(root);
  });
});

describe('cleanRule', () => {
  it('produces a rule the shared schema accepts once blanks are filled', () => {
    const draft: Rule = {
      type: 'all',
      rules: [
        { type: 'ai_sessions_count', minCount: 5, minScore: undefined, scenarioIds: [] },
        { type: 'program_completed', programId: ID, minPercent: 100, label: '' },
      ],
    };
    const cleaned = cleanRule(draft);
    expect(ruleSchema.safeParse(cleaned).success).toBe(true);
    expect(cleaned).toEqual({
      type: 'all',
      rules: [
        { type: 'ai_sessions_count', minCount: 5 },
        { type: 'program_completed', programId: ID, minPercent: 100 },
      ],
    });
  });

  it('keeps custom wording that was typed', () => {
    const cleaned = cleanRule({
      type: 'all',
      rules: [{ type: 'days_since_enrollment', days: 14, label: 'Two weeks in' }],
    });
    expect(cleaned).toEqual({
      type: 'all',
      rules: [{ type: 'days_since_enrollment', days: 14, label: 'Two weeks in' }],
    });
  });
});

describe('stripApprovals', () => {
  it('removes approval requirements, including inside choices, and drops groups left empty', () => {
    const rule: Rule = {
      type: 'all',
      rules: [
        { type: 'program_completed', programId: ID, minPercent: 100 },
        { type: 'any', rules: [{ type: 'approval', kind: 'manager' }] },
        { type: 'approval', kind: 'manager' },
      ],
    };
    expect(stripApprovals(rule)).toEqual({
      type: 'all',
      rules: [{ type: 'program_completed', programId: ID, minPercent: 100 }],
    });
  });
});
