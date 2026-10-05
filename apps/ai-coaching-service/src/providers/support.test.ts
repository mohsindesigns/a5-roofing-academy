import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parseJsonObject, providerJsonSchema } from './json-schema.js';
import { DEFAULT_MODEL_PRICES, estimateCostUsd, parsePriceTable, priceFor } from './pricing.js';
import { backoffDelay, timeoutSignal, withRetry } from './retry.js';
import { ProviderError } from './types.js';

describe('model prices and cost estimates', () => {
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  };

  it('prices Claude Opus 5.5 at $4 / $20 per million tokens with cheaper cache reads', () => {
    expect(
      estimateCostUsd(
        'claude-opus-5-5',
        { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        DEFAULT_MODEL_PRICES,
      ),
    ).toEqual({ costUsd: 4, priced: true });
    expect(
      estimateCostUsd(
        'claude-opus-5-5',
        { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        DEFAULT_MODEL_PRICES,
      ).costUsd,
    ).toBe(20);
    // 4 (input) + 20 (output) + 0.20 (cache read) + 5 (5-minute cache write: 1.25 x input)
    expect(estimateCostUsd('claude-opus-5-5', usage, DEFAULT_MODEL_PRICES).costUsd).toBe(29.2);
  });

  it('flags models without a price instead of guessing', () => {
    expect(estimateCostUsd('mystery-model', usage, DEFAULT_MODEL_PRICES)).toEqual({
      costUsd: 0,
      priced: false,
    });
    expect(estimateCostUsd('a5-dev-simulator-v1', usage, DEFAULT_MODEL_PRICES)).toEqual({
      costUsd: 0,
      priced: true,
    });
  });

  it('resolves dated snapshots to the base model price', () => {
    expect(priceFor('claude-haiku-4-5-20251001', DEFAULT_MODEL_PRICES)?.inputPerMTok).toBe(1);
    expect(priceFor('claude-opus-5-5-20260401', DEFAULT_MODEL_PRICES)?.outputPerMTok).toBe(20);
  });

  it('merges a configurable price table over the defaults', () => {
    const table = parsePriceTable(
      '{"gpt-5.5":{"inputPerMTok":1.25,"outputPerMTok":10},"claude-opus-5-5":{"inputPerMTok":3,"outputPerMTok":15}}',
    );
    expect(
      estimateCostUsd(
        'gpt-5.5',
        { inputTokens: 2_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        table,
      ).costUsd,
    ).toBe(3.5);
    expect(table['claude-opus-5-5']!.inputPerMTok).toBe(3);
    expect(table['claude-sonnet-5-5']!.inputPerMTok).toBe(2);
    expect(() => parsePriceTable('not json')).toThrow(/AI_MODEL_PRICES/);
    expect(() => parsePriceTable('{"x":{"inputPerMTok":-1,"outputPerMTok":1}}')).toThrow(
      /AI_MODEL_PRICES/,
    );
  });
});

describe('retry with backoff', () => {
  const transient = () => new ProviderError('anthropic', 'overloaded', 'busy', 529);

  it('retries transient errors up to the limit and then succeeds', async () => {
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue('ok');
    const seen: number[] = [];
    await expect(
      withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 1,
        onRetry: (_e, attempt) => seen.push(attempt),
      }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([1, 2]);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    const fn = vi.fn().mockRejectedValue(transient());
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1 })).rejects.toMatchObject({
      kind: 'overloaded',
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry permanent errors or unknown errors', async () => {
    const auth = vi.fn().mockRejectedValue(new ProviderError('anthropic', 'auth', 'bad key', 401));
    await expect(withRetry(auth, { maxRetries: 3, baseDelayMs: 1 })).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(auth).toHaveBeenCalledTimes(1);
    const unknown = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(withRetry(unknown, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow('boom');
    expect(unknown).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially with jitter and a cap', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const ceiling = Math.min(8_000, 500 * 2 ** attempt);
      const delay = backoffDelay(attempt, 500);
      expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it('times out and honours a parent abort', async () => {
    const signal = timeoutSignal(20);
    await new Promise((r) => setTimeout(r, 40));
    expect(signal.aborted).toBe(true);
    const parent = new AbortController();
    const combined = timeoutSignal(60_000, parent.signal);
    parent.abort();
    expect(combined.aborted).toBe(true);
  });
});

describe('provider JSON schema', () => {
  it('closes every object, requires every property and drops unsupported keywords', () => {
    const schema = providerJsonSchema(
      z.object({
        score: z.int().min(0).max(100),
        note: z.string().max(50),
        quote: z.string().nullable(),
        tags: z.array(z.object({ name: z.string(), weight: z.number().min(0) })).max(3),
        kind: z.enum(['a', 'b']),
      }),
    ) as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['score', 'note', 'quote', 'tags', 'kind']);
    expect(schema.properties.score).toEqual({ type: 'integer' });
    expect(schema.properties.note).toEqual({ type: 'string' });
    expect(schema.properties.quote).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(schema.properties.kind).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(schema.properties.tags).toMatchObject({
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name', 'weight'] },
    });
    expect(schema).not.toHaveProperty('$schema');
  });

  it('parses JSON objects from model text, tolerating code fences and chatter', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('Here you go: {"a":1} Hope that helps')).toEqual({ a: 1 });
    expect(() => parseJsonObject('no json here')).toThrow();
  });
});
