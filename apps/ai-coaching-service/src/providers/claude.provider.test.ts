import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { evaluationOutputSchema } from '../evaluation/output-schema.js';
import {
  ClaudeProvider,
  STRUCTURED_TOOL_INSTRUCTION,
  buildClaudeConversationParams,
  buildClaudeStructuredParams,
  claudeCapabilities,
  claudeUsage,
  mapClaudeError,
} from './claude.provider.js';
import { ProviderError, type ProviderCallOptions, type StructuredCallOptions } from './types.js';

const conversation: ProviderCallOptions = {
  model: 'claude-opus-5-5',
  system: 'You are the homeowner.',
  maxOutputTokens: 4000,
  timeoutMs: 45_000,
  effort: 'low',
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

describe('Claude capabilities by model', () => {
  it('knows which request features each model family accepts', () => {
    expect(claudeCapabilities('claude-opus-5-5')).toMatchObject({
      forcedToolChoice: false,
      sampling: false,
      serverFallback: true,
    });
    expect(claudeCapabilities('claude-sonnet-5-5')).toMatchObject({
      forcedToolChoice: false,
      sampling: false,
      serverFallback: true,
    });
    expect(claudeCapabilities('claude-fable-5-1')).toMatchObject({
      forcedToolChoice: false,
      sampling: false,
    });
    expect(claudeCapabilities('claude-opus-5')).toMatchObject({
      forcedToolChoice: true,
      sampling: false,
    });
    expect(claudeCapabilities('claude-opus-4-8')).toMatchObject({
      forcedToolChoice: true,
      sampling: false,
      serverFallback: false,
    });
    expect(claudeCapabilities('claude-sonnet-4-6')).toMatchObject({
      forcedToolChoice: true,
      sampling: true,
    });
    expect(claudeCapabilities('claude-opus-4-6').effortLevels).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ]);
    expect(claudeCapabilities('claude-haiku-4-5').effortLevels).toEqual([]);
    expect(claudeCapabilities('claude-haiku-4-5-20251001').effortLevels).toEqual([]);
  });
});

