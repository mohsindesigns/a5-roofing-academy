import { describe, expect, it } from 'vitest';
import { describeJobFilters, formatBytes } from './exports-panel';
import { formatCell } from './report-table';

describe('formatCell', () => {
  it('formats cells by the column type the API declares', () => {
    expect(formatCell(87.5, 'percent')).toBe('87.5%');
    expect(formatCell(1234, 'integer')).toBe('1,234');
    expect(formatCell(3.14159, 'number')).toBe('3.1');
    expect(formatCell(true, 'boolean')).toBe('Yes');
    expect(formatCell(false, 'boolean')).toBe('No');
    expect(formatCell('2026-03-04', 'date')).toBe('Mar 4, 2026');
    expect(formatCell('Dallas Residential A', 'string')).toBe('Dallas Residential A');
  });

  it('shows an em dash for empty cells', () => {
    for (const v of [null, undefined, '']) expect(formatCell(v, 'string')).toBe('—');
  });
});

describe('export history helpers', () => {
  it('describes stored filters with names where known', () => {
    expect(describeJobFilters({})).toBe('No filters');
    expect(
      describeJobFilters(
        { from: '2026-01-01', to: '2026-03-31', teamId: 't1', programId: 'p1' },
        { teams: new Map([['t1', 'Dallas Residential A']]) },
      ),
    ).toBe('Jan 1, 2026 – Mar 31, 2026 · One program · Dallas Residential A');
  });

  it('formats file sizes', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
