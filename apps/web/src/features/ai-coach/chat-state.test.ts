import { describe, expect, it } from 'vitest';
import {
  chatReducer,
  initChat,
  turnsRemaining,
  type ChatAction,
  type ChatState,
} from './chat-state';
import { message, session } from './test-fixtures';

const run = (state: ChatState, ...actions: ChatAction[]) => actions.reduce(chatReducer, state);
const start = () => initChat(session());
const CID = '11111111-1111-4111-8111-111111111111';
const send = (text = 'Hi, I am with A5 Roofing.'): ChatAction => ({
  type: 'send',
  clientMessageId: CID,
  text,
  now: '2026-10-05T16:01:00.000Z',
});

describe('chatReducer', () => {
  it('shows the learner message immediately and marks it as sending', () => {
    const s = run(start(), send());
    expect(s.phase).toBe('sending');
    expect(s.messages.at(-1)).toMatchObject({
      key: CID,
      role: 'rep',
      delivery: 'sending',
      id: null,
    });
  });

  it('confirms the optimistic message when the server accepts it, keeping its key stable', () => {
    const rep = message(2, 'rep', 'Hi, I am with A5 Roofing.');
    const s = run(start(), send(), { type: 'accepted', repMessage: rep, retried: false });
    const mine = s.messages.at(-1)!;
    expect(mine).toMatchObject({ key: CID, id: rep.id, seq: 2, delivery: 'sent' });
    expect(s.messages).toHaveLength(2);
    expect(s.phase).toBe('waiting');
    expect(s.turnCount).toBe(1);
  });

  it('does not count a retried message as a new turn', () => {
    const rep = message(2, 'rep', 'Hello');
    const s = run(
      initChat(session({ messages: [message(1, 'homeowner', 'Hi'), rep] })),
      { type: 'retry-reply' },
      { type: 'accepted', repMessage: rep, retried: true },
    );
    expect(s.turnCount).toBe(1);
    expect(s.messages).toHaveLength(2);
  });

  it('accumulates streamed text in the draft without saving a message', () => {
    const s = run(
      start(),
      send(),
      { type: 'accepted', repMessage: message(2, 'rep', 'x'), retried: false },
      { type: 'delta', text: 'Look, ' },
      { type: 'delta', text: 'I am busy.' },
    );
    expect(s.phase).toBe('streaming');
    expect(s.draft).toBe('Look, I am busy.');
    expect(s.messages.filter((m) => m.role === 'homeowner')).toHaveLength(1);
  });

  it('replaces the draft with the saved reply and takes the counters from the server', () => {
    const reply = message(3, 'homeowner', 'Look, I am busy.');
    const s = run(
      start(),
      send(),
      { type: 'accepted', repMessage: message(2, 'rep', 'x'), retried: false },
      { type: 'delta', text: 'Look, I am busy.' },
      { type: 'done', message: reply, status: 'active', endReason: null, turnCount: 1 },
    );
    expect(s.draft).toBe('');
    expect(s.phase).toBe('idle');
    expect(s.messages.at(-1)).toMatchObject({
      id: reply.id,
      role: 'homeowner',
      content: reply.content,
    });
    expect(turnsRemaining(s)).toBe(9);
  });

  it('records the end of the conversation reported with the final reply', () => {
    const s = run(
      start(),
      send(),
      { type: 'accepted', repMessage: message(2, 'rep', 'x'), retried: false },
      {
        type: 'done',
        message: message(3, 'homeowner', 'Okay. That works for me.'),
        status: 'ended',
        endReason: 'objective_reached',
        turnCount: 1,
      },
    );
    expect(s.sessionStatus).toBe('ended');
    expect(s.endReason).toBe('objective_reached');
    expect(turnsRemaining(s)).toBe(0);
  });

  it('keeps the saved learner message when only the reply failed', () => {
    const s = run(
      start(),
      send(),
      { type: 'accepted', repMessage: message(2, 'rep', 'x'), retried: false },
      { type: 'delta', text: 'partial' },
      {
        type: 'reply-failed',
        error: { code: 'AI_TURN_FAILED', message: 'Retry.', retryable: true },
      },
    );
    expect(s.phase).toBe('error');
    expect(s.draft).toBe('');
    expect(s.messages.at(-1)).toMatchObject({ role: 'rep', delivery: 'sent' });
  });

  it('marks the message as failed when the server never confirmed it', () => {
    const s = run(start(), send(), {
      type: 'send-failed',
      error: { code: 'NETWORK_ERROR', message: 'Offline', retryable: true },
    });
    expect(s.messages.at(-1)).toMatchObject({ key: CID, delivery: 'failed' });
    expect(s.phase).toBe('error');
  });

  it('resending a failed message reuses it instead of adding a duplicate', () => {
    const failed = run(start(), send(), {
      type: 'send-failed',
      error: { code: 'NETWORK_ERROR', message: 'Offline', retryable: true },
    });
    const again = run(failed, send());
    expect(again.messages.filter((m) => m.role === 'rep')).toHaveLength(1);
    expect(again.messages.at(-1)?.delivery).toBe('sending');
    expect(again.error).toBeNull();
  });

  it('discarding a failed message removes it and unblocks the composer', () => {
    const s = run(
      start(),
      send(),
      { type: 'send-failed', error: { code: 'X', message: 'x', retryable: true } },
      { type: 'discard-failed' },
    );
    expect(s.messages.some((m) => m.role === 'rep')).toBe(false);
    expect(s.phase).toBe('idle');
  });

  describe('after a dropped connection', () => {
    it('adopts the server transcript when the reply was saved', () => {
      const rep = message(2, 'rep', 'Hi, I am with A5 Roofing.');
      const reply = message(3, 'homeowner', 'Look, I am busy.');
      const s = run(
        start(),
        send(),
        { type: 'accepted', repMessage: rep, retried: false },
        { type: 'delta', text: 'Look, I am' },
        { type: 'connection-lost' },
        {
          type: 'sync',
          session: session({ messages: [message(1, 'homeowner', 'x'), rep, reply], turnCount: 1 }),
        },
      );
      expect(s.phase).toBe('idle');
      expect(s.draft).toBe('');
      expect(s.messages.map((m) => m.role)).toEqual(['homeowner', 'rep', 'homeowner']);
      expect(s.messages.at(-1)?.content).toBe('Look, I am busy.');
    });

    it('keeps recovering while the reply is still missing', () => {
      const rep = message(2, 'rep', 'Hi, I am with A5 Roofing.');
      const s = run(
        start(),
        send(),
        { type: 'connection-lost' },
        {
          type: 'sync',
          session: session({ messages: [message(1, 'homeowner', 'x'), rep], turnCount: 1 }),
        },
      );
      expect(s.phase).toBe('recovering');
      expect(s.messages.at(-1)).toMatchObject({ id: rep.id, delivery: 'sent' });
    });

    it('does not duplicate a message the server already has', () => {
      const text = 'Hi, I am with A5 Roofing.';
      const saved = message(2, 'rep', text);
      const s = run(
        start(),
        send(text),
        { type: 'connection-lost' },
        {
          type: 'sync',
          session: session({ messages: [message(1, 'homeowner', 'x'), saved], turnCount: 1 }),
        },
      );
      expect(s.messages.filter((m) => m.role === 'rep')).toHaveLength(1);
    });

    it('keeps a message the server never received so it can be sent again', () => {
      const s = run(
        start(),
        send(),
        { type: 'connection-lost' },
        {
          type: 'sync',
          session: session({ messages: [message(1, 'homeowner', 'x')], turnCount: 0 }),
        },
      );
      expect(s.messages.at(-1)).toMatchObject({ key: CID, delivery: 'failed' });
      expect(s.phase).toBe('error');
    });

    it('shows an ended session when the server says it ended meanwhile', () => {
      const s = run(
        start(),
        send(),
        { type: 'connection-lost' },
        {
          type: 'sync',
          session: session({
            status: 'ended',
            endReason: 'timeout',
            turnCount: 1,
            messages: [
              message(1, 'homeowner', 'x'),
              message(2, 'rep', 'Hi, I am with A5 Roofing.'),
            ],
          }),
        },
      );
      expect(s.sessionStatus).toBe('ended');
      expect(s.endReason).toBe('timeout');
      expect(s.phase).toBe('idle');
    });
  });
});
