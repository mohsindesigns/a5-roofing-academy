import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { learning } from '@a5/contracts';
import { leafRuleSchema } from '@a5/rules';
import { boundsOf, rangeHint, unionBounds } from './schema-bounds';

describe('schema bounds', () => {
  it('reads limits and defaults from a plain object schema', () => {
    const schema = z.object({
      percent: z.number().min(0).max(100),
      count: z.int().min(1).max(1000),
      days: z.int().min(0),
      mode: z.enum(['a', 'b']).default('a'),
    });
    const b = boundsOf(schema);
    expect(b.percent).toMatchObject({ min: 0, max: 100, integer: false });
    expect(b.count).toMatchObject({ min: 1, max: 1000, integer: true });
    expect(b.days?.min).toBe(0);
    expect(b.days?.max).toBeUndefined();
    expect(b.mode).toMatchObject({ default: 'a', enum: ['a', 'b'] });
  });

  it('reads the unlock-rule thresholds from the @a5/rules schema', () => {
    const rules = unionBounds(leafRuleSchema, 'type');
    // The same limits the API enforces; nothing in the web app repeats them.
    expect(rules.assessment_score?.minPercent).toMatchObject({ min: 0, max: 100 });
    expect(rules.ai_scenario_score?.minScore).toMatchObject({ min: 0, max: 100 });
    expect(rules.ai_sessions_count?.minCount).toMatchObject({ min: 1, max: 1000, integer: true });
    expect(rules.days_since_enrollment?.days).toMatchObject({ min: 0, integer: true });
    expect(rules.program_completed?.minPercent?.default).toBe(100);
    expect(Object.keys(rules)).toContain('lesson_completed');
  });

  it('reads lesson configuration limits from the contracts', () => {
    const video = boundsOf(learning.lessonConfigSchemas.video);
    expect(video.minWatchPercent).toMatchObject({ min: 0, max: 100 });
    expect(video.maxCreditedPlaybackRate).toMatchObject({ min: 1, max: 4, default: 2 });
    const ai = boundsOf(learning.lessonConfigSchemas.ai_simulation);
    expect(ai.minScore).toMatchObject({ min: 0, max: 100 });
  });

  it('reads text length limits', () => {
    const note = boundsOf(learning.publishProgramRequestSchema).changeNote;
    expect(note?.minLength).toBe(3);
    expect(note?.maxLength).toBe(2000);
  });

  it('describes a range in words', () => {
    expect(rangeHint({ min: 0, max: 100, integer: false }, '%')).toBe('0% to 100%');
    expect(rangeHint({ min: 1, integer: true })).toBe('1 or more');
    expect(rangeHint({ max: 4, integer: false })).toBe('4 or less');
    expect(rangeHint({ integer: true })).toBeUndefined();
    expect(rangeHint(undefined)).toBeUndefined();
  });
});
