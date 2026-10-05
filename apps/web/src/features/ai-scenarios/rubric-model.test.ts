import { describe, expect, it } from 'vitest';
import {
  blankCriterion,
  isChanged,
  slugKey,
  toCriteria,
  validateRubricVersion,
  weightShares,
} from './rubric-model';

const saved = [
  {
    key: 'discovery',
    label: 'Discovery',
    description: 'Finds the concern.',
    weight: 10,
    guidance: '',
  },
  {
    key: 'closing',
    label: 'Closing',
    description: 'Proposes a next step.',
    weight: 30,
    guidance: 'Day and time.',
  },
];

describe('slugKey', () => {
  it('makes API-valid keys from labels', () => {
    expect(slugKey('Value presentation')).toBe('value_presentation');
    expect(slugKey('  Next-step closing! ')).toBe('next_step_closing');
    expect(slugKey('9 lives')).toBe('c_9_lives');
    expect(slugKey('')).toBe('');
    expect(slugKey('x'.repeat(60)).length).toBeLessThanOrEqual(40);
  });
});

describe('weightShares', () => {
  it('turns relative weights into percentages of the total', () => {
    expect(weightShares(toCriteria(saved, { existing: true }))).toEqual([25, 75]);
  });

  it('is zero when nothing is weighted', () => {
    const c = toCriteria(saved, { existing: true }).map((x) => ({ ...x, weight: '0' }));
    expect(weightShares(c)).toEqual([0, 0]);
  });
});

describe('isChanged', () => {
  const base = { categories: saved, passingScore: 75 };

  it('is false for an untouched editor, whatever order the API returned keys in', () => {
    const reordered = saved.map((c) => ({
      guidance: c.guidance,
      weight: c.weight,
      description: c.description,
      label: c.label,
      key: c.key,
    }));
    expect(
      isChanged(toCriteria(saved, { existing: true }), '75', { ...base, categories: reordered }),
    ).toBe(false);
  });

  it('detects edits, additions, reordering and a new pass mark', () => {
    const c = toCriteria(saved, { existing: true });
    expect(isChanged(c, '80', base)).toBe(true);
    expect(isChanged([{ ...c[0]!, weight: '12' }, c[1]!], '75', base)).toBe(true);
    expect(isChanged([...c, blankCriterion()], '75', base)).toBe(true);
    expect(isChanged([c[1]!, c[0]!], '75', base)).toBe(true);
  });
});

describe('validateRubricVersion', () => {
  it('accepts a valid rubric and returns the API request', () => {
    const result = validateRubricVersion(
      toCriteria(saved, { existing: true }),
      '75',
      ' Raised closing ',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.passingScore).toBe(75);
      expect(result.request.changeNote).toBe('Raised closing');
      expect(result.request.categories).toHaveLength(2);
    }
  });

  it('attaches problems to the criterion and field that caused them', () => {
    const c = toCriteria(saved, { existing: true });
    c[1] = { ...c[1]!, label: '', weight: '150' };
    const result = validateRubricVersion(c, '75', '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.criteria[c[1]!.uid]).toMatchObject({
        label: 'Required',
        weight: expect.stringMatching(/100/),
      });
      expect(result.issues.criteria[c[0]!.uid]).toBeUndefined();
    }
  });

  it('reports rubric-wide rules such as duplicate keys', () => {
    const c = toCriteria(saved, { existing: true });
    c[1] = { ...c[1]!, key: 'discovery' };
    const result = validateRubricVersion(c, '75', '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.general.join(' ')).toMatch(/unique/i);
  });

  it('asks for a number when the pass mark or a weight is blank', () => {
    const c = toCriteria(saved, { existing: true });
    c[0] = { ...c[0]!, weight: '' };
    const result = validateRubricVersion(c, '', '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.passingScore).toBeTruthy();
      expect(result.issues.criteria[c[0]!.uid]?.weight).toBe('Enter a number');
    }
  });
});
