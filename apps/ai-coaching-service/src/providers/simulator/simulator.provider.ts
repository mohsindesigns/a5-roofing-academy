import type { z } from 'zod';
import { simulateEvaluation } from './evaluator.js';
import { simulateHomeownerReply } from './homeowner.js';
import {
  ProviderError,
  type AIProvider,
  type ChatMessage,
  type CompletionResult,
  type ProviderCallOptions,
  type StreamChunk,
  type StructuredCallOptions,
  type StructuredResult,
  type TokenUsage,
} from '../types.js';

export const DEV_SIMULATOR_MODEL = 'a5-dev-simulator-v1';
export const DEV_SIMULATOR_LABEL = 'Development simulator';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function usageFor(
  options: ProviderCallOptions,
  messages: readonly ChatMessage[],
  output: string,
): TokenUsage {
  const input = options.system + messages.map((m) => m.content).join('\n');
  return {
    inputTokens: estimateTokens(input),
    outputTokens: estimateTokens(output),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(
        new ProviderError('dev_simulator', 'aborted', 'The request was cancelled.', undefined, {
          retryable: false,
        }),
      );
    });
  });
}

/**
 * Deterministic stand-in for a real model, used when no API key is configured (development,
 * tests, demos). It is always labelled "Development simulator" in API responses. It plays a
 * scripted homeowner from the scenario context and scores transcripts heuristically.
 */
export class DevSimulatorProvider implements AIProvider {
  readonly name = 'dev_simulator' as const;
  readonly label = DEV_SIMULATOR_LABEL;
  readonly simulated = true;

  constructor(private readonly streamDelayMs = 0) {}

  private reply(messages: ChatMessage[], options: ProviderCallOptions): string {
    const sim = options.simulation;
    if (sim?.kind !== 'conversation') {
      throw new ProviderError(
        'dev_simulator',
        'bad_request',
        'The development simulator needs the scenario context to play the homeowner.',
        undefined,
        {
          retryable: false,
        },
      );
    }
    return simulateHomeownerReply(sim.persona, sim.scenario, messages);
  }

  async complete(messages: ChatMessage[], options: ProviderCallOptions): Promise<CompletionResult> {
    const text = this.reply(messages, options);
    return {
      text,
      usage: usageFor(options, messages, text),
      model: DEV_SIMULATOR_MODEL,
      stopReason: 'end_turn',
    };
  }

  async *stream(messages: ChatMessage[], options: ProviderCallOptions): AsyncIterable<StreamChunk> {
    const text = this.reply(messages, options);
    const parts = text.match(/\S+\s*/g) ?? [text];
    for (const part of parts) {
      await sleep(this.streamDelayMs, options.signal);
      yield { type: 'delta', text: part };
    }
    yield {
      type: 'done',
      text,
      usage: usageFor(options, messages, text),
      model: DEV_SIMULATOR_MODEL,
      stopReason: 'end_turn',
    };
  }

  async structured<S extends z.ZodType>(
    schema: S,
    messages: ChatMessage[],
    options: StructuredCallOptions,
  ): Promise<StructuredResult<z.infer<S>>> {
    const sim = options.simulation;
    if (sim?.kind !== 'evaluation') {
      throw new ProviderError(
        'dev_simulator',
        'bad_request',
        `The development simulator cannot produce ${options.schemaName}.`,
        undefined,
        {
          retryable: false,
        },
      );
    }
    const output = simulateEvaluation({
      persona: sim.persona,
      scenario: sim.scenario,
      categories: sim.categories,
      transcript: sim.transcript,
      endReason: sim.endReason,
    });
    const parsed = schema.safeParse(output);
    if (!parsed.success) {
      throw new ProviderError(
        'dev_simulator',
        'invalid_output',
        `Simulated output does not match ${options.schemaName}.`,
        undefined,
        {
          cause: parsed.error,
          retryable: false,
        },
      );
    }
    return {
      value: parsed.data,
      usage: usageFor(options, messages, JSON.stringify(output)),
      model: DEV_SIMULATOR_MODEL,
    };
  }
}
