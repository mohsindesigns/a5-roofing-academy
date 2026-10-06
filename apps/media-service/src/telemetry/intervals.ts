/** A range of content time `[start, end]` in seconds. */
export type Interval = [number, number];

export interface ReportedInterval {
  start: number;
  end: number;
  rate: number;
}

/** Floating-point noise only; real gaps are never bridged (that would credit unwatched time). */
const TOUCH_EPSILON = 0.001;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Sort and merge overlapping or touching intervals. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + TOUCH_EPSILON) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged.map(([s, e]) => [round3(s), round3(e)]);
}

export function totalLength(list: readonly Interval[]): number {
  return round3(list.reduce((sum, [s, e]) => sum + (e - s), 0));
}

export interface CreditInput {
  intervals: readonly ReportedInterval[];
  durationSeconds: number;
  /** Playback rates above this earn no credit. */
  maxRate: number;
  /** Wall-clock seconds since the previous accepted report (or since the session started). */
  elapsedSeconds: number;
  /** Allowance for network and timer jitter, in wall-clock seconds. */
  toleranceSeconds: number;
}

export interface CreditResult {
  /** Intervals that could plausibly have been watched (not yet merged with earlier credit). */
  accepted: Interval[];
  /** Content seconds reported at a playback rate above the policy maximum. */
  droppedForRate: number;
  /** Content seconds beyond what the elapsed wall-clock time allows. */
  truncated: number;
}

/**
 * Decide which reported content time could really have been watched.
 *
 * - Only reported intervals count; jumps between them (seeks) earn nothing.
 * - Intervals played faster than the allowed rate are dropped entirely.
 * - Watching `len` seconds of content at rate `r` takes `len / r` seconds of wall-clock time, so the
 *   reported intervals together may not need more than the elapsed wall-clock time (+ tolerance).
 *   Equivalently: credited content ≤ elapsed × min(rate, maxRate) + tolerance. Excess is truncated.
 */
export function plausibleIntervals(input: CreditInput): CreditResult {
  let wallBudget = Math.max(0, input.elapsedSeconds) + Math.max(0, input.toleranceSeconds);
  const accepted: Interval[] = [];
  let droppedForRate = 0;
  let truncated = 0;
  for (const reported of input.intervals) {
    const start = Math.min(Math.max(reported.start, 0), input.durationSeconds);
    const end = Math.min(Math.max(reported.end, 0), input.durationSeconds);
    const length = end - start;
    if (!(length > 0) || !(reported.rate > 0)) continue;
    if (reported.rate > input.maxRate + 1e-9) {
      droppedForRate += length;
      continue;
    }
    const wallNeeded = length / reported.rate;
    if (wallNeeded <= wallBudget) {
      accepted.push([start, end]);
      wallBudget -= wallNeeded;
    } else {
      const creditable = wallBudget * reported.rate;
      if (creditable > TOUCH_EPSILON) accepted.push([start, start + creditable]);
      truncated += length - Math.max(0, creditable);
      wallBudget = 0;
    }
  }
  return { accepted, droppedForRate: round3(droppedForRate), truncated: round3(truncated) };
}

export function percentOf(watchedSeconds: number, durationSeconds: number): number {
  if (!(durationSeconds > 0)) return 0;
  return Math.min(100, Math.floor((watchedSeconds / durationSeconds) * 10_000) / 100);
}

export const MILESTONE_STEP = 5;

/** 5 % boundaries at or below `percent` (5, 10, … 100). */
export function reachedMilestones(percent: number): number[] {
  const out: number[] = [];
  for (let b = MILESTONE_STEP; b <= percent + 1e-9 && b <= 100; b += MILESTONE_STEP) out.push(b);
  return out;
}
