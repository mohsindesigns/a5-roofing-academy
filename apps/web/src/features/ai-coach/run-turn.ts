import { ApiError } from '@/lib/api/errors';
import type { StreamEvent } from './chat-events';
import { REPLY_MISSING, type ChatAction, type SessionSnapshot, type TurnError } from './chat-state';

/**
 * One conversation turn over fetch-SSE, including what to do when the connection drops.
 *
 * The server keeps running a turn after the client disconnects and saves the reply, and the
 * event stream carries no ids, so it cannot be resumed from a position (there is nothing to put
 * in Last-Event-ID). Recovery therefore reconciles with the saved session instead:
 *
 *  1. read the session with backoff until the reply is saved, or the session ended;
 *  2. if our message was never saved, resend it with the same client id (the server de-duplicates);
 *  3. if it was saved but unanswered, ask for the reply with `retry`; a 409 TURN_IN_PROGRESS
 *     means the original turn is still running, so keep waiting.
 */

export type TurnRequest =
  | { kind: 'message'; text: string; clientMessageId: string }
  /** Ask for the homeowner's reply to the last saved learner message. */
  | { kind: 'retry' }
  /** Do not send anything; wait for a turn that is already running (page reload mid-reply). */
  | { kind: 'watch' };

export interface TurnBody {
  text?: string;
  retry?: boolean;
  clientMessageId?: string;
}

