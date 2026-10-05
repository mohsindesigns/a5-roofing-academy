export interface WatchInterval {
  start: number;
  end: number;
  rate: number;
}

export interface WatchReport {
  intervals: WatchInterval[];
  positionSeconds: number;
  ended: boolean;
  clientSentAt: string;
}

export interface WatchTrackerOptions {
  /** Called with batched telemetry; `beacon` is true when the page is going away. */
  send: (report: WatchReport, opts: { beacon: boolean }) => void;
  /** Heartbeat cadence while playing. */
  intervalMs?: number;
  now?: () => number;
}

/**
 * Records the content intervals a viewer actually played (not just the playhead position), and
 * batches them into heartbeats. Seeks close the current interval, so skipped content is never
 * reported as watched. The server re-validates everything against wall-clock time.
 */
export class WatchTracker {
  private pending: WatchInterval[] = [];
  private current: WatchInterval | null = null;
  private lastTime = 0;
  private lastPosition = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;

  constructor(private readonly options: WatchTrackerOptions) {
    this.intervalMs = options.intervalMs ?? 15_000;
  }

  /** Feed every `timeupdate`. */
  update(currentTime: number, playing: boolean, rate: number): void {
    this.lastPosition = currentTime;
    if (!playing) {
      this.close();
      this.lastTime = currentTime;
      return;
    }
    const delta = currentTime - this.lastTime;
    // timeupdate fires roughly every 250ms; anything beyond ~2s of content per tick is a seek.
    const continuous = delta >= 0 && delta <= Math.max(2, 2 * rate);
    if (this.current && continuous && this.current.rate === rate) {
      this.current.end = currentTime;
    } else {
      this.close();
      this.current = { start: currentTime, end: currentTime, rate };
    }
    this.lastTime = currentTime;
    this.ensureTimer();
  }

  /** Feed `seeking`: ends the current interval without crediting the jump. */
  seek(to: number): void {
    this.close();
    this.lastTime = to;
    this.lastPosition = to;
  }

  pause(): void {
    this.close();
    this.flush(false);
  }

  ended(duration: number): void {
    if (this.current) this.current.end = Math.max(this.current.end, duration);
    this.close();
    this.flush(false, true);
  }

  /** Send everything recorded so far. */
  flush(beacon: boolean, ended = false): void {
    this.close();
    if (this.pending.length === 0 && !ended) return;
    const intervals = this.pending.filter((i) => i.end - i.start > 0.2);
    this.pending = [];
    if (intervals.length === 0 && !ended) return;
    this.options.send(
      {
        intervals,
        positionSeconds: Math.round(this.lastPosition * 10) / 10,
        ended,
        clientSentAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      },
      { beacon },
    );
  }

  dispose(): void {
    this.flush(true);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private close(): void {
    if (this.current && this.current.end > this.current.start) this.pending.push(this.current);
    this.current = null;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Keep the open interval open across heartbeats: close, send, and resume from its end.
      const open = this.current;
      this.flush(false);
      if (open) this.current = { start: open.end, end: open.end, rate: open.rate };
    }, this.intervalMs);
  }
}
