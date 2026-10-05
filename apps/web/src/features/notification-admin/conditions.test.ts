import { notification } from '@a5/contracts';
import { describe, expect, it } from 'vitest';
import {
  conditionsToRows,
  describeConditions,
  describeDelay,
  joinDelay,
  parseLiteral,
  rowsToConditions,
  splitDelay,
  validateRows,
} from './conditions';

describe('condition rows', () => {
  it('converts the API shapes to rows', () => {
    expect(
      conditionsToRows({
        passed: false,
        kind: ['quiz', 'final'],
        daysRemaining: { gte: 7, lte: 30 },
        reviewer: { ne: 'system' },
      }),
    ).toEqual([
      { field: 'passed', op: 'eq', value: 'false' },
      { field: 'kind', op: 'in', value: 'quiz, final' },
      { field: 'daysRemaining', op: 'gte', value: '7' },
      { field: 'daysRemaining', op: 'lte', value: '30' },
      { field: 'reviewer', op: 'ne', value: 'system' },
    ]);
  });

  it('round-trips through rows without changing meaning', () => {
    const original: notification.RuleConditions = {
      passed: false,
      kind: ['quiz', 'final'],
      daysRemaining: { gte: 7, lte: 30 },
      reviewer: { ne: 'system' },
    };
    const rebuilt = rowsToConditions(conditionsToRows(original));
    expect(rebuilt).toEqual(original);
    expect(notification.ruleConditionsSchema.safeParse(rebuilt).success).toBe(true);
  });

  it('keeps value types: booleans, numbers, null and text', () => {
    expect(parseLiteral('true')).toBe(true);
    expect(parseLiteral(' 12 ')).toBe(12);
    expect(parseLiteral('-0.5')).toBe(-0.5);
    expect(parseLiteral('null')).toBeNull();
    expect(parseLiteral('final')).toBe('final');
    expect(parseLiteral('12abc')).toBe('12abc');
  });

  it('produces records the API schema accepts', () => {
    const built = rowsToConditions([
      { field: 'passed', op: 'eq', value: 'false' },
      { field: 'kind', op: 'in', value: 'quiz, final' },
      { field: 'score', op: 'lt', value: '70' },
      { field: 'score', op: 'gt', value: '10' },
    ]);
    expect(built).toEqual({ passed: false, kind: ['quiz', 'final'], score: { lt: 70, gt: 10 } });
    expect(notification.ruleConditionsSchema.safeParse(built).success).toBe(true);
  });

  it('reports problems per row', () => {
    const errors = validateRows([
      { field: '', op: 'eq', value: 'x' },
      { field: 'score', op: 'gt', value: 'high' },
      { field: 'bad field', op: 'eq', value: 'x' },
      { field: 'kind', op: 'eq', value: '' },
      { field: 'kind', op: 'in', value: 'a' },
      { field: 'kind', op: 'in', value: 'b' },
    ]);
    expect([...errors.keys()]).toEqual([0, 1, 2, 3, 5]);
    expect(errors.get(1)).toMatch(/number/);
    expect(errors.get(5)).toMatch(/already listed/);
    expect(validateRows([{ field: 'passed', op: 'eq', value: 'false' }]).size).toBe(0);
  });

  it('describes conditions in words', () => {
    expect(describeConditions({ passed: false, daysRemaining: { lte: 30 } })).toEqual([
      'passed is false',
      'daysRemaining is at most 30',
    ]);
    expect(describeConditions({})).toEqual([]);
  });
});

describe('delay', () => {
  it('uses the largest whole unit', () => {
    expect(splitDelay(0)).toEqual({ value: 0, unit: 'minutes' });
    expect(splitDelay(90)).toEqual({ value: 90, unit: 'minutes' });
    expect(splitDelay(120)).toEqual({ value: 2, unit: 'hours' });
    expect(splitDelay(2880)).toEqual({ value: 2, unit: 'days' });
  });

  it('converts back and describes it', () => {
    expect(joinDelay(2, 'days')).toBe(2880);
    expect(joinDelay(3, 'hours')).toBe(180);
    expect(describeDelay(0)).toBe('Immediately');
    expect(describeDelay(60)).toBe('After 1 hour');
    expect(describeDelay(4320)).toBe('After 3 days');
  });
});
