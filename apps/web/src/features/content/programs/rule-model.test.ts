import { describe, expect, it } from 'vitest';
import { leafRuleSchema, ruleSchema, type Rule } from '@a5/rules';
import {
  LEAF_META,
  LEAF_TYPES,
  RULE_BOUNDS,
  addChild,
  countRequirements,
  emptyGroup,
  fromDraft,
  isDraftGroup,
  newLeaf,
  removeNode,
  sameRule,
  toDraft,
  updateNode,
  validateDraft,
  type DraftGroup,
  type DraftLeaf,
} from './rule-model';

const ID = (n: number) => `0192f7a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('rule registry', () => {
  it('has an editor definition for every leaf type in the rules schema', () => {
    const schemaTypes = Object.keys(RULE_BOUNDS).sort();
    expect([...LEAF_TYPES].sort()).toEqual(schemaTypes);
  });

  it('only describes fields that exist on the schema', () => {
    for (const type of LEAF_TYPES) {
      for (const spec of LEAF_META[type].fields) {
        expect(Object.keys(RULE_BOUNDS[type]!), `${type}.${spec.name}`).toContain(spec.name);
      }
    }
  });
});

describe('new requirements', () => {
  it('start empty except for defaults declared by the schema', () => {
    const progress = newLeaf('program_completed');
    expect(progress.values).toEqual({ minPercent: 100 });
    expect(RULE_BOUNDS.program_completed?.minPercent?.default).toBe(100);
    // No threshold is invented for fields the schema leaves open.
    expect(newLeaf('assessment_score').values).toEqual({});
    expect(newLeaf('ai_scenario_score').values).toEqual({});
  });

  it('use the schema default for list fields', () => {
    expect(newLeaf('program_assessments_score').values.kinds).toEqual(['quiz']);
  });
});

describe('draft conversion', () => {
  const rule: Rule = {
    type: 'all',
    rules: [
      { type: 'lesson_completed', lessonId: ID(1) },
      {
        type: 'any',
        label: 'Either score',
        rules: [
          { type: 'assessment_score', assessmentId: ID(2), minPercent: 80 },
          { type: 'ai_scenario_score', scenarioId: ID(3), minScore: 75 },
        ],
      },
    ],
  };

  it('round-trips an existing rule without changing it', () => {
    const draft = toDraft(rule);
    expect(countRequirements(draft)).toBe(3);
    expect(fromDraft(draft)).toEqual(rule);
    expect(ruleSchema.safeParse(fromDraft(draft)).success).toBe(true);
  });

  it('treats no rule as an empty draft, and an empty draft as no rule', () => {
    const draft = toDraft(null);
    expect(draft.type).toBe('all');
    expect(draft.rules).toEqual([]);
    expect(fromDraft(draft)).toBeNull();
  });

  it('wraps a lone requirement and unwraps it again', () => {
    const lone: Rule = { type: 'phase_completed', phaseId: ID(4) };
    const draft = toDraft(lone);
    expect(isDraftGroup(draft)).toBe(true);
    expect(draft.rules).toHaveLength(1);
    expect(fromDraft(draft)).toEqual(lone);
  });

  it('drops optional fields left empty, but keeps filled ones', () => {
    const leaf: DraftLeaf = {
      ...newLeaf('ai_sessions_count'),
      values: { minCount: '3', minScore: '', scenarioIds: [] },
    };
    const root: DraftGroup = { ...emptyGroup(), rules: [leaf] };
    expect(fromDraft(root)).toEqual({ type: 'ai_sessions_count', minCount: 3 });
    leaf.values.minScore = '70';
    expect(fromDraft(root)).toEqual({ type: 'ai_sessions_count', minCount: 3, minScore: 70 });
  });
});

describe('validation', () => {
  const draftWith = (leaf: DraftLeaf): DraftGroup => ({ ...emptyGroup(), rules: [leaf] });

  it('flags missing references and thresholds in words', () => {
    const leaf = newLeaf('assessment_score');
    const problems = validateDraft(draftWith(leaf)).get(leaf.uid) ?? [];
    expect(problems).toContainEqual({ field: 'assessmentId', message: 'Choose an assessment.' });
    expect(problems.find((p) => p.field === 'minPercent')?.message).toMatch(/minimum score/i);
  });

  it('takes the allowed range from the schema', () => {
    const leaf: DraftLeaf = {
      ...newLeaf('assessment_score'),
      values: { assessmentId: ID(1), minPercent: '140' },
    };
    const problems = validateDraft(draftWith(leaf)).get(leaf.uid);
    expect(problems).toEqual([
      { field: 'minPercent', message: 'Minimum score must be between 0% and 100%.' },
    ]);
    const bounds = RULE_BOUNDS.assessment_score!.minPercent!;
    expect(`${bounds.min}% to ${bounds.max}%`).toBe('0% to 100%');
  });

  it('accepts a complete requirement', () => {
    const leaf: DraftLeaf = {
      ...newLeaf('assessment_score'),
      values: { assessmentId: ID(1), minPercent: '85' },
    };
    expect(validateDraft(draftWith(leaf)).size).toBe(0);
    expect(leafRuleSchema.safeParse(fromDraft(draftWith(leaf))).success).toBe(true);
  });

  it('requires at least one requirement in an "any of" group', () => {
    const group = emptyGroup('any');
    const root: DraftGroup = { ...emptyGroup(), rules: [group] };
    expect(validateDraft(root).get(group.uid)?.[0]?.message).toMatch(/at least one requirement/);
    // An empty "all of" is allowed: it means no requirements.
    expect(validateDraft(emptyGroup('all')).size).toBe(0);
  });

  it('rejects whole numbers below the schema minimum', () => {
    const leaf: DraftLeaf = { ...newLeaf('ai_sessions_count'), values: { minCount: '0' } };
    expect(validateDraft(draftWith(leaf)).get(leaf.uid)?.[0]).toEqual({
      field: 'minCount',
      message: 'Number of sessions must be between 1 and 1000.',
    });
  });
});

describe('tree edits', () => {
  it('adds, updates and removes nodes without mutating the original', () => {
    const root = emptyGroup();
    const leaf = newLeaf('lesson_completed');
    const withLeaf = addChild(root, root.uid, leaf);
    expect(root.rules).toHaveLength(0);
    expect(withLeaf.rules).toHaveLength(1);

    const nested = emptyGroup('any');
    const deeper = addChild(withLeaf, root.uid, nested);
    const changed = updateNode(deeper, nested.uid, (n) => ({ ...n, type: 'all' }) as typeof n);
    expect((changed.rules[1] as DraftGroup).type).toBe('all');
    expect((deeper.rules[1] as DraftGroup).type).toBe('any');

    expect(removeNode(changed, leaf.uid).rules.map((r) => r.uid)).toEqual([nested.uid]);
    expect(removeNode(changed, nested.uid).rules.map((r) => r.uid)).toEqual([leaf.uid]);
  });
});

describe('sameRule', () => {
  it('ignores key order and undefined fields', () => {
    expect(
      sameRule(
        { type: 'assessment_score', assessmentId: ID(1), minPercent: 80 },
        { minPercent: 80, type: 'assessment_score', assessmentId: ID(1), label: undefined },
      ),
    ).toBe(true);
    expect(sameRule(null, null)).toBe(true);
    expect(sameRule(null, { type: 'all', rules: [] })).toBe(false);
    expect(
      sameRule(
        { type: 'assessment_score', assessmentId: ID(1), minPercent: 80 },
        { type: 'assessment_score', assessmentId: ID(1), minPercent: 85 },
      ),
    ).toBe(false);
  });
});
