import { describe, expect, it } from 'vitest';
import type { assessment } from '@a5/contracts';
import { splitCooldown, toRequest, toValues } from './settings-model';

function detail(config: Partial<assessment.AssessmentConfig> = {}): assessment.AssessmentDetail {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Week 1 Knowledge Check',
    description: 'Checks how A5 earns trust.',
    kind: 'quiz',
    status: 'draft',
    passingPercent: 80,
    itemCount: 0,
    questionCount: 0,
    attemptCount: 0,
    publishedAt: null,
    archivedAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    revision: 1,
    items: [],
    createdBy: null,
    updatedBy: null,
    config: {
      passingPercent: 80,
      maxAttempts: 3,
      timeLimitSeconds: 1200,
      randomizeQuestions: false,
      randomizeOptions: true,
      revealCorrectAnswers: 'after_submit',
      revealScore: true,
      retryCooldownMinutes: 10,
      notifyManagerOn: ['failed'],
      allowStandalone: false,
      ...config,
    },
  };
}

describe('splitCooldown', () => {
  it('uses the largest unit that expresses the wait exactly', () => {
    expect(splitCooldown(0)).toEqual({ value: 0, unit: 'minutes' });
    expect(splitCooldown(10)).toEqual({ value: 10, unit: 'minutes' });
    expect(splitCooldown(90)).toEqual({ value: 90, unit: 'minutes' });
    expect(splitCooldown(120)).toEqual({ value: 2, unit: 'hours' });
    expect(splitCooldown(1440)).toEqual({ value: 1, unit: 'days' });
    expect(splitCooldown(2880)).toEqual({ value: 2, unit: 'days' });
  });
});

describe('toValues', () => {
  it('shows the stored configuration in friendly units', () => {
    const v = toValues(
      detail({ retryCooldownMinutes: 1440, timeLimitSeconds: 2700, maxAttempts: 2 }),
    );
    expect(v).toMatchObject({
      passingPercent: '80',
      limitAttempts: true,
      maxAttempts: '2',
      limitTime: true,
      timeLimitMinutes: '45',
      cooldownValue: '1',
      cooldownUnit: 'days',
      notifyFailed: true,
      notifyPassed: false,
    });
  });

  it('represents unlimited attempts and no time limit with the switches off', () => {
    const v = toValues(detail({ maxAttempts: null, timeLimitSeconds: null }));
    expect(v.limitAttempts).toBe(false);
    expect(v.limitTime).toBe(false);
  });
});

describe('toRequest', () => {
  it('round-trips an unchanged assessment', () => {
    const d = detail();
    const { request, issues } = toRequest(toValues(d));
    expect(issues).toEqual([]);
    expect(request?.config).toEqual(d.config);
    expect(request?.title).toBe(d.title);
  });

  it('turns the switches into null for unlimited attempts and no time limit', () => {
    const v = { ...toValues(detail()), limitAttempts: false, limitTime: false };
    expect(toRequest(v).request?.config).toMatchObject({
      maxAttempts: null,
      timeLimitSeconds: null,
    });
  });

  it('converts minutes, hours and days for the wait between attempts', () => {
    const base = toValues(detail());
    expect(
      toRequest({ ...base, cooldownValue: '2', cooldownUnit: 'hours' }).request?.config
        ?.retryCooldownMinutes,
    ).toBe(120);
    expect(
      toRequest({ ...base, cooldownValue: '1', cooldownUnit: 'days' }).request?.config
        ?.retryCooldownMinutes,
    ).toBe(1440);
    expect(
      toRequest({ ...base, cooldownValue: '0', cooldownUnit: 'minutes' }).request?.config
        ?.retryCooldownMinutes,
    ).toBe(0);
  });

  it('collects the manager notification choices', () => {
    const base = toValues(detail());
    expect(
      toRequest({ ...base, notifyFailed: true, notifyPassed: true }).request?.config
        ?.notifyManagerOn,
    ).toEqual(['failed', 'passed']);
    expect(
      toRequest({ ...base, notifyFailed: false, notifyPassed: false }).request?.config
        ?.notifyManagerOn,
    ).toEqual([]);
  });

  it('puts each problem next to the field it belongs to', () => {
    const base = toValues(detail());
    expect(toRequest({ ...base, passingPercent: '120' }).issues).toEqual([
      { field: 'passingPercent', message: 'Enter a pass mark between 0 and 100' },
    ]);
    expect(toRequest({ ...base, passingPercent: '' }).issues).toEqual([
      { field: 'passingPercent', message: 'Enter a pass mark between 0 and 100' },
    ]);
    expect(toRequest({ ...base, maxAttempts: '0' }).issues[0]).toMatchObject({
      field: 'maxAttempts',
    });
    expect(toRequest({ ...base, timeLimitMinutes: '0.5' }).issues[0]).toMatchObject({
      field: 'timeLimitMinutes',
    });
    expect(toRequest({ ...base, timeLimitMinutes: '600' }).issues[0]).toMatchObject({
      field: 'timeLimitMinutes',
    });
    expect(
      toRequest({ ...base, cooldownValue: '45', cooldownUnit: 'days' }).issues[0],
    ).toMatchObject({ field: 'cooldownValue' });
    expect(toRequest({ ...base, title: '   ' }).issues[0]).toMatchObject({ field: 'title' });
  });

  it('ignores the attempt count when attempts are unlimited', () => {
    const base = { ...toValues(detail()), limitAttempts: false, maxAttempts: '' };
    expect(toRequest(base).issues).toEqual([]);
  });
});
