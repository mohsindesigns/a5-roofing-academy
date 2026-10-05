import { describe, expect, it } from 'vitest';
import {
  insertAt,
  malformedPlaceholders,
  placeholderIssues,
  referencedVariables,
} from './placeholders';

describe('template placeholders', () => {
  it('lists referenced variables once, in order of first use', () => {
    expect(
      referencedVariables('Hi {{firstName}}, {{ programTitle }} is due. {{firstName}}'),
    ).toEqual(['firstName', 'programTitle']);
    expect(referencedVariables('No variables here')).toEqual([]);
  });

  it('finds malformed placeholders', () => {
    expect(malformedPlaceholders('Hello {{firstName}}')).toEqual([]);
    expect(malformedPlaceholders('Hello {{firstName}')).toEqual(['{{firstName']);
    expect(malformedPlaceholders('Hello {{first name}}')).toEqual(['{{first name}}']);
    expect(malformedPlaceholders('Hello firstName}}')).toEqual(['}}']);
  });

  it('reports unknown and malformed variables with actionable text', () => {
    const allowed = ['firstName', 'programTitle'];
    expect(placeholderIssues('Hi {{firstName}}', allowed)).toEqual([]);
    expect(placeholderIssues('Hi {{nickname}}', allowed)).toEqual([
      '{{nickname}} is not available for this notification.',
    ]);
    expect(placeholderIssues('Hi {{firstName}', allowed)[0]).toMatch(/^Fix \{\{firstName\./);
  });
});

describe('insertAt', () => {
  it('inserts at the caret', () => {
    expect(insertAt('Hello !', 6, 6, '{{firstName}}')).toEqual({
      text: 'Hello {{firstName}}!',
      caret: 19,
    });
  });

  it('replaces the selection and clamps out-of-range offsets', () => {
    expect(insertAt('Hello world', 6, 11, '{{x}}').text).toBe('Hello {{x}}');
    expect(insertAt('abc', 10, 20, 'Z')).toEqual({ text: 'abcZ', caret: 4 });
    expect(insertAt('abc', 2, 1, 'Z').text).toBe('abZc');
  });
});
