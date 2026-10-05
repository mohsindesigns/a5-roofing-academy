import { describe, expect, it } from 'vitest';
import { createSseParser, type SseMessage } from '@/lib/api/sse';
import { parseStreamEvent } from './chat-events';
import { message } from './test-fixtures';

const sse = (event: string, data: unknown): SseMessage => ({ event, data: JSON.stringify(data) });

describe('parseStreamEvent', () => {
  it('reads the four conversation events', () => {
    const rep = message(2, 'rep', 'Hello');
    const reply = message(3, 'homeowner', 'Hi');
    expect(parseStreamEvent(sse('accepted', { repMessage: rep, retried: false }))).toEqual({
      type: 'accepted',
      repMessage: rep,
      retried: false,
    });
    expect(parseStreamEvent(sse('delta', { text: 'Hi' }))).toEqual({ type: 'delta', text: 'Hi' });
    expect(
      parseStreamEvent(
        sse('done', {
          messageId: reply.id,
          message: reply,
          sessionEnded: false,
          endReason: null,
          status: 'active',
          turnCount: 1,
          turnsRemaining: 9,
        }),
      ),
    ).toMatchObject({ type: 'done', message: reply, turnsRemaining: 9 });
    expect(
      parseStreamEvent(sse('error', { code: 'AI_TURN_FAILED', message: 'Retry', retryable: true })),
    ).toEqual({ type: 'error', code: 'AI_TURN_FAILED', message: 'Retry', retryable: true });
  });

  it('ignores unknown events and rejects malformed payloads', () => {
    expect(parseStreamEvent(sse('heartbeat', {}))).toBeNull();
    expect(parseStreamEvent(sse('delta', { text: 5 }))).toBeNull();
    expect(parseStreamEvent({ event: 'delta', data: '{not json' })).toBeNull();
  });

  it('parses the byte stream the server writes, including chunks split mid-event', () => {
    const events: string[] = [];
    const parse = createSseParser((m) => {
      const e = parseStreamEvent(m);
      if (e) events.push(e.type === 'delta' ? `delta:${e.text}` : e.type);
    });
    parse(': keep-alive\n\nevent: delta\ndata: {"text":"Look');
    parse(', I am busy."}\n\nevent: delta\ndata: {"text":" Really."}\n\n');
    expect(events).toEqual(['delta:Look, I am busy.', 'delta: Really.']);
  });
});
