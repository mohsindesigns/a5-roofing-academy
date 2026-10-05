import { ApiError } from '@/lib/api/errors';
import type { Answer } from './quiz-state';

export interface SaveResult {
  applied: boolean;
  answeredCount: number;
  timeRemainingSeconds: number | null;
  savedAt: string | null;
}

/**
 * idle: everything is stored. dirty: edits waiting out the debounce. saving: a request is in
 * flight. retrying: a request failed for a transient reason and will be sent again. failed: the
 * server refused an answer for good (or the attempt is closed) and the learner has to act.
 */
export type AutosaveStatus = 'idle' | 'dirty' | 'saving' | 'retrying' | 'failed';

export interface AutosaveSnapshot {
  status: AutosaveStatus;
  /** Client time of the last acknowledged save. */
  lastSavedAt: number | null;
  /** Questions whose latest answer was refused, with the reason to show the learner. */
  errors: Readonly<Record<string, string>>;
}

export type Classification =
  | { fatal: false }
  | {
      fatal: true;
      message: string;
      /** The attempt can no longer accept answers. */ closed?: boolean;
    };

export interface AutosaveOptions {
  save: (questionId: string, response: Answer | null, sequence: number) => Promise<SaveResult>;
  /** Quiet period after the last edit before a text answer is sent. */
  debounceMs?: number;
  /** Wait before the nth retry; the last value repeats. */
  retryDelaysMs?: readonly number[];
  /** Decide whether a failure is worth retrying. */
  classify?: (error: unknown) => Classification;
  onSaved?: (questionId: string, result: SaveResult) => void;
  /** The server no longer accepts answers (submitted or timed out). */
  onClosed?: (error: unknown) => void;
  clock?: () => number;
}

interface Entry {
  value: Answer | null;
  version: number;
  savedVersion: number;
  inFlight: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  failures: number;
  error: string | null;
}

const DEFAULT_RETRY_DELAYS = [1_000, 3_000, 8_000, 15_000] as const;

/**
 * Sends each answer to the server soon after it changes, one request per question at a time.
 * Edits made while a request is in flight are sent afterwards, so the server always ends up with
 * the learner's latest answer. Every request carries a strictly increasing sequence number, which
 * lets the server ignore a stale write that arrives late.
 */
