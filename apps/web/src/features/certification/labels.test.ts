import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_STATUS,
  MY_STATE,
  TEAM_STATE,
  daysUntil,
  describeValidity,
  expiryText,
} from './labels';

const NOW = Date.parse('2026-10-05T12:00:00Z');

describe('expiryText', () => {
  it('counts down inside three months and just names the date beyond that', () => {
    expect(expiryText('2026-10-19T12:00:00Z', NOW)).toBe('Expires Oct 19, 2026 (in 14 days)');
    expect(expiryText('2026-10-06T12:00:00Z', NOW)).toBe('Expires Oct 6, 2026 (in 1 day)');
    expect(expiryText('2028-04-04T12:00:00Z', NOW)).toBe('Expires Apr 4, 2028');
  });

  it('handles today, the past and certificates that never expire', () => {
    expect(expiryText('2026-10-05T13:00:00Z', NOW)).toBe('Expires today (Oct 5, 2026)');
    expect(expiryText('2026-09-01T12:00:00Z', NOW)).toBe('Expired Sep 1, 2026');
    expect(expiryText('2026-10-05T11:00:00Z', NOW)).toBe('Expired Oct 5, 2026');
    expect(expiryText(null, NOW)).toBe('No expiration date');
  });
});

describe('daysUntil', () => {
  it('counts calendar days, so later today is still today, and goes negative after the date', () => {
    expect(daysUntil('2026-10-05T13:00:00Z', NOW)).toBe(0);
    expect(daysUntil('2026-10-07T12:00:00Z', NOW)).toBe(2);
    expect(daysUntil('2026-10-03T12:00:00Z', NOW)).toBe(-2);
  });
});

describe('describeValidity', () => {
  it('reads naturally for each policy', () => {
    expect(describeValidity({ kind: 'none' })).toBe('Never expires');
    expect(describeValidity({ kind: 'months', months: 1 })).toBe('1 month from issue');
    expect(describeValidity({ kind: 'months', months: 24 })).toBe('24 months from issue');
    expect(describeValidity({ kind: 'years', years: 2 })).toBe('2 years from issue');
    expect(describeValidity({ kind: 'fixed_date', date: '2030-01-31' })).toBe(
      'Expires Jan 31, 2030',
    );
  });
});

describe('status labels', () => {
  it('never rely on colour alone: every state has words', () => {
    for (const info of [
      ...Object.values(CERTIFICATE_STATUS),
      ...Object.values(MY_STATE),
      ...Object.values(TEAM_STATE),
    ]) {
      expect(info.label.length).toBeGreaterThan(2);
    }
    expect(CERTIFICATE_STATUS.issued.label).toBe('Active');
    expect(CERTIFICATE_STATUS.revoked.tone).toBe('danger');
    expect(MY_STATE.pending_approval.label).toBe('Pending approval');
  });
});
