import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_FILTER_DEFAULTS,
  activeFilterCount,
  activePreset,
  addDays,
  presetRange,
  rangeError,
  toApiFilters,
} from './filters';

describe('date presets', () => {
  it('builds inclusive ranges ending today', () => {
    expect(presetRange('30d', '2026-10-05')).toEqual({ from: '2026-09-06', to: '2026-10-05' });
    expect(presetRange('90d', '2026-10-05')).toEqual({ from: '2026-07-08', to: '2026-10-05' });
    expect(presetRange('ytd', '2026-10-05')).toEqual({ from: '2026-01-01', to: '2026-10-05' });
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(presetRange('30d', '2026-01-10')).toEqual({ from: '2025-12-12', to: '2026-01-10' });
  });

  it('recognises which preset a range came from', () => {
    const today = '2026-10-05';
    expect(activePreset({ from: '', to: '' }, today)).toBe('all');
    expect(activePreset(presetRange('90d', today), today)).toBe('90d');
    expect(activePreset(presetRange('ytd', today), today)).toBe('ytd');
    expect(activePreset({ from: '2026-02-01', to: '2026-02-28' }, today)).toBe('custom');
    expect(activePreset({ from: '2026-02-01', to: '' }, today)).toBe('custom');
  });
});

describe('range validation', () => {
  it('accepts an empty or ordered range', () => {
    expect(rangeError({ from: '', to: '' })).toBeNull();
    expect(rangeError({ from: '2026-01-01', to: '2026-02-01' })).toBeNull();
    expect(rangeError({ from: '2026-01-01', to: '' })).toBeNull();
  });

  it('uses the API rules for reversed and oversized ranges', () => {
    expect(rangeError({ from: '2026-03-01', to: '2026-02-01' })).toMatch(/on or after the start/);
    expect(rangeError({ from: '2020-01-01', to: '2026-01-01' })).toMatch(/three years/);
  });
});

describe('API filters', () => {
  it('drops empty values so the query only carries real filters', () => {
    expect(toApiFilters(ANALYTICS_FILTER_DEFAULTS)).toEqual({});
    expect(
      toApiFilters({
        ...ANALYTICS_FILTER_DEFAULTS,
        from: '2026-01-01',
        teamId: '0192f7a0-0000-7000-8000-000000000001',
      }),
    ).toEqual({ from: '2026-01-01', teamId: '0192f7a0-0000-7000-8000-000000000001' });
  });

  it('counts narrowing filters but not the date range', () => {
    expect(activeFilterCount(ANALYTICS_FILTER_DEFAULTS)).toBe(0);
    expect(
      activeFilterCount({
        ...ANALYTICS_FILTER_DEFAULTS,
        from: '2026-01-01',
        programId: 'p',
        locationId: 'l',
      }),
    ).toBe(2);
  });
});
