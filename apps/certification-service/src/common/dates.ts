import type { certification } from '@a5/contracts';

const DAY_MS = 86_400_000;

/** Add calendar months in UTC, clamping to the last day of the target month (Jan 31 + 1 = Feb 28/29). */
export function addMonthsUtc(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/**
 * Expiration of a certificate issued (or renewed from) `base` under a validity policy.
 * Returns null for certificates that never expire.
 */
export function computeExpiry(policy: certification.ValidityPolicy, base: Date): Date | null {
  switch (policy.kind) {
    case 'none':
      return null;
    case 'months':
      return addMonthsUtc(base, policy.months);
    case 'years':
      return addMonthsUtc(base, policy.years * 12);
    case 'fixed_date':
      return new Date(`${policy.date}T23:59:59.999Z`);
  }
}

export function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Long date for certificates, e.g. "October 5, 2026", in the organization's time zone. */
export function formatLongDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone }).format(date);
}

/** Calendar date (YYYY-MM-DD) in a time zone. */
export function calendarDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function iso(date: Date): string;
export function iso(date: Date | null): string | null;
export function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}
