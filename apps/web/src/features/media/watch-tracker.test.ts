import { afterEach, describe, expect, it, vi } from 'vitest';
import { WatchTracker, type WatchReport } from './watch-tracker';

function play(t: WatchTracker, from: number, to: number, rate = 1, step = 0.25) {
  for (let x = from; x <= to + 1e-9; x += step * rate) t.update(Math.round(x * 100) / 100, true, rate);
}

afterEach(() => vi.useRealTimers());

describe('WatchTracker', () => {
  it('records continuous playback as one interval', () => {
    const reports: WatchReport[] = [];
    const t = new WatchTracker({ send: (r) => reports.push(r) });
    play(t, 0, 30);
    t.pause();
    expect(reports[0]?.intervals).toEqual([{ start: 0, end: 30, rate: 1 }]);
    t.dispose();
  });

  it('does not credit skipped content', () => {
    const reports: WatchReport[] = [];
    const t = new WatchTracker({ send: (r) => reports.push(r) });
    play(t, 0, 10);
    t.seek(120);
    play(t, 120, 125);
    t.pause();
    expect(reports[0]?.intervals).toEqual([
      { start: 0, end: 10, rate: 1 },
      { start: 120, end: 125, rate: 1 },
    ]);
    t.dispose();
  });

  it('treats an unannounced jump as a seek', () => {
    const reports: WatchReport[] = [];
    const t = new WatchTracker({ send: (r) => reports.push(r) });
    play(t, 0, 5);
    t.update(300, true, 1);
    t.update(300.25, true, 1);
    t.pause();
    expect(reports[0]?.intervals.map((i) => [i.start, i.end])).toEqual([
      [0, 5],
      [300, 300.25],
    ]);
    t.dispose();
  });

  it('splits intervals when the playback rate changes', () => {
    const reports: WatchReport[] = [];
    const t = new WatchTracker({ send: (r) => reports.push(r) });
    play(t, 0, 10, 1);
    play(t, 10, 20, 2);
    t.pause();
    expect(reports[0]?.intervals.map((i) => i.rate)).toEqual([1, 2]);
    t.dispose();
  });

  it('sends periodic heartbeats while playing and a beacon on dispose', () => {
    vi.useFakeTimers();
    const sent: Array<{ r: WatchReport; beacon: boolean }> = [];
    const t = new WatchTracker({ send: (r, o) => sent.push({ r, beacon: o.beacon }), intervalMs: 15_000 });
    play(t, 0, 14);
    vi.advanceTimersByTime(15_000);
    play(t, 14.25, 20);
    t.dispose();
    expect(sent).toHaveLength(2);
    expect(sent[0]!.beacon).toBe(false);
    expect(sent[1]!.beacon).toBe(true);
    expect(sent[1]!.r.intervals[0]!.start).toBe(14);
  });

  it('reports completion on ended', () => {
    const reports: WatchReport[] = [];
    const t = new WatchTracker({ send: (r) => reports.push(r) });
    play(t, 0, 59.5);
    t.ended(60);
    expect(reports[0]).toMatchObject({ ended: true, intervals: [{ start: 0, end: 60, rate: 1 }] });
    t.dispose();
  });
});
