import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import type { StreamEvent } from './chat-events';
import { initChat, chatReducer, type ChatAction, type ChatState } from './chat-state';
import {
  backoffDelay,
  runTurn,
  type TurnBody,
  type TurnDeps,
  type TurnRequest,
  type TurnTuning,
} from './run-turn';
import { message, session } from './test-fixtures';

const CID = '22222222-2222-4222-8222-222222222222';
const TUNING: TurnTuning = { maxRecoveries: 4, baseDelayMs: 10, maxDelayMs: 40 };

const opening = message(1, 'homeowner', "I don't have time right now.");
const repMsg = message(2, 'rep', 'Quick question: what is the best time today?');
const replyMsg = message(3, 'homeowner', 'Look, just leave your card.');

type StreamStep = StreamEvent[] | Error;

/** Scripted collaborators: each call to stream/getSession consumes the next scripted step. */
function harness(steps: {
  streams: StreamStep[];
  sessions?: Array<ReturnType<typeof session> | Error>;
}) {
  const bodies: TurnBody[] = [];
  const streams = [...steps.streams];
  const sessions = [...(steps.sessions ?? [])];
  const deps: TurnDeps = {
    async stream(body, { onEvent }) {
      bodies.push(body);
      const step = streams.shift();
      if (!step) throw new Error('unexpected stream call');
      if (step instanceof Error) throw step;
      step.forEach(onEvent);
    },
    async getSession() {
      const next = sessions.shift();
      if (!next) throw new Error('unexpected getSession call');
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: vi.fn(async () => undefined),
  };
  const actions: ChatAction[] = [];
  let state: ChatState = initChat(session({ messages: [opening] }));
  const dispatch = (a: ChatAction) => {
    actions.push(a);
    state = chatReducer(state, a);
  };
  const controller = new AbortController();
  const run = (request: TurnRequest, baselineSeq = 1) => {
    if (request.kind === 'message')
      dispatch({
        type: 'send',
        clientMessageId: request.clientMessageId,
        text: request.text,
        now: 'now',
      });
    return runTurn(deps, { request, baselineSeq, signal: controller.signal }, dispatch, TUNING);
  };
  return {
    run,
    bodies,
    actions,
    deps,
    controller,
    get state() {
      return state;
    },
  };
}

const sendRequest: TurnRequest = { kind: 'message', text: repMsg.content, clientMessageId: CID };
const accepted: StreamEvent = { type: 'accepted', repMessage: repMsg, retried: false };
const done = (over: Partial<Extract<StreamEvent, { type: 'done' }>> = {}): StreamEvent => ({
  type: 'done',
  message: replyMsg,
  sessionEnded: false,
  endReason: null,
  status: 'active',
  turnCount: 1,
  turnsRemaining: 9,
  ...over,
});
const networkError = () => new ApiError(0, 'NETWORK_ERROR', 'offline');
const conflict = (code: string) => new ApiError(409, code, code);
const withReply = () =>
  session({ messages: [opening, repMsg, replyMsg], turnCount: 1, awaitingReply: false });
const unanswered = () =>
  session({ messages: [opening, repMsg], turnCount: 1, awaitingReply: true });
const notSaved = () => session({ messages: [opening], turnCount: 0, awaitingReply: false });

describe('runTurn', () => {
  it('streams a reply from accepted to done', async () => {
    const h = harness({
      streams: [
        [
          accepted,
          { type: 'delta', text: 'Look, ' },
          { type: 'delta', text: 'just leave your card.' },
          done(),
        ],
      ],
    });
    expect(await h.run(sendRequest)).toBe('done');
    expect(h.bodies).toEqual([{ text: repMsg.content, clientMessageId: CID }]);
    expect(h.state.phase).toBe('idle');
    expect(h.state.messages.map((m) => m.role)).toEqual(['homeowner', 'rep', 'homeowner']);
    expect(h.state.messages.at(-1)?.content).toBe('Look, just leave your card.');
    expect(h.state.turnCount).toBe(1);
  });

  it('ignores events after the final one', async () => {
    const h = harness({ streams: [[accepted, done(), { type: 'delta', text: 'stray' }]] });
    await h.run(sendRequest);
    expect(h.state.draft).toBe('');
  });

  it('reports a server error event as a failed reply and keeps the message', async () => {
    const h = harness({
      streams: [
        [accepted, { type: 'error', code: 'AI_TURN_FAILED', message: 'Retry.', retryable: true }],
      ],
    });
    expect(await h.run(sendRequest)).toBe('failed');
    expect(h.state.phase).toBe('error');
    expect(h.state.error?.retryable).toBe(true);
    expect(h.state.messages.at(-1)).toMatchObject({ role: 'rep', delivery: 'sent' });
  });

  describe('when the connection drops', () => {
    it('adopts the saved reply if the server finished the turn', async () => {
      const h = harness({
        streams: [[accepted, { type: 'delta', text: 'Look, ' }]],
        sessions: [withReply()],
      });
      expect(await h.run(sendRequest)).toBe('synced');
      expect(h.state.phase).toBe('idle');
      expect(h.state.messages.at(-1)?.content).toBe(replyMsg.content);
      expect(h.state.draft).toBe('');
      // Nothing was sent twice.
      expect(h.bodies).toHaveLength(1);
    });

    it('treats a stream that ends without a result the same way', async () => {
      const h = harness({ streams: [[accepted]], sessions: [withReply()] });
      expect(await h.run(sendRequest)).toBe('synced');
    });

    it('waits with backoff while the reply is not saved yet, then asks for it with retry', async () => {
      const h = harness({
        streams: [networkError(), [accepted, { type: 'delta', text: 'Look.' }, done()]],
        sessions: [unanswered()],
      });
      expect(await h.run(sendRequest)).toBe('done');
      expect(h.deps.sleep).toHaveBeenCalledWith(backoffDelay(1, TUNING), expect.anything());
      expect(h.bodies[1]).toEqual({ retry: true });
    });

    it('resends the same message with the same client id if it never reached the server', async () => {
      const h = harness({
        streams: [networkError(), [{ ...accepted }, done()]],
        sessions: [notSaved()],
      });
      expect(await h.run(sendRequest)).toBe('done');
      expect(h.bodies).toEqual([
        { text: repMsg.content, clientMessageId: CID },
        { text: repMsg.content, clientMessageId: CID },
      ]);
      expect(h.state.messages.filter((m) => m.role === 'rep')).toHaveLength(1);
    });

    it('keeps polling when the original turn is still running (409 TURN_IN_PROGRESS)', async () => {
      const h = harness({
        streams: [networkError(), conflict('TURN_IN_PROGRESS')],
        sessions: [unanswered(), withReply()],
      });
      expect(await h.run(sendRequest)).toBe('synced');
      expect(h.bodies).toEqual([{ text: repMsg.content, clientMessageId: CID }, { retry: true }]);
      expect(h.state.messages.at(-1)?.content).toBe(replyMsg.content);
    });

    it('survives the session endpoint failing while offline', async () => {
      const h = harness({
        streams: [networkError()],
        sessions: [networkError(), networkError(), withReply()],
      });
      expect(await h.run(sendRequest)).toBe('synced');
    });

    it('stops after the configured number of rounds and offers a retry for the reply', async () => {
      const h = harness({
        streams: [
          [accepted],
          conflict('TURN_IN_PROGRESS'),
          conflict('TURN_IN_PROGRESS'),
          conflict('TURN_IN_PROGRESS'),
          conflict('TURN_IN_PROGRESS'),
        ],
        sessions: [unanswered(), unanswered(), unanswered(), unanswered()],
      });
      expect(await h.run(sendRequest)).toBe('failed');
      expect(h.state.phase).toBe('error');
      expect(h.state.error).toMatchObject({ code: 'CONNECTION_LOST', retryable: true });
      expect(h.state.messages.at(-1)).toMatchObject({ role: 'rep', delivery: 'sent' });
    });

    it('marks the message as not sent when it could never be confirmed', async () => {
      const h = harness({
        streams: [networkError()],
        sessions: [networkError(), networkError(), networkError(), networkError()],
      });
      expect(await h.run(sendRequest)).toBe('failed');
      expect(h.state.messages.at(-1)).toMatchObject({ key: CID, delivery: 'failed' });
      expect(h.state.error?.retryable).toBe(true);
    });

    it('shows the ended conversation if the session ended while disconnected', async () => {
      const ended = session({
        status: 'ended',
        endReason: 'max_turns',
        messages: [opening, repMsg, replyMsg],
        turnCount: 1,
      });
      const h = harness({ streams: [[accepted]], sessions: [ended] });
      expect(await h.run(sendRequest)).toBe('synced');
      expect(h.state.sessionStatus).toBe('ended');
      expect(h.state.endReason).toBe('max_turns');
    });
  });

  describe('when the request is rejected', () => {
    it('fails the message without retrying on a validation error', async () => {
      const h = harness({ streams: [new ApiError(400, 'VALIDATION_FAILED', 'Too long')] });
      expect(await h.run(sendRequest)).toBe('failed');
      expect(h.state.messages.at(-1)).toMatchObject({ key: CID, delivery: 'failed' });
      expect(h.state.error).toMatchObject({ code: 'VALIDATION_FAILED', retryable: false });
      expect(h.deps.sleep).not.toHaveBeenCalled();
    });

    it('treats a server error as retryable', async () => {
      const h = harness({ streams: [new ApiError(503, 'UNAVAILABLE', 'Down')] });
      await h.run(sendRequest);
      expect(h.state.error?.retryable).toBe(true);
    });

    it('reconciles instead of failing when the message was already answered', async () => {
      const h = harness({
        streams: [conflict('MESSAGE_ALREADY_SENT')],
        sessions: [withReply()],
      });
      expect(await h.run(sendRequest)).toBe('synced');
      expect(h.deps.sleep).not.toHaveBeenCalled();
      expect(h.state.messages.at(-1)?.content).toBe(replyMsg.content);
    });

    it('shows the ended conversation on SESSION_ENDED', async () => {
      const ended = session({ status: 'abandoned', messages: [opening], turnCount: 0 });
      const h = harness({ streams: [conflict('SESSION_ENDED')], sessions: [ended] });
      expect(await h.run(sendRequest)).toBe('synced');
      expect(h.state.sessionStatus).toBe('abandoned');
    });
  });

  describe('retry and watch requests', () => {
    it('asks only for the reply when retrying', async () => {
      const h = harness({ streams: [[{ ...accepted, retried: true }, done()]] });
      expect(await h.run({ kind: 'retry' }, 2)).toBe('done');
      expect(h.bodies).toEqual([{ retry: true }]);
    });

    it('watch mode never sends anything and adopts the reply when it lands', async () => {
      const h = harness({ streams: [], sessions: [unanswered(), withReply()] });
      expect(await h.run({ kind: 'watch' }, 2)).toBe('synced');
      expect(h.bodies).toHaveLength(0);
      expect(h.state.messages.at(-1)?.content).toBe(replyMsg.content);
    });

    it('watch mode gives up with a message that offers a retry', async () => {
      const h = harness({
        streams: [],
        sessions: [unanswered(), unanswered(), unanswered(), unanswered()],
      });
      expect(await h.run({ kind: 'watch' }, 2)).toBe('failed');
      expect(h.state.error).toMatchObject({ code: 'REPLY_MISSING', retryable: true });
      expect(h.bodies).toHaveLength(0);
    });
  });

  it('stops quietly when the learner leaves the page', async () => {
    const h = harness({ streams: [] });
    h.deps.stream = async () => {
      h.controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    };
    expect(await h.run(sendRequest)).toBe('aborted');
    expect(h.state.error).toBeNull();
  });
});

describe('backoffDelay', () => {
  it('grows and is capped', () => {
    const t: TurnTuning = { maxRecoveries: 8, baseDelayMs: 1000, maxDelayMs: 8000 };
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, t))).toEqual([
      1000, 1600, 2560, 4096, 6554, 8000,
    ]);
  });
});
