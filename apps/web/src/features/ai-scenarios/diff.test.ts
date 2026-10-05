import { describe, expect, it } from 'vitest';
import { diffLines, displayValue, fieldLabel } from './diff';

describe('diffLines', () => {
  it('marks added and removed lines and keeps common ones', () => {
    expect(diffLines('a\nb\nc', 'a\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ]);
  });

  it('handles empty sides', () => {
    expect(diffLines('', 'x')).toEqual([{ kind: 'added', text: 'x' }]);
    expect(diffLines('x', '')).toEqual([{ kind: 'removed', text: 'x' }]);
    expect(diffLines('', '')).toEqual([]);
  });

  it('reports a changed line as remove plus add', () => {
    const lines = diffLines('Say hello', 'Say hello there');
    expect(lines.map((l) => l.kind)).toEqual(['removed', 'added']);
  });
});

describe('fieldLabel', () => {
  it('names persona and scenario fields', () => {
    expect(fieldLabel('scenario.openingLine')).toEqual({
      group: 'Scenario',
      label: 'Opening line',
    });
    expect(fieldLabel('persona.speakingStyle')).toEqual({
      group: 'Persona',
      label: 'Speaking style',
    });
    expect(fieldLabel('homeownerSystemPrompt')).toEqual({
      group: 'Prompt and model',
      label: 'Homeowner system prompt',
    });
  });
});

describe('displayValue', () => {
  it('prints lists one per line and objects as JSON', () => {
    expect(displayValue(['a', 'b'])).toBe('a\nb');
    expect(displayValue(null)).toBe('');
    expect(displayValue({ effort: 'low' })).toBe('{\n  "effort": "low"\n}');
  });
});