export class AutosaveQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly debounceMs: number;
  private readonly retryDelays: readonly number[];
  private readonly clock: () => number;
  private lastSequence = 0;
  private lastSavedAt: number | null = null;
  private disposed = false;
  private active = true;
  private snapshot: AutosaveSnapshot = { status: 'idle', lastSavedAt: null, errors: {} };

  constructor(private readonly options: AutosaveOptions) {
    this.debounceMs = options.debounceMs ?? 800;
    this.retryDelays = options.retryDelaysMs?.length ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS;
    this.clock = options.clock ?? Date.now;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AutosaveSnapshot => this.snapshot;

  /** Record a new answer. Choices are sent right away; typing waits for a pause. */
  set(questionId: string, value: Answer | null, opts: { immediate?: boolean } = {}): void {
    if (this.disposed) return;
    const entry = this.entry(questionId);
    entry.value = value;
    entry.version += 1;
    entry.error = null;
    entry.failures = 0;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void this.run(questionId), opts.immediate ? 0 : this.debounceMs);
    this.emit();
  }

  /** True while any answer has not reached the server. */
  hasUnsaved(): boolean {
    for (const e of this.entries.values()) if (e.version !== e.savedVersion) return true;
    return false;
  }

  /**
   * Send everything that is waiting now. Resolves with the ids of questions that could not be
   * stored (an empty list means the server has the learner's latest answers).
   */
  async flush(): Promise<string[]> {
    for (let round = 0; round < 3; round += 1) {
      const waiting = [...this.entries.entries()].filter(
        ([, e]) => e.error === null && (e.version !== e.savedVersion || e.inFlight),
      );
      if (waiting.length === 0) break;
      for (const [id, e] of waiting) {
        if (e.timer) {
          clearTimeout(e.timer);
          e.timer = null;
        }
        if (!e.inFlight) void this.run(id);
      }
      await Promise.all(waiting.map(([, e]) => e.inFlight));
    }
    return [...this.entries.entries()]
      .filter(([, e]) => e.version !== e.savedVersion)
      .map(([id]) => id);
  }

  /**
   * Stop scheduling follow-up sends (retries, edits made during a request) without dropping
   * anything: used when the screen unmounts, after a last `flush()`. React StrictMode mounts,
   * unmounts and mounts again, so this must be reversible.
   */
  setActive(active: boolean): void {
    this.active = active;
    if (active) return;
    for (const e of this.entries.values()) {
      if (e.failures > 0 && e.timer) {
        clearTimeout(e.timer);
        e.timer = null;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer);
    this.listeners.clear();
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = {
        value: null,
        version: 0,
        savedVersion: 0,
        inFlight: null,
        timer: null,
        failures: 0,
        error: null,
      };
      this.entries.set(id, e);
    }
    return e;
  }

  private nextSequence(): number {
    this.lastSequence = Math.max(this.lastSequence + 1, this.clock());
    return this.lastSequence;
  }

  private run(id: string): Promise<void> {
    const e = this.entry(id);
    e.timer = null;
    if (this.disposed || e.inFlight || e.version === e.savedVersion)
      return e.inFlight ?? Promise.resolve();
    const sentVersion = e.version;
    e.inFlight = (async () => {
      // Yield once so `inFlight` is assigned before any synchronous failure reaches `finally`.
      await Promise.resolve();
      try {
        const result = await this.options.save(id, e.value, this.nextSequence());
        e.savedVersion = Math.max(e.savedVersion, sentVersion);
        e.failures = 0;
        this.lastSavedAt = this.clock();
        this.options.onSaved?.(id, result);
      } catch (err) {
        const verdict = this.options.classify?.(err) ?? { fatal: false };
        if (verdict.fatal) {
          e.error = verdict.message;
          if (verdict.closed) this.options.onClosed?.(err);
        } else {
          e.failures += 1;
        }
      } finally {
        e.inFlight = null;
        this.afterRequest(id, e);
        this.emit();
      }
    })();
    this.emit();
    return e.inFlight;
  }

  /** After a request: send what changed meanwhile, or schedule a retry. */
  private afterRequest(id: string, e: Entry): void {
    if (this.disposed || !this.active || e.error !== null || e.timer !== null) return;
    if (e.version === e.savedVersion) return;
    const delay =
      e.failures > 0
        ? (this.retryDelays[Math.min(e.failures, this.retryDelays.length) - 1] ?? 1_000)
        : 0;
    e.timer = setTimeout(() => void this.run(id), delay);
  }

  private emit(): void {
    let saving = false;
    let retrying = false;
    let pending = false;
    const errors: Record<string, string> = {};
    for (const [id, e] of this.entries) {
      if (e.inFlight) saving = true;
      if (e.error !== null) errors[id] = e.error;
      else if (e.version !== e.savedVersion) {
        pending = true;
        if (e.failures > 0) retrying = true;
      }
    }
    const status: AutosaveStatus =
      Object.keys(errors).length > 0
        ? 'failed'
        : retrying
          ? 'retrying'
          : saving
            ? 'saving'
            : pending
              ? 'dirty'
              : 'idle';
    const prev = this.snapshot;
    const sameErrors =
      Object.keys(errors).length === Object.keys(prev.errors).length &&
      Object.entries(errors).every(([k, v]) => prev.errors[k] === v);
    if (prev.status === status && prev.lastSavedAt === this.lastSavedAt && sameErrors) return;
    this.snapshot = {
      status,
      lastSavedAt: this.lastSavedAt,
      errors: sameErrors ? prev.errors : errors,
    };
    for (const l of this.listeners) l();
  }
}

/**
 * Which failures are worth retrying. Network problems, rate limits and server errors are; a closed
 * attempt or an answer the server refuses is not, and the learner needs to see why.
 */
export function classifySaveError(error: unknown): Classification {
  if (!(error instanceof ApiError)) return { fatal: false };
  if (error.code === 'ATTEMPT_EXPIRED' || error.code === 'ATTEMPT_SUBMITTED') {
    return { fatal: true, message: error.message, closed: true };
  }
  if (
    error.status === 0 ||
    error.status === 401 ||
    error.status === 408 ||
    error.status === 429 ||
    error.status >= 500
  ) {
    return { fatal: false };
  }
  return { fatal: true, message: error.fields[0]?.message ?? error.message };
}
