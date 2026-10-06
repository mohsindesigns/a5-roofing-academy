import { describe, expect, it } from 'vitest';
import { formatDays, formatRatio, formatScore, funnelSteps } from './funnel';

const ratio = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  percent: denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10,
});

describe('funnelSteps', () => {
  it('derives each step from the KPIs with conversion against the previous and first step', () => {
    const steps = funnelSteps({
      enrollments: 16,
      programCompletion: ratio(8, 16),
      fieldReadyCount: 6,
      certifiedCount: 3,
    });
    expect(steps.map((s) => [s.key, s.value])).toEqual([
      ['enrolled', 16],
      ['completed', 8],
      ['field_ready', 6],
      ['certified', 3],
    ]);
    expect(steps[0]).toMatchObject({ ofPrevious: null, ofFirst: null });
    expect(steps[1]).toMatchObject({ ofPrevious: 50, ofFirst: 50 });
    expect(steps[2]).toMatchObject({ ofPrevious: 75, ofFirst: 37.5 });
    expect(steps[3]).toMatchObject({ ofPrevious: 50, ofFirst: 18.8 });
  });

  it('reports no conversion when a step has no population instead of dividing by zero', () => {
    const steps = funnelSteps({
      enrollments: 0,
      programCompletion: ratio(0, 0),
      fieldReadyCount: 0,
      certifiedCount: 0,
    });
    expect(steps.every((s) => s.ofPrevious === null && s.ofFirst === null)).toBe(true);
  });
});

describe('formatters', () => {
  it('shows an em dash for missing values', () => {
    expect(formatRatio(null)).toBe('—');
    expect(formatRatio(ratio(0, 0))).toBe('—');
    expect(formatRatio(ratio(1, 4))).toBe('25%');
    expect(formatScore(null)).toBe('—');
    expect(formatScore(81.6)).toBe('82');
    expect(formatDays(null)).toBe('—');
    expect(formatDays(31.64)).toBe('31.6 days');
  });
});
