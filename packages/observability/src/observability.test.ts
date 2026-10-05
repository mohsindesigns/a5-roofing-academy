import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { REDACT_PATHS, getContext, patchContext, runWithContext, uuidv7 } from './index.js';

describe('uuidv7', () => {
  it('produces RFC 9562 version 7 ids in time order', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7());
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('request context', () => {
  it('is isolated per async scope and patchable', async () => {
    const seen: Array<string | null | undefined> = [];
    await Promise.all(
      ['a', 'b'].map((id) =>
        runWithContext({ requestId: id, correlationId: id }, async () => {
          await new Promise((r) => setTimeout(r, 5));
          patchContext({ userId: `user-${id}` });
          seen.push(getContext()?.userId);
        }),
      ),
    );
    expect(seen.sort()).toEqual(['user-a', 'user-b']);
    expect(getContext()).toBeUndefined();
  });
});

describe('logger redaction', () => {
  it('censors secrets', () => {
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); } });
    const logger = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink);
    logger.info({ password: 'hunter2', req: { headers: { authorization: 'Bearer abc' } } }, 'login');
    expect(lines.join('')).not.toContain('hunter2');
    expect(lines.join('')).not.toContain('Bearer abc');
  });
});