export interface TurnDeps {
  stream(
    body: TurnBody,
    options: { signal: AbortSignal; onEvent: (event: StreamEvent) => void },
  ): Promise<void>;
  getSession(signal: AbortSignal): Promise<SessionSnapshot>;
  /** Resolves after `ms`; rejects with an AbortError when the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface TurnTuning {
  /** Polling rounds (each preceded by a backoff) before giving up. */
  maxRecoveries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_TUNING: TurnTuning = {
  maxRecoveries: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
};

export type TurnOutcome = 'done' | 'failed' | 'synced' | 'aborted';

export function backoffDelay(round: number, t: TurnTuning): number {
  return Math.min(t.maxDelayMs, Math.round(t.baseDelayMs * 1.6 ** (round - 1)));
}

const isAbort = (err: unknown) => (err as { name?: string } | null)?.name === 'AbortError';

/** Codes meaning "the server already has an answer or a turn for this message": reconcile. */
const RECONCILE_CODES = new Set(['MESSAGE_ALREADY_SENT', 'NOTHING_TO_RETRY', 'SESSION_ENDED']);

type Attempt = { kind: 'finished'; outcome: TurnOutcome } | { kind: 'lost'; immediate: boolean };

type Recovery =
  { kind: 'finished'; outcome: TurnOutcome } | { kind: 'resend'; request: TurnRequest };

export async function runTurn(
  deps: TurnDeps,
  input: {
    request: TurnRequest;
    /** Highest message seq the server had confirmed before this turn started. */
    baselineSeq: number;
    signal: AbortSignal;
  },
  dispatch: (action: ChatAction) => void,
  tuning: TurnTuning = DEFAULT_TUNING,
): Promise<TurnOutcome> {
  const { baselineSeq, signal } = input;
  let current = input.request;
  let accepted = false;
  let rounds = 0;

  const bodyFor = (r: Exclude<TurnRequest, { kind: 'watch' }>): TurnBody =>
    r.kind === 'message' ? { text: r.text, clientMessageId: r.clientMessageId } : { retry: true };

  const fail = (error: TurnError): TurnOutcome => {
    // Without a confirmed message the learner needs to resend it; otherwise only the reply failed.
    dispatch(
      accepted || current.kind !== 'message'
        ? { type: 'reply-failed', error }
        : { type: 'send-failed', error },
    );
    return 'failed';
  };

  async function attempt(request: Exclude<TurnRequest, { kind: 'watch' }>): Promise<Attempt> {
    let terminal: 'done' | 'error' | null = null;
    try {
      await deps.stream(bodyFor(request), {
        signal,
        onEvent: (e) => {
          if (terminal) return;
          switch (e.type) {
            case 'accepted':
              accepted = true;
              dispatch({ type: 'accepted', repMessage: e.repMessage, retried: e.retried });
              break;
            case 'delta':
              dispatch({ type: 'delta', text: e.text });
              break;
            case 'done':
              terminal = 'done';
              dispatch({
                type: 'done',
                message: e.message,
                status: e.status,
                endReason: e.endReason,
                turnCount: e.turnCount,
              });
              break;
            case 'error':
              terminal = 'error';
              dispatch({
                type: 'reply-failed',
                error: { code: e.code, message: e.message, retryable: e.retryable },
              });
              break;
          }
        },
      });
    } catch (err) {
      if (signal.aborted || isAbort(err)) return { kind: 'finished', outcome: 'aborted' };
      if (err instanceof ApiError && err.status > 0) {
        // Another request owns the turn: wait for its reply.
        if (err.code === 'TURN_IN_PROGRESS') return { kind: 'lost', immediate: false };
        if (RECONCILE_CODES.has(err.code)) return { kind: 'lost', immediate: true };
        return {
          kind: 'finished',
          outcome: fail({
            code: err.code,
            message: err.message,
            retryable: err.status >= 500 || err.status === 429,
          }),
        };
      }
      // Network failure or a stream cut mid-reply.
      return { kind: 'lost', immediate: false };
    }
    const done = terminal as 'done' | 'error' | null;
    if (done) return { kind: 'finished', outcome: done === 'done' ? 'done' : 'failed' };
    // The server closed the stream without a result: find out what it saved.
    return { kind: 'lost', immediate: false };
  }

  async function recover(immediate: boolean): Promise<Recovery> {
    dispatch({ type: 'connection-lost' });
    let skipDelay = immediate;
    for (;;) {
      if (++rounds > tuning.maxRecoveries) {
        return {
          kind: 'finished',
          outcome: fail(
            current.kind === 'watch'
              ? REPLY_MISSING
              : {
                  code: 'CONNECTION_LOST',
                  message: accepted
                    ? "We lost the connection before the homeowner's reply arrived. Your message is saved."
                    : "We couldn't confirm that your message was sent. Check your connection and try again.",
                  retryable: true,
                },
          ),
        };
      }
      try {
        if (!skipDelay) await deps.sleep(backoffDelay(rounds, tuning), signal);
        skipDelay = false;
      } catch {
        return { kind: 'finished', outcome: 'aborted' };
      }

      let snapshot: SessionSnapshot;
      try {
        snapshot = await deps.getSession(signal);
      } catch (err) {
        if (signal.aborted || isAbort(err)) return { kind: 'finished', outcome: 'aborted' };
        continue; // still offline or the server is restarting
      }

      const last = snapshot.messages[snapshot.messages.length - 1];
      const replied = Boolean(last && last.role === 'homeowner' && last.seq > baselineSeq);
      if (snapshot.status !== 'active' || replied) {
        dispatch({ type: 'sync', session: snapshot });
        return { kind: 'finished', outcome: 'synced' };
      }
      if (current.kind === 'watch') {
        dispatch({ type: 'sync', session: snapshot });
        continue;
      }
      if (last?.role === 'rep') {
        // Saved but unanswered: ask for the reply (409 means the first turn is still running).
        dispatch({ type: 'sync', session: snapshot });
        return { kind: 'resend', request: { kind: 'retry' } };
      }
      // Our message never arrived: resend it; the client id keeps this idempotent.
      return { kind: 'resend', request: current };
    }
  }

  for (;;) {
    if (signal.aborted) return 'aborted';
    let lost: Extract<Attempt, { kind: 'lost' }> = { kind: 'lost', immediate: false };
    if (current.kind !== 'watch') {
      const result = await attempt(current);
      if (result.kind === 'finished') return result.outcome;
      lost = result;
    }
    const recovery = await recover(lost.immediate);
    if (recovery.kind === 'finished') return recovery.outcome;
    current = recovery.request;
  }
}