describe('conversation request', () => {
  it('builds a cached, low-effort request on Claude Opus 5.5 with server-side refusal fallback', () => {
    const params = buildClaudeConversationParams(messages, conversation, { serverFallback: true });
    expect(params).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      system: [
        { type: 'text', text: 'You are the homeowner.', cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        { role: 'user', content: '(knock)' },
        { role: 'assistant', content: 'Oh, hi.' },
        { role: 'user', content: 'Hello!' },
      ],
      cache_control: { type: 'ephemeral' },
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  });

  it('never sends parameters the model rejects', () => {
    const opus = buildClaudeConversationParams(
      messages,
      { ...conversation, temperature: 0.7 },
      { serverFallback: true },
    );
    expect(opus).not.toHaveProperty('temperature'); // sampling parameters 400 on Opus 5.5
    expect(opus).not.toHaveProperty('thinking'); // thinking cannot be disabled; effort is the control
    expect(opus).not.toHaveProperty('tool_choice');

    const sonnet46 = buildClaudeConversationParams(
      messages,
      { ...conversation, model: 'claude-sonnet-4-6', temperature: 0.7, effort: 'xhigh' },
      { serverFallback: true },
    );
    expect(sonnet46.temperature).toBe(0.7);
    expect(sonnet46.output_config).toEqual({ effort: 'high' }); // xhigh is not offered on 4.6
    expect(sonnet46).not.toHaveProperty('fallbacks'); // not offered for this model

    const haiku = buildClaudeConversationParams(
      messages,
      { ...conversation, model: 'claude-haiku-4-5' },
      { serverFallback: true },
    );
    expect(haiku).not.toHaveProperty('output_config'); // effort errors on Haiku 4.5
  });

  it('can opt out of server-side fallback', () => {
    const params = buildClaudeConversationParams(messages, conversation, { serverFallback: false });
    expect(params).not.toHaveProperty('fallbacks');
    expect(params).not.toHaveProperty('betas');
  });
});

describe('structured output request', () => {
  it('uses forced tool use generated from the Zod schema on models that accept it', () => {
    const { params, mode } = buildClaudeStructuredParams(
      evaluationOutputSchema,
      [{ role: 'user', content: 'Transcript...' }],
      { ...structured, model: 'claude-opus-4-8' },
      { serverFallback: true },
    );
    expect(mode).toBe('forced_tool');
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'submit_scorecard' });
    expect(params.tools).toHaveLength(1);
    const tool = params.tools![0] as {
      name: string;
      description: string;
      strict: boolean;
      input_schema: Record<string, unknown>;
    };
    expect(tool).toMatchObject({
      name: 'submit_scorecard',
      description: 'Submit the scorecard.',
      strict: true,
    });
    expect(tool.input_schema.type).toBe('object');
    expect(tool.input_schema.additionalProperties).toBe(false);
    expect(Object.keys(tool.input_schema.properties as object)).toEqual(
      Object.keys(evaluationOutputSchema.shape),
    );
    expect(tool.input_schema.required).toEqual(Object.keys(evaluationOutputSchema.shape));
    expect(JSON.stringify(tool.input_schema)).not.toMatch(/"minimum"|"maximum"|\$schema/); // strict mode rejects bounds
    expect(params.system).toEqual([
      {
        type: 'text',
        text: `You are the homeowner.\n\n${STRUCTURED_TOOL_INSTRUCTION('submit_scorecard')}`,
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(params.output_config).toEqual({ effort: 'high' });
    expect(params).not.toHaveProperty('fallbacks'); // Opus 4.8 is not a refusal-fallback source
  });

  it('uses structured outputs (output_config.format) on models where forced tool use returns a 400', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']) {
      const { params, mode } = buildClaudeStructuredParams(
        evaluationOutputSchema,
        [{ role: 'user', content: 'Transcript...' }],
        { ...structured, model },
        { serverFallback: false },
      );
      expect(mode).toBe('output_format');
      expect(params).not.toHaveProperty('tool_choice');
      expect(params).not.toHaveProperty('tools');
      expect(params.output_config).toMatchObject({
        effort: 'high',
        format: { type: 'json_schema' },
      });
      const format = params.output_config!.format as {
        schema: { type: string; additionalProperties: boolean };
      };
      expect(format.schema.type).toBe('object');
      expect(format.schema.additionalProperties).toBe(false);
    }
  });

  it('represents nullable fields with anyOf and keeps every property required', () => {
    const schema = z.object({
      quote: z.string().nullable(),
      turn: z.int().min(1),
      tags: z.array(z.string()).max(3),
    });
    const { params } = buildClaudeStructuredParams(
      schema,
      messages,
      { ...structured, model: 'claude-opus-4-8' },
      { serverFallback: false },
    );
    const input = (
      params.tools![0] as {
        input_schema: { properties: Record<string, unknown>; required: string[] };
      }
    ).input_schema;
    expect(input.properties.quote).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(input.required).toEqual(['quote', 'turn', 'tags']);
  });
});

describe('usage and errors', () => {
  it('maps API usage including prompt-cache tokens', () => {
    expect(
      claudeUsage({
        input_tokens: 120,
        output_tokens: 45,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 50,
      }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
    });
    expect(
      claudeUsage({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      }),
    ).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(claudeUsage(undefined).inputTokens).toBe(0);
  });

  it('classifies SDK errors so the engine knows what to retry', () => {
    const make = (status: number) =>
      Anthropic.APIError.generate(
        status,
        { type: 'error', error: { type: 'x', message: 'm' } },
        'm',
        new Headers(),
      );
    const expectKind = (status: number, kind: string, retryable: boolean) => {
      const err = mapClaudeError(make(status));
      expect([err.kind, err.retryable], String(status)).toEqual([kind, retryable]);
    };
    expectKind(400, 'bad_request', false);
    expectKind(401, 'auth', false);
    expectKind(403, 'auth', false);
    expectKind(404, 'bad_request', false);
    expectKind(429, 'rate_limited', true);
    expectKind(500, 'server', true);
    expectKind(529, 'overloaded', true);
    expect(mapClaudeError(new Anthropic.APIConnectionError({ message: 'reset' })).kind).toBe(
      'connection',
    );
    expect(mapClaudeError(new Anthropic.APIConnectionTimeoutError()).kind).toBe('timeout');
    const passthrough = new ProviderError('anthropic', 'refusal', 'declined');
    expect(mapClaudeError(passthrough)).toBe(passthrough);
  });
});

