import { describe, expect, it } from 'vitest';
import { describeUserAgent, formatDate, formatMinutes, formatRelative } from './format';

describe('format', () => {
  it('formats calendar dates without time-zone drift', () => {
    expect(formatDate('2026-08-31')).toBe('Aug 31, 2026');
  });
  it('formats relative times', () => {
    const now = Date.parse('2026-10-05T12:00:00Z');
    expect(formatRelative('2026-10-05T11:59:50Z', now)).toBe('just now');
    expect(formatRelative('2026-10-05T09:00:00Z', now)).toBe('3 hours ago');
    expect(formatRelative('2026-10-03T12:00:00Z', now)).toBe('2 days ago');
  });
  it('formats durations', () => {
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(90)).toBe('1 h 30 min');
  });
  it('describes devices', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iOS');
  });
});
