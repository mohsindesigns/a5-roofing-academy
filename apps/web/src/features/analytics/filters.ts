import { analytics } from '@a5/contracts';

/**
 * Filters shared by the reports page, the team views and the dashboards. They live in the URL
 * (see `useSearchState`), so every key is a string and "no filter" is the empty string.
 */
export interface AnalyticsFilterState {
  from: string;
  to: string;
  programId: string;
  teamId: string;
  locationId: string;
  certificationId: string;
}

export const ANALYTICS_FILTER_DEFAULTS: AnalyticsFilterState = {
  from: '',
  to: '',
  programId: '',
  teamId: '',
  locationId: '',
  certificationId: '',
};

export const DATE_PRESETS = [
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
  { value: '365d', label: 'Last 12 months', days: 365 },
] as const;
export type DatePresetKey = (typeof DATE_PRESETS)[number]['value'] | 'ytd';

const DAY_MS = 86_400_000;

function utcDate(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function addDays(iso: string, days: number): string {
  return new Date(utcDate(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Calendar date (YYYY-MM-DD) of `date` in the browser's local time zone. */
export function localIsoDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Inclusive range ending today. `ytd` starts on 1 January. */
export function presetRange(preset: DatePresetKey, today: string): { from: string; to: string } {
  if (preset === 'ytd') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  const days = DATE_PRESETS.find((p) => p.value === preset)?.days ?? 30;
  return { from: addDays(today, -(days - 1)), to: today };
}

/** Which preset (if any) the current dates correspond to. Empty dates mean "all time". */
export function activePreset(
  state: Pick<AnalyticsFilterState, 'from' | 'to'>,
  today: string,
): DatePresetKey | 'all' | 'custom' {
  if (!state.from && !state.to) return 'all';
  const candidates: DatePresetKey[] = [...DATE_PRESETS.map((p) => p.value), 'ytd'];
  for (const key of candidates) {
    const r = presetRange(key, today);
    if (r.from === state.from && r.to === state.to) return key;
  }
  return 'custom';
}

/** Error text for an invalid date range, using the same rules as the API. */
export function rangeError(state: Pick<AnalyticsFilterState, 'from' | 'to'>): string | null {
  const parsed = analytics.analyticsFiltersSchema.safeParse({
    from: state.from || undefined,
    to: state.to || undefined,
  });
  if (parsed.success) return null;
  return parsed.error.issues[0]?.message ?? 'Choose a valid date range';
}

/** Query for the analytics API: only the filters that have a value. */
export function toApiFilters(state: Partial<AnalyticsFilterState>): analytics.AnalyticsFilters {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(state)) {
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out as analytics.AnalyticsFilters;
}

/** Count of filters other than the date range, for the mobile "Filters" badge. */
export function activeFilterCount(state: AnalyticsFilterState): number {
  return [state.programId, state.teamId, state.locationId, state.certificationId].filter(Boolean)
    .length;
}
