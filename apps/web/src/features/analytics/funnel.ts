import type { analytics } from '@a5/contracts';

export interface FunnelStep {
  key: 'enrolled' | 'completed' | 'field_ready' | 'certified';
  label: string;
  value: number;
  /** Share of the previous step, 0-100, or null when the previous step is empty. */
  ofPrevious: number | null;
  /** Share of the first step, 0-100, or null when nobody enrolled. */
  ofFirst: number | null;
}

function share(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * Completion funnel from the dashboard KPIs: enrollments, completed enrollments, people who also
 * passed a final assessment, and people who hold an active certificate. The first two steps count
 * enrollments and the last two count people, so with several programs per person the later steps
 * can be smaller than they look; the page says so.
 */
export function funnelSteps(
  kpis: Pick<
    analytics.TeamKpis,
    'enrollments' | 'programCompletion' | 'fieldReadyCount' | 'certifiedCount'
  >,
): FunnelStep[] {
  const raw: Array<Pick<FunnelStep, 'key' | 'label' | 'value'>> = [
    { key: 'enrolled', label: 'Enrolled', value: kpis.enrollments },
    { key: 'completed', label: 'Completed the program', value: kpis.programCompletion.numerator },
    { key: 'field_ready', label: 'Field ready', value: kpis.fieldReadyCount },
    { key: 'certified', label: 'Certified', value: kpis.certifiedCount },
  ];
  const first = raw[0]!.value;
  return raw.map((step, i) => ({
    ...step,
    ofPrevious: i === 0 ? null : share(step.value, raw[i - 1]!.value),
    ofFirst: i === 0 ? null : share(step.value, first),
  }));
}

export function formatRatio(r: analytics.Ratio | null | undefined): string {
  if (!r || r.percent === null) return '—';
  return `${r.percent}%`;
}

export function formatScore(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value)}`;
}

export function formatDays(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value * 10) / 10} days`;
}
