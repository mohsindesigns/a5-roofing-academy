import { z } from 'zod';
import type { TokenUsage } from './types.js';

/** USD per million tokens. Cache prices default to 0.1x (read) and 1.25x (5-minute write) of input. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export type ModelPriceTable = Record<string, ModelPrice>;

/**
 * Built-in list prices (first-party API, USD / MTok). Override or extend with `AI_MODEL_PRICES`,
 * e.g. `{"gpt-5.5":{"inputPerMTok":1.25,"outputPerMTok":10}}`. Models without a price record
 * usage with `priced = false` so reports can flag them.
 */
export const DEFAULT_MODEL_PRICES: ModelPriceTable = {
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 0.25 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'a5-dev-simulator-v1': {
    inputPerMTok: 0,
    outputPerMTok: 0,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
  },
};

const priceSchema = z.object({
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
  cacheReadPerMTok: z.number().min(0).optional(),
  cacheWritePerMTok: z.number().min(0).optional(),
});

export function parsePriceTable(raw: string | undefined): ModelPriceTable {
  if (!raw) return { ...DEFAULT_MODEL_PRICES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'Invalid configuration:\n  - AI_MODEL_PRICES: must be a JSON object of model id → prices',
    );
  }
  const result = z.record(z.string(), priceSchema).safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid configuration:\n  - AI_MODEL_PRICES: ${result.error.issues[0]?.message ?? 'invalid'}`,
    );
  }
  return { ...DEFAULT_MODEL_PRICES, ...result.data };
}

/** Resolve the price of a model, tolerating dated snapshots (`claude-haiku-4-5-20251001`). */
export function priceFor(model: string, table: ModelPriceTable): ModelPrice | null {
  if (table[model]) return table[model];
  const base = Object.keys(table)
    .filter((k) => model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return base ? table[base]! : null;
}

export function estimateCostUsd(
  model: string,
  usage: TokenUsage,
  table: ModelPriceTable,
): { costUsd: number; priced: boolean } {
  const price = priceFor(model, table);
  if (!price) return { costUsd: 0, priced: false };
  const cacheRead = price.cacheReadPerMTok ?? price.inputPerMTok * 0.1;
  const cacheWrite = price.cacheWritePerMTok ?? price.inputPerMTok * 1.25;
  const cost =
    (usage.inputTokens * price.inputPerMTok +
      usage.outputTokens * price.outputPerMTok +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite) /
    1_000_000;
  return { costUsd: Math.round(cost * 1_000_000) / 1_000_000, priced: true };
}
