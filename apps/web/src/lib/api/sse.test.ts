import { describe, expect, it } from 'vitest';
import { createSseParser, type SseMessage } from './sse';

describe('createSseParser', () => {
  it('parses events split across chunks, multi-line data and comments', () => {
    const out: SseMessage[] = [];
    const parse = createSseParser((m) => out.push(m));
    parse(': heartbeat\n\nevent: delta\ndata: {"t":"Hel');
    parse('lo"}\n\nevent: done\r\ndata: line one\r\ndata: line two\r\nid: 7\r\n\r\n');
    expect(out).toEqual([
      { event: 'delta', data: '{"t":"Hello"}', id: undefined },
      { event: 'done', data: 'line one\nline two', id: '7' },
    ]);
  });

  it('defaults the event name to message', () => {
    const out: SseMessage[] = [];
    createSseParser((m) => out.push(m))('data: x\n\n');
    expect(out[0]?.event).toBe('message');
  });
});
