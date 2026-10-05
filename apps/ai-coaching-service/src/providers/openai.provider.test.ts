import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { evaluationOutputSchema } from '../evaluation/output-schema.js';
import {
  OpenAIProvider,
  buildOpenAIConversationParams,
  buildOpenAIStructuredParams,
  isOpenAIReasoningModel,
  mapOpenAIError,
  openAIUsage,
} from './openai.provider.js';
import { ProviderError, type ProviderCallOptions, type StructuredCallOptions } from './types.js';

const conversation: ProviderCallOptions = {
  model: 'gpt-5.5',
  system: 'You are the homeowner.',
  maxOutputTokens: 4000,
  timeoutMs: 45_000,
  effort: 'low',
  temperature: 0.7,
};
const structured: StructuredCallOptions = {
  ...conversation,
  maxOutputTokens: 16_000,
  effort: 'high',
  schemaName: 'submit_scorecard',
  schemaDescription: 'Submit the scorecard.',
};
const messages = [
  { role: 'user' as const, content: '(knock)' },
  { role: 'assistant' as const, content: 'Oh, hi.' },
  { role: 'user' as const, content: 'Hello!' },
];

describe('OpenAI request builders', () => {
  it('builds a streaming chat request with usage reporting and the developer role for the system prompt', () => {
    const params = buildOpenAIConversationParams(messages, conversation);
    expect(params).toEqual({
      model: 'gpt-5.5',
      messages: [
        { role: 'developer', content: 'You are the homeowner.' },
        { role: 'user', content: '(knock)' },
        { role: 'assistant', content: 'Oh, hi.' },
        { role: 'user', content: 'Hello!' },
      ],
      max_completion_tokens: 4000,
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'low',
    });
  });

  it('uses reasoning effort for reasoning models and temperature for classic models', () => {
    expect(isOpenAIReasoningModel('gpt-5.5')).toBe(true);
    expect(isOpenAIReasoningModel('o4-mini')).toBe(true);
    expect(isOpenAIReasoningModel('gpt-4.1')).toBe(false);
    const classic = buildOpenAIConversationParams(messages, { ...conversation, model: 'gpt-4.1' });
    expect(classic.temperature).toBe(0.7);
    expect(classic).not.toHaveProperty('reasoning_effort');
    const reasoning = buildOpenAIConversationParams(messages, conversation);
    expect(reasoning).not.toHaveProperty('temperature');
    expect(
      buildOpenAIConversationParams(messages, { ...conversation, effort: undefined }),
    ).not.toHaveProperty('reasoning_effort');
  });

  it('requests structured output with a strict json_schema generated from the Zod schema', () => {
    const params = buildOpenAIStructuredParams(
      evaluationOutputSchema,
      [{ role: 'user', content: 'Transcript...' }],
      structured,
    );
    expect(params.stream).toBeUndefined();
    expect(params.max_completion_tokens).toBe(16_000);
    expect(params.reasoning_effort).toBe('high');
    expect(params.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'submit_scorecard', description: 'Submit the scorecard.', strict: true },
    });
    const schema = (params.response_format as { json_schema: { schema: Record<string, unknown> } })
      .json_schema.schema;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(evaluationOutputSchema.shape));
    const scores = (
      schema.properties as Record<
        string,
        { items: { properties: Record<string, unknown>; additionalProperties: boolean } }
      >
    ).categoryScores;
    expect(scores.items.additionalProperties).toBe(false);
    expect(Object.keys(scores.items.properties)).toEqual(['key', 'score', 'rationale', 'evidence']);
    expect(JSON.stringify(schema)).not.toMatch(/"minimum"|"maximum"|\$schema/);
  });

  it('separates cached prompt tokens from fresh input tokens', () => {
    expect(
      openAIUsage({
        prompt_tokens: 1000,
        completion_tokens: 80,
        total_tokens: 1080,
        prompt_tokens_details: { cached_tokens: 600 },
      }),
    ).toEqual({
      inputTokens: 400,
      outputTokens: 80,
      cacheReadTokens: 600,
      cacheWriteTokens: 0,
    });
    expect(openAIUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('classifies SDK errors', () => {
    const make = (status: number) =>
      OpenAI.APIError.generate(status, { message: 'm' }, 'm', new Headers());
    const kind = (status: number) => {
      const e = mapOpenAIError(make(status));
      return [e.kind, e.retryable];
    };
    expect(kind(400)).toEqual(['bad_request', false]);
    expect(kind(401)).toEqual(['auth', false]);
    expect(kind(429)).toEqual(['rate_limited', true]);
    expect(kind(500)).toEqual(['server', true]);
    expect(kind(503)).toEqual(['server', true]);
    expect(mapOpenAIError(new OpenAI.APIConnectionTimeoutError()).kind).toBe('timeout');
    expect(mapOpenAIError(new OpenAI.APIConnectionError({ message: 'reset' })).kind).toBe(
      'connection',
    );
  });
});

function provider(client: unknown) {
  const p = new OpenAIProvider({ apiKey: 'sk-test' });
  Object.assign(p, { client });
  return p;
}

async function* chunks(parts: unknown[]) {
  for (const p of parts) yield p;
}

describe('OpenAIProvider with a fake client', () => {
  it('streams deltas then reports usage from the final chunk', async () => {
    const calls: Array<{ params: Record<string, unknown>; options: Record<string, unknown> }> = [];
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
            calls.push({ params, options });
            return chunks([
              {
                model: 'gpt-5.5-2026-04-23',
                choices: [{ delta: { content: 'Oh, ' }, finish_reason: null }],
              },
              {
                model: 'gpt-5.5-2026-04-23',
                choices: [{ delta: { content: 'hi.' }, finish_reason: 'stop' }],
              },
              {
                model: 'gpt-5.5-2026-04-23',
                choices: [],
                usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 },
              },
            ]);
          },
        },
      },
    };
    const out = [];
    for await (const c of provider(client).stream(messages, conversation)) out.push(c);
    expect(out).toEqual([
      { type: 'delta', text: 'Oh, ' },
      { type: 'delta', text: 'hi.' },
      {
        type: 'done',
        text: 'Oh, hi.',
        usage: { inputTokens: 50, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'gpt-5.5-2026-04-23',
        stopReason: 'stop',
      },
    ]);
    expect(calls[0]!.options).toMatchObject({ timeout: 45_000, maxRetries: 0 });
    const text = await provider(client).complete(messages, conversation);
    expect(text.text).toBe('Oh, hi.');
  });

  it('surfaces refusals as non-retryable errors', async () => {
    const client = {
      chat: {
        completions: {
          create: async () =>
            chunks([
              { model: 'gpt-5.5', choices: [{ delta: { refusal: 'I cannot help with that.' } }] },
            ]),
        },
      },
    };
    await expect(provider(client).complete(messages, conversation)).rejects.toMatchObject({
      kind: 'refusal',
      retryable: false,
    });
  });

  it('parses and validates structured output', async () => {
    const value = {
      categoryScores: [],
      strengths: [],
      missedOpportunities: [],
      questionsToAsk: [],
      riskyStatements: [],
      recommendedResponses: [],
      nextGoal: 'g',
      summary: 's',
    };
    const ok = {
      chat: {
        completions: {
          create: async () => ({
            model: 'gpt-5.5',
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
          }),
        },
      },
    };
    const result = await provider(ok).structured(evaluationOutputSchema, messages, structured);
    expect(result.value).toEqual(value);
    expect(result.usage.outputTokens).toBe(5);

    const bad = {
      chat: {
        completions: {
          create: async () => ({
            model: 'gpt-5.5',
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            choices: [{ finish_reason: 'stop', message: { content: '{"summary": 1}' } }],
          }),
        },
      },
    };
    const error = await provider(bad)
      .structured(evaluationOutputSchema, messages, structured)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      kind: 'invalid_output',
      retryable: true,
      usage: { outputTokens: 5 },
    });

    const cut = {
      chat: {
        completions: {
          create: async () => ({
            model: 'gpt-5.5',
            choices: [{ finish_reason: 'length', message: { content: '{"sum' } }],
          }),
        },
      },
    };
    await expect(
      provider(cut).structured(evaluationOutputSchema, messages, structured),
    ).rejects.toMatchObject({ kind: 'invalid_output' });
  });
});
