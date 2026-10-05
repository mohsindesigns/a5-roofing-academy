import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import {
  AutosaveQueue,
  classifySaveError,
  type AutosaveOptions,
  type SaveResult,
} from './autosave';
import type { Answer } from './quiz-state';

const ok: SaveResult = {
  applied: true,
  answeredCount: 1,
  timeRemainingSeconds: 600,
  savedAt: null,
};
const text = (t: string): Answer => ({ type: 'short_answer', text: t });
const choice = (id: string): Answer => ({ type: 'multiple_choice', optionId: id });

function queue(save: AutosaveOptions['save'], extra: Partial<AutosaveOptions> = {}) {
  return new AutosaveQueue({ save, classify: classifySaveError, clock: () => 1_000, ...extra });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('AutosaveQueue', () => {
  it('waits for a pause in typing and sends only the latest text', async () => {
    const save = vi.fn().mockResolvedValue(ok);
    const q = queue(save);
    q.set('q1', text('A'));
    q.set('q1', text('A5'));
    q.set('q1', text('A5 Roofing'));
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();
    expect(q.getSnapshot().status).toBe('dirty');
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('q1', text('A5 Roofing'), expect.any(Number));
    expect(q.getSnapshot().status).toBe('idle');
    expect(q.getSnapshot().lastSavedAt).not.toBeNull();
  });

  it('sends choices without waiting', async () => {
    const save = vi.fn().mockResolvedValue(ok);
    const q = queue(save);
    q.set('q1', choice('a'), { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledWith('q1', choice('a'), expect.any(Number));
  });

  it('numbers every request higher than the last, even when the clock stands still', async () => {
    const save = vi.fn().mockResolvedValue(ok);
    const q = queue(save);
    q.set('q1', choice('a'), { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    q.set('q2', choice('b'), { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    q.set('q1', choice('c'), { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    const sequences = save.mock.calls.map((c) => c[2] as number);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(3);
  });

  it('starts sequence numbers from the clock so a reloaded page outranks the previous session', async () => {
    const save = vi.fn().mockResolvedValue(ok);
    const q = new AutosaveQueue({ save, clock: () => 1_700_000_000_000 });
    q.set('q1', choice('a'), { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(save.mock.calls[0]![2]).toBeGreaterThanOrEqual(1_700_000_000_000);
  });

  it('sends edits made during a request once it finishes, never in parallel', async () => {
    let release: (r: SaveResult) => void = () => undefined;
    const save = vi
      .fn()
      .mockImplementationOnce(() => new Promise<SaveResult>((resolve) => (release = resolve)))
      .mockResolvedValue(ok);
    const q = queue(save);
    q.set('q1', choice('a'), { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(q.getSnapshot().status).toBe('saving');
    q.set('q1', choice('b'), { immediate: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(save).toHaveBeenCalledTimes(1);
    release(ok);
    await vi.advanceTimersByTimeAsync(10);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![1]).toEqual(choice('b'));
    expect(q.getSnapshot().status).toBe('idle');
  });

  it('saves different questions independently', async () => {
    const save = vi.fn().mockResolvedValue(ok);
    const q = queue(save);
    q.set('q1', choice('a'), { immediate: true });
    q.set('q2', choice('b'), { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(save.mock.calls.map((c) => c[0]).sort()).toEqual(['q1', 'q2']);
  });

  it('sends null when an answer is cleared', async () => {
    const save = vi.fn().mockResolvedValue(ok);
    const q = queue(save);
    q.set('q1', null, { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledWith('q1', null, expect.any(Number));
  });

  it('reports each saved answer so the countdown can follow the server clock', async () => {
    const onSaved = vi.fn();
    const q = queue(vi.fn().mockResolvedValue({ ...ok, timeRemainingSeconds: 421 }), { onSaved });
    q.set('q1', choice('a'), { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(onSaved).toHaveBeenCalledWith(
      'q1',
      expect.objectContaining({ timeRemainingSeconds: 421 }),
    );
  });

  describe('failures', () => {
    it('retries network failures with backoff and keeps the answer', async () => {
      const save = vi
        .fn()
        .mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'offline'))
        .mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', 'busy'))
        .mockResolvedValue(ok);
      const q = queue(save, { retryDelaysMs: [1_000, 3_000] });
      q.set('q1', choice('a'), { immediate: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(q.getSnapshot().status).toBe('retrying');
      await vi.advanceTimersByTimeAsync(999);
      expect(save).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(save).toHaveBeenCalledTimes(2);
      expect(q.getSnapshot().status).toBe('retrying');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(save).toHaveBeenCalledTimes(3);
      expect(q.getSnapshot().status).toBe('idle');
      expect(save.mock.calls.every((c) => c[1]?.type === 'multiple_choice')).toBe(true);
    });

    it('does not retry an answer the server refused, and shows why', async () => {
      const refused = new ApiError(400, 'VALIDATION_FAILED', 'Invalid', [
        { path: 'response', message: 'Keep your answer to 12 words or fewer.' },
      ]);
      const save = vi.fn().mockRejectedValue(refused);
      const q = queue(save);
      q.set('q1', text('too long'), { immediate: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(save).toHaveBeenCalledTimes(1);
      expect(q.getSnapshot().status).toBe('failed');
      expect(q.getSnapshot().errors).toEqual({ q1: 'Keep your answer to 12 words or fewer.' });
    });

    it('clears the error and tries again when the learner edits the answer', async () => {
      const save = vi
        .fn()
        .mockRejectedValueOnce(new ApiError(400, 'VALIDATION_FAILED', 'Invalid'))
        .mockResolvedValue(ok);
      const q = queue(save);
      q.set('q1', text('bad'), { immediate: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(q.getSnapshot().status).toBe('failed');
      q.set('q1', text('good'), { immediate: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(q.getSnapshot().status).toBe('idle');
      expect(q.getSnapshot().errors).toEqual({});
    });

    it('tells the screen when the attempt is closed', async () => {
      const onClosed = vi.fn();
      const closed = new ApiError(409, 'ATTEMPT_EXPIRED', 'Time ran out on this quiz attempt.');
      const q = queue(vi.fn().mockRejectedValue(closed), { onClosed });
      q.set('q1', choice('a'), { immediate: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(onClosed).toHaveBeenCalledWith(closed);
      expect(q.getSnapshot().status).toBe('failed');
    });

    it('stops scheduling retries once the screen is gone', async () => {
      const save = vi.fn().mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'offline'));
      const q = queue(save);
      q.set('q1', choice('a'), { immediate: true });
      await vi.advanceTimersByTimeAsync(0);
      q.setActive(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(save).toHaveBeenCalledTimes(1);
    });
  });

  describe('flush', () => {
    it('sends everything that is waiting and reports nothing unsaved', async () => {
      const save = vi.fn().mockResolvedValue(ok);
      const q = queue(save);
      q.set('q1', text('A5'));
      q.set('q2', choice('a'));
      const pending = q.flush();
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toEqual([]);
      expect(save).toHaveBeenCalledTimes(2);
      expect(q.hasUnsaved()).toBe(false);
    });

    it('waits for a request that is already in flight', async () => {
      let release: (r: SaveResult) => void = () => undefined;
      const save = vi
        .fn()
        .mockImplementation(() => new Promise<SaveResult>((resolve) => (release = resolve)));
      const q = queue(save);
      q.set('q1', choice('a'), { immediate: true });
      await vi.advanceTimersByTimeAsync(0);
      let done = false;
      void q.flush().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(10);
      expect(done).toBe(false);
      release(ok);
      await vi.advanceTimersByTimeAsync(10);
      expect(done).toBe(true);
    });

    it('lists the questions that could not be stored', async () => {
      const save = vi.fn().mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'offline'));
      const q = queue(save);
      q.set('q1', choice('a'));
      const pending = q.flush();
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toEqual(['q1']);
      expect(q.hasUnsaved()).toBe(true);
    });
  });

  it('notifies subscribers only when something visible changes', async () => {
    const q = queue(vi.fn().mockResolvedValue(ok));
    const listener = vi.fn();
    q.subscribe(listener);
    q.set('q1', choice('a'), { immediate: true });
    expect(listener).toHaveBeenCalledTimes(1);
    q.set('q1', choice('b'), { immediate: true });
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('classifySaveError', () => {
  it('retries transient failures', () => {
    for (const status of [0, 401, 408, 429, 500, 502, 503]) {
      expect(classifySaveError(new ApiError(status, 'X', 'x'))).toEqual({ fatal: false });
    }
    expect(classifySaveError(new TypeError('failed to fetch'))).toEqual({ fatal: false });
  });

  it('gives up on a closed attempt and reports it', () => {
    expect(classifySaveError(new ApiError(409, 'ATTEMPT_SUBMITTED', 'Already submitted.'))).toEqual(
      {
        fatal: true,
        message: 'Already submitted.',
        closed: true,
      },
    );
  });

  it('prefers the field message of a refused answer', () => {
    const err = new ApiError(400, 'VALIDATION_FAILED', 'Some fields need attention.', [
      { path: 'response', message: 'Place every item exactly once.' },
    ]);
    expect(classifySaveError(err)).toEqual({
      fatal: true,
      message: 'Place every item exactly once.',
    });
  });
});
