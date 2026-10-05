import OpenAI from 'openai';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions/completions.js';
import type { CompletionUsage } from 'openai/resources/completions.js';
import type { z } from 'zod';
import { parseJsonObject, providerJsonSchema } from './json-schema.js';
import { abortToProviderError, timeoutSignal } from './retry.js';
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
} from './types.js';

export interface OpenAIProviderSettings {
  apiKey: string;
  baseUrl?: string | undefined;
}

/** Reasoning models (GPT-5+, o-series) take `reasoning_effort` and reject custom temperatures. */
export function isOpenAIReasoningModel(model: string): boolean {
  return /^(gpt-[5-9]|gpt-\d{2}|o\d)/i.test(model);
}

function toMessages(system: string, messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return [
    { role: 'developer', content: system },
    ...messages.map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam),
  ];
}

function tuning(
  options: ProviderCallOptions,
): Pick<ChatCompletionCreateParamsNonStreaming, 'reasoning_effort' | 'temperature'> {
  if (isOpenAIReasoningModel(options.model)) {
    return options.effort ? { reasoning_effort: options.effort } : {};
  }
  return options.temperature !== undefined ? { temperature: options.temperature } : {};
}

/** Streaming request for one homeowner reply. `include_usage` makes the last chunk carry token usage. */
export function buildOpenAIConversationParams(
  messages: ChatMessage[],
  options: ProviderCallOptions,
): ChatCompletionCreateParamsStreaming {
  return {
    model: options.model,
    messages: toMessages(options.system, messages),
    max_completion_tokens: options.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...tuning(options),
  };
}

/** Structured output with a strict `json_schema` response format generated from the Zod schema. */
export function buildOpenAIStructuredParams(
  schema: z.ZodType,
  messages: ChatMessage[],
  options: StructuredCallOptions,
): ChatCompletionCreateParamsNonStreaming {
  return {
    model: options.model,
    messages: toMessages(options.system, messages),
    max_completion_tokens: options.maxOutputTokens,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: options.schemaName,
        description: options.schemaDescription,
        schema: providerJsonSchema(schema),
        strict: true,
      },
    },
    ...tuning(options),
  };
}

export function openAIUsage(usage: CompletionUsage | null | undefined): TokenUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

export function mapOpenAIError(err: unknown, signal?: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  const aborted = abortToProviderError('openai', err, signal);
  if (aborted) return aborted;
  if (err instanceof OpenAI.APIConnectionTimeoutError)
    return new ProviderError('openai', 'timeout', 'OpenAI did not respond in time.', undefined, {
      cause: err,
    });
  if (err instanceof OpenAI.APIConnectionError)
    return new ProviderError('openai', 'connection', 'Could not reach OpenAI.', undefined, {
      cause: err,
    });
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new ProviderError('openai', 'auth', 'The OpenAI API key was rejected.', err.status, {
      cause: err,
    });
  }
  if (err instanceof OpenAI.RateLimitError)
    return new ProviderError('openai', 'rate_limited', 'OpenAI rate limit reached.', 429, {
      cause: err,
    });
  if (
    err instanceof OpenAI.BadRequestError ||
    err instanceof OpenAI.NotFoundError ||
    err instanceof OpenAI.UnprocessableEntityError
  ) {
    return new ProviderError(
      'openai',
      'bad_request',
      `OpenAI rejected the request: ${err.message}`,
      err.status,
      { cause: err },
    );
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    if (status === 408 || status === 409 || status >= 500)
      return new ProviderError('openai', 'server', `OpenAI error ${status}.`, status, {
        cause: err,
      });
    return new ProviderError(
      'openai',
      'bad_request',
      `OpenAI error ${status}: ${err.message}`,
      status,
      { cause: err },
    );
  }
  return new ProviderError(
    'openai',
    'server',
    (err as Error)?.message ?? 'Unknown OpenAI error',
    undefined,
    { cause: err },
  );
}

export class OpenAIProvider implements AIProvider {
  readonly name = 'openai' as const;
  readonly label = 'OpenAI';
  readonly simulated = false;
  private readonly client: OpenAI;

  constructor(settings: OpenAIProviderSettings) {
    this.client = new OpenAI({ apiKey: settings.apiKey, baseURL: settings.baseUrl, maxRetries: 0 });
  }

  async complete(messages: ChatMessage[], options: ProviderCallOptions): Promise<CompletionResult> {
    let text = '';
    let final: CompletionResult | null = null;
    for await (const chunk of this.stream(messages, options)) {
      if (chunk.type === 'delta') text += chunk.text;
      else
        final = {
          text: chunk.text || text,
          usage: chunk.usage,
          model: chunk.model,
          stopReason: chunk.stopReason,
        };
    }
    if (!final)
      throw new ProviderError('openai', 'server', 'OpenAI stream ended without a result.');
    return final;
  }

  async *stream(messages: ChatMessage[], options: ProviderCallOptions): AsyncIterable<StreamChunk> {
    const signal = timeoutSignal(options.timeoutMs, options.signal);
    let text = '';
    let usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let model = options.model;
    let stopReason: string | null = null;
    try {
      const stream = await this.client.chat.completions.create(
        buildOpenAIConversationParams(messages, options),
        {
          signal,
          timeout: options.timeoutMs,
          maxRetries: 0,
        },
      );
      for await (const chunk of stream) {
        model = chunk.model || model;
        if (chunk.usage) usage = openAIUsage(chunk.usage);
        const choice = chunk.choices[0];
        if (choice?.finish_reason) stopReason = choice.finish_reason;
        if (choice?.delta?.refusal) {
          throw new ProviderError(
            'openai',
            'refusal',
            'The model declined to continue this conversation.',
            undefined,
            { retryable: false },
          );
        }
        const delta = choice?.delta?.content;
        if (delta) {
          text += delta;
          yield { type: 'delta', text: delta };
        }
      }
      yield { type: 'done', text, usage, model, stopReason };
    } catch (err) {
      throw mapOpenAIError(err, signal);
    }
  }

  async structured<S extends z.ZodType>(
    schema: S,
    messages: ChatMessage[],
    options: StructuredCallOptions,
  ): Promise<StructuredResult<z.infer<S>>> {
    const signal = timeoutSignal(options.timeoutMs, options.signal);
    let completion;
    try {
      completion = await this.client.chat.completions.create(
        buildOpenAIStructuredParams(schema, messages, options),
        {
          signal,
          timeout: options.timeoutMs,
          maxRetries: 0,
        },
      );
    } catch (err) {
      throw mapOpenAIError(err, signal);
    }
    const usage = openAIUsage(completion.usage);
    const choice = completion.choices[0];
    if (choice?.message.refusal) {
      throw new ProviderError(
        'openai',
        'refusal',
        'The model declined to produce a scorecard.',
        undefined,
        { retryable: false, usage },
      );
    }
    if (choice?.finish_reason === 'length') {
      throw new ProviderError(
        'openai',
        'invalid_output',
        'The structured response was cut off (length).',
        undefined,
        { usage },
      );
    }
    let candidate: unknown;
    try {
      candidate = parseJsonObject(choice?.message.content ?? '');
    } catch {
      candidate = undefined;
    }
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      throw new ProviderError(
        'openai',
        'invalid_output',
        `The model returned output that does not match ${options.schemaName}.`,
        undefined,
        {
          cause: parsed.error,
          usage,
        },
      );
    }
    return { value: parsed.data, usage, model: completion.model };
  }
}