/** Fake of the part of the SDK the provider uses, so no network is involved. */
function fakeClient(final: unknown, events: unknown[] = []) {
  const calls: Array<{ params: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>, options: Record<string, unknown>) {
          calls.push({ params, options });
          return {
            async *[Symbol.asyncIterator]() {
              for (const e of events) yield e;
            },
            finalMessage: async () => final,
          };
        },
      },
    },
  };
  return { client, calls };
}

function provider(client: unknown) {
  const p = new ClaudeProvider({ apiKey: 'sk-ant-test', serverFallback: true });
  Object.assign(p, { client });
  return p;
}

const usage = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 5,
};

describe('ClaudeProvider with a fake client', () => {
  it('streams text deltas and reports final usage', async () => {
    const { client, calls } = fakeClient(
      {
        model: 'claude-opus-5-5',
        stop_reason: 'end_turn',
        usage,
        content: [{ type: 'text', text: 'Oh, hi.' }],
      },
      [
        { type: 'message_start' },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Oh, ' } },
        { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'ignored' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi.' } },
      ],
    );
    const chunks = [];
    for await (const c of provider(client).stream(messages, conversation)) chunks.push(c);
    expect(chunks).toEqual([
      { type: 'delta', text: 'Oh, ' },
      { type: 'delta', text: 'hi.' },
      {
        type: 'done',
        text: 'Oh, hi.',
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 5 },
        model: 'claude-opus-5-5',
        stopReason: 'end_turn',
      },
    ]);
    expect(calls[0]!.params.model).toBe('claude-opus-5-5');
    expect(calls[0]!.options).toMatchObject({ timeout: 45_000, maxRetries: 0 });
    expect(calls[0]!.options.signal).toBeInstanceOf(AbortSignal);
  });

  it('turns a classifier refusal into a non-retryable error', async () => {
    const { client } = fakeClient({
      model: 'claude-opus-5-5',
      stop_reason: 'refusal',
      usage,
      content: [],
    });
    await expect(provider(client).complete(messages, conversation)).rejects.toMatchObject({
      kind: 'refusal',
      retryable: false,
    });
  });

  it('reads the forced tool input as the validated object', async () => {
    const value = {
      categoryScores: [
        {
          key: 'discovery',
          score: 80,
          rationale: 'Asked good questions.',
          evidence: [{ turn: 2, quote: 'What have you noticed?' }],
        },
      ],
      strengths: [],
      missedOpportunities: [],
      questionsToAsk: [],
      riskyStatements: [],
      recommendedResponses: [],
      nextGoal: 'g',
      summary: 's',
    };
    const { client, calls } = fakeClient({
      model: 'claude-opus-4-8',
      stop_reason: 'tool_use',
      usage,
      content: [
        { type: 'text', text: 'Scoring now.' },
        { type: 'tool_use', name: 'submit_scorecard', input: value },
      ],
    });
    const result = await provider(client).structured(evaluationOutputSchema, messages, {
      ...structured,
      model: 'claude-opus-4-8',
    });
    expect(result.value).toEqual(value);
    expect(result.usage.outputTokens).toBe(20);
    expect(calls[0]!.params.tool_choice).toEqual({ type: 'tool', name: 'submit_scorecard' });
  });

  it('parses structured outputs from text on models without forced tool use', async () => {
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
    const { client } = fakeClient({
      model: 'claude-opus-5-5',
      stop_reason: 'end_turn',
      usage,
      content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` }],
    });
    const result = await provider(client).structured(evaluationOutputSchema, messages, structured);
    expect(result.value.nextGoal).toBe('g');
  });

  it('rejects output that does not match the schema, keeping the spent tokens for cost tracking', async () => {
    const { client } = fakeClient({
      model: 'claude-opus-4-8',
      stop_reason: 'tool_use',
      usage,
      content: [{ type: 'tool_use', name: 'submit_scorecard', input: { summary: 1 } }],
    });
    const error = await provider(client)
      .structured(evaluationOutputSchema, messages, { ...structured, model: 'claude-opus-4-8' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      kind: 'invalid_output',
      retryable: true,
      usage: { outputTokens: 20 },
    });
    const truncated = fakeClient({
      model: 'claude-opus-4-8',
      stop_reason: 'max_tokens',
      usage,
      content: [],
    });
    await expect(
      provider(truncated.client).structured(evaluationOutputSchema, messages, {
        ...structured,
        model: 'claude-opus-4-8',
      }),
    ).rejects.toMatchObject({ kind: 'invalid_output' });
  });
});
