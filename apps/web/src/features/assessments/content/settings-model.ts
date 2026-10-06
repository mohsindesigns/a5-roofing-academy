import { assessment } from '@a5/contracts';

export type CooldownUnit = 'minutes' | 'hours' | 'days';

export interface SettingsValues {
  title: string;
  description: string;
  kind: assessment.AssessmentKind;
  passingPercent: string;
  limitAttempts: boolean;
  maxAttempts: string;
  limitTime: boolean;
  timeLimitMinutes: string;
  cooldownValue: string;
  cooldownUnit: CooldownUnit;
  randomizeQuestions: boolean;
  randomizeOptions: boolean;
  revealScore: boolean;
  revealCorrectAnswers: assessment.RevealPolicy;
  notifyFailed: boolean;
  notifyPassed: boolean;
  allowStandalone: boolean;
}

const UNIT_MINUTES: Record<CooldownUnit, number> = { minutes: 1, hours: 60, days: 1440 };

/** Show a cooldown in the largest unit that expresses it exactly. */
export function splitCooldown(minutes: number): { value: number; unit: CooldownUnit } {
  if (minutes > 0 && minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes > 0 && minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}

export function toValues(a: assessment.AssessmentDetail): SettingsValues {
  const c = a.config;
  const cooldown = splitCooldown(c.retryCooldownMinutes);
  return {
    title: a.title,
    description: a.description ?? '',
    kind: a.kind,
    passingPercent: String(c.passingPercent),
    limitAttempts: c.maxAttempts !== null,
    maxAttempts: String(c.maxAttempts ?? assessment.DEFAULT_ASSESSMENT_CONFIG.maxAttempts ?? 3),
    limitTime: c.timeLimitSeconds !== null,
    timeLimitMinutes: String(
      c.timeLimitSeconds === null ? 30 : Math.round(c.timeLimitSeconds / 60),
    ),
    cooldownValue: String(cooldown.value),
    cooldownUnit: cooldown.unit,
    randomizeQuestions: c.randomizeQuestions,
    randomizeOptions: c.randomizeOptions,
    revealScore: c.revealScore,
    revealCorrectAnswers: c.revealCorrectAnswers,
    notifyFailed: c.notifyManagerOn.includes('failed'),
    notifyPassed: c.notifyManagerOn.includes('passed'),
    allowStandalone: c.allowStandalone,
  };
}

export interface FieldIssue {
  field: keyof SettingsValues;
  message: string;
}

/** Form values to an update request. Problems come back per field so they can sit next to the input. */
export function toRequest(v: SettingsValues): {
  request?: assessment.UpdateAssessmentRequest;
  issues: FieldIssue[];
} {
  const issues: FieldIssue[] = [];
  const num = (text: string, field: keyof SettingsValues, what: string): number => {
    const n = text.trim() === '' ? Number.NaN : Number(text);
    if (!Number.isFinite(n)) issues.push({ field, message: `Enter ${what}` });
    return n;
  };
  const passingPercent = num(v.passingPercent, 'passingPercent', 'a pass mark between 0 and 100');
  const maxAttempts = v.limitAttempts
    ? num(v.maxAttempts, 'maxAttempts', 'how many attempts are allowed')
    : null;
  const timeMinutes = v.limitTime
    ? num(v.timeLimitMinutes, 'timeLimitMinutes', 'the time limit in minutes')
    : null;
  const cooldownValue = num(v.cooldownValue, 'cooldownValue', 'a wait time, or 0 for none');
  if (issues.length) return { issues };

  const request: assessment.UpdateAssessmentRequest = {
    title: v.title,
    description: v.description.trim() || null,
    kind: v.kind,
    config: {
      passingPercent,
      maxAttempts,
      timeLimitSeconds: timeMinutes === null ? null : Math.round(timeMinutes * 60),
      retryCooldownMinutes: Math.round(cooldownValue * UNIT_MINUTES[v.cooldownUnit]),
      randomizeQuestions: v.randomizeQuestions,
      randomizeOptions: v.randomizeOptions,
      revealScore: v.revealScore,
      revealCorrectAnswers: v.revealCorrectAnswers,
      notifyManagerOn: [
        ...(v.notifyFailed ? (['failed'] as const) : []),
        ...(v.notifyPassed ? (['passed'] as const) : []),
      ],
      allowStandalone: v.allowStandalone,
    },
  };
  const parsed = assessment.updateAssessmentRequestSchema.safeParse(request);
  if (parsed.success) return { request, issues };

  const byPath: Record<string, keyof SettingsValues> = {
    title: 'title',
    description: 'description',
    'config.passingPercent': 'passingPercent',
    'config.maxAttempts': 'maxAttempts',
    'config.timeLimitSeconds': 'timeLimitMinutes',
    'config.retryCooldownMinutes': 'cooldownValue',
  };
  const friendly: Partial<Record<keyof SettingsValues, string>> = {
    passingPercent: 'Enter a pass mark between 0 and 100',
    maxAttempts: 'Enter a whole number of attempts, 1 to 100',
    timeLimitMinutes: 'Enter a time limit from 1 minute to 8 hours (480 minutes)',
    cooldownValue: 'Enter a whole number of minutes, hours or days, up to 30 days',
  };
  for (const issue of parsed.error.issues) {
    const field = byPath[issue.path.join('.')];
    if (field) issues.push({ field, message: friendly[field] ?? issue.message });
    else issues.push({ field: 'title', message: issue.message });
  }
  return { issues };
}
