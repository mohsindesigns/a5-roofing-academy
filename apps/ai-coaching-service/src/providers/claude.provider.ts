import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  BetaMessageParam,
  BetaUsage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import type { z } from 'zod';
import { parseJsonObject, providerJsonSchema } from './json-schema.js';
import { abortToProviderError, timeoutSignal } from './retry.js';
import {
  ProviderError,
  type AIProvider,
  type ChatMessage,
  type CompletionResult,
  type Effort,
  type ProviderCallOptions,
  type StreamChunk,
  type StructuredCallOptions,
  type StructuredResult,
  type TokenUsage,
} from './types.js';

export interface ClaudeProviderSettings {
  apiKey: string;
  baseUrl?: string | undefined;
  /** Opt into server-side refusal fallbacks (`fallbacks: "default"`) where the model supports it. */
  serverFallback: boolean;
}

export interface ClaudeCapabilities {
  /** `tool_choice: {type: "tool"}` is accepted (rejected with a 400 on Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1). */
  forcedToolChoice: boolean;
  /** temperature / top_p accepted (removed on Fable, Opus 4.7+, Sonnet 5+). */
  sampling: boolean;
  /** Supported `output_config.effort` levels (empty when effort is not supported). */
  effortLevels: readonly Effort[];
  /** Server-side refusal fallback with `fallbacks: "default"`. */
  serverFallback: boolean;
}

const ALL_EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Request-shape capabilities per Claude model family (see the claude-api model migration guide). */
export function claudeCapabilities(model: string): ClaudeCapabilities {
  const m = model.toLowerCase();
  const is = (...prefixes: string[]) =>
    prefixes.some((p) => m === p || m.startsWith(`${p}-`) || m.startsWith(`${p}@`));
  const noForcedTool = is(
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-fable-5-1',
    'claude-mythos-5-1',
  );
  const noSampling = is(
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-mythos-5-1',
    'claude-mythos-5',
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-5-5',
    'claude-sonnet-5',
  );
  let effortLevels: readonly Effort[] = ALL_EFFORTS;
  if (is('claude-opus-4-6', 'claude-sonnet-4-6')) effortLevels = ['low', 'medium', 'high', 'max'];
  else if (is('claude-opus-4-5')) effortLevels = ['low', 'medium', 'high'];
  else if (
    is('claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1') ||
    /^claude-(opus|sonnet)-4(-\d{8})?$/.test(m) // effort is not supported before Opus 4.5
  )
    effortLevels = [];
  return {
    forcedToolChoice: !noForcedTool,
    sampling: !noSampling,
    effortLevels,
    serverFallback: is('claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'),
  };
}

function normalizeEffort(
  effort: Effort | undefined,
  levels: readonly Effort[],
): Effort | undefined {
  if (!effort || levels.length === 0) return undefined;
  if (levels.includes(effort)) return effort;
  return effort === 'xhigh'
    ? levels.includes('high')
      ? 'high'
      : levels[levels.length - 1]
    : levels[levels.length - 1];
}

function toMessages(messages: ChatMessage[]): BetaMessageParam[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

type ClaudeParams = MessageCreateParamsNonStreaming;

function baseParams(
  messages: ChatMessage[],
  options: ProviderCallOptions,
  settings: Pick<ClaudeProviderSettings, 'serverFallback'>,
): ClaudeParams {
  const caps = claudeCapabilities(options.model);
  const params: ClaudeParams = {
    model: options.model,
    max_tokens: options.maxOutputTokens,
    // The compiled system prompt is identical for every turn of a prompt version: cache it.
    system: [{ type: 'text', text: options.system, cache_control: { type: 'ephemeral' } }],
    messages: toMessages(messages),
    // Automatic caching of the growing transcript prefix.
    cache_control: { type: 'ephemeral' },
  };
  const effort = normalizeEffort(options.effort, caps.effortLevels);
  if (effort) params.output_config = { effort };
  if (caps.sampling && options.temperature !== undefined) params.temperature = options.temperature;
  if (settings.serverFallback && caps.serverFallback) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  return params;
}

/** Request for one homeowner reply (streamed). */
export function buildClaudeConversationParams(
  messages: ChatMessage[],
  options: ProviderCallOptions,
  settings: Pick<ClaudeProviderSettings, 'serverFallback'>,
): ClaudeParams {
  return baseParams(messages, options, settings);
}

export const STRUCTURED_TOOL_INSTRUCTION = (name: string) =>
  `Return your answer only by calling the \`${name}\` tool exactly once with every field filled in.`;

/**
 * Request for schema-validated output. Models that accept forced tool use get a tool generated
 * from the Zod schema with `tool_choice: {type: "tool"}`; models that reject forced tool use
 * (Opus 5.5, Sonnet 5.5, Fable 5.1) get the same JSON schema as structured output
 * (`output_config.format`), which also guarantees schema-shaped JSON.
 */
export function buildClaudeStructuredParams(
  schema: z.ZodType,
  messages: ChatMessage[],
  options: StructuredCallOptions,
  settings: Pick<ClaudeProviderSettings, 'serverFallback'>,
): { params: ClaudeParams; mode: 'forced_tool' | 'output_format' } {
  const params = baseParams(messages, options, settings);
  const jsonSchema = providerJsonSchema(schema);
  if (claudeCapabilities(options.model).forcedToolChoice) {
    params.system = [
      {
        type: 'text',
        text: `${options.system}\n\n${STRUCTURED_TOOL_INSTRUCTION(options.schemaName)}`,
        cache_control: { type: 'ephemeral' },
      },
    ];
    params.tools = [
      {
        name: options.schemaName,
        description: options.schemaDescription,
        input_schema: jsonSchema as { type: 'object'; [key: string]: unknown },
        strict: true,
      },
    ];
    params.tool_choice = { type: 'tool', name: options.schemaName };
    return { params, mode: 'forced_tool' };
  }
  params.output_config = {
    ...params.output_config,
    format: { type: 'json_schema', schema: jsonSchema },
  };
  return { params, mode: 'output_format' };
}

export function claudeUsage(
  usage:
    | Pick<
        BetaUsage,
        'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'
      >
    | null
    | undefined,
): TokenUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

/** Map SDK errors to provider errors (most specific first). */
export function mapClaudeError(err: unknown, signal?: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  const aborted = abortToProviderError('anthropic', err, signal);
  if (aborted) return aborted;
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return new ProviderError(
      'anthropic',
      'timeout',
      'Anthropic did not respond in time.',
      undefined,
      { cause: err },
    );
  if (err instanceof Anthropic.APIConnectionError)
    return new ProviderError('anthropic', 'connection', 'Could not reach Anthropic.', undefined, {
      cause: err,
    });
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return new ProviderError(
      'anthropic',
      'auth',
      'The Anthropic API key was rejected.',
      err.status,
      { cause: err },
    );
  }
  if (err instanceof Anthropic.RateLimitError)
    return new ProviderError('anthropic', 'rate_limited', 'Anthropic rate limit reached.', 429, {
      cause: err,
    });
  if (
    err instanceof Anthropic.BadRequestError ||
    err instanceof Anthropic.NotFoundError ||
    err instanceof Anthropic.UnprocessableEntityError
  ) {
    return new ProviderError(
      'anthropic',
      'bad_request',
      `Anthropic rejected the request: ${err.message}`,
      err.status,
      { cause: err },
    );
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 529)
      return new ProviderError(
        'anthropic',
        'overloaded',
        'Anthropic is temporarily overloaded.',
        status,
        { cause: err },
      );
    if (status === 408 || status === 409 || status >= 500)
      return new ProviderError('anthropic', 'server', `Anthropic error ${status}.`, status, {
        cause: err,
      });
    return new ProviderError(
      'anthropic',
      'bad_request',
      `Anthropic error ${status}: ${err.message}`,
      status,
      { cause: err },
    );
  }
  return new ProviderError(
    'anthropic',
    'server',
    (err as Error)?.message ?? 'Unknown Anthropic error',
    undefined,
    { cause: err },
  );
}

/** A classifier decline arrives as HTTP 200 with `stop_reason: "refusal"`; check it before reading content. */
function assertNotRefused(message: Pick<BetaMessage, 'stop_reason' | 'usage'>): void {
  if (message.stop_reason === 'refusal') {
    throw new ProviderError(
      'anthropic',
      'refusal',
      'The model declined to continue this conversation.',
      undefined,
      {
        retryable: false,
        usage: claudeUsage(message.usage),
      },
    );
  }
}

function textOf(message: BetaMessage): string {
  return message.content
    .filter(
      (b): b is Extract<BetaMessage['content'][number], { type: 'text' }> => b.type === 'text',
    )
    .map((b) => b.text)
    .join('');
}

export class ClaudeProvider implements AIProvider {
  readonly name = 'anthropic' as const;
  readonly label = 'Anthropic Claude';
  readonly simulated = false;
  private readonly client: Anthropic;

  constructor(private readonly settings: ClaudeProviderSettings) {
    // Retries are owned by the engine and the evaluation job (bounded, observable), not the SDK.
    this.client = new Anthropic({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
      maxRetries: 0,
    });
  }

  async complete(messages: ChatMessage[], options: ProviderCallOptions): Promise<CompletionResult> {
    const signal = timeoutSignal(options.timeoutMs, options.signal);
    try {
      const params = buildClaudeConversationParams(messages, options, this.settings);
      const message = await this.client.beta.messages
        .stream(params, { signal, timeout: options.timeoutMs, maxRetries: 0 })
        .finalMessage();
      assertNotRefused(message);
      return {
        text: textOf(message),
        usage: claudeUsage(message.usage),
        model: message.model,
        stopReason: message.stop_reason,
      };
    } catch (err) {
      throw mapClaudeError(err, signal);
    }
  }

  async *stream(messages: ChatMessage[], options: ProviderCallOptions): AsyncIterable<StreamChunk> {
    const signal = timeoutSignal(options.timeoutMs, options.signal);
    let text = '';
    try {
      const params = buildClaudeConversationParams(messages, options, this.settings);
      const stream = this.client.beta.messages.stream(params, {
        signal,
        timeout: options.timeoutMs,
        maxRetries: 0,
      });
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta' &&
          event.delta.text
        ) {
          text += event.delta.text;
          yield { type: 'delta', text: event.delta.text };
        }
      }
      const message = await stream.finalMessage();
      assertNotRefused(message);
      yield {
        type: 'done',
        text,
        usage: claudeUsage(message.usage),
        model: message.model,
        stopReason: message.stop_reason,
      };
    } catch (err) {
      throw mapClaudeError(err, signal);
    }
  }

  async structured<S extends z.ZodType>(
    schema: S,
    messages: ChatMessage[],
    options: StructuredCallOptions,
  ): Promise<StructuredResult<z.infer<S>>> {
    const signal = timeoutSignal(options.timeoutMs, options.signal);
    let message: BetaMessage;
    const { params, mode } = buildClaudeStructuredParams(schema, messages, options, this.settings);
    try {
      message = await this.client.beta.messages
        .stream(params, { signal, timeout: options.timeoutMs, maxRetries: 0 })
        .finalMessage();
    } catch (err) {
      throw mapClaudeError(err, signal);
    }
    assertNotRefused(message);
    const usage = claudeUsage(message.usage);
    let candidate: unknown;
    if (mode === 'forced_tool') {
      const block = message.content.find(
        (b) => b.type === 'tool_use' && b.name === options.schemaName,
      );
      candidate = block && block.type === 'tool_use' ? block.input : undefined;
    } else {
      try {
        candidate = parseJsonObject(textOf(message));
      } catch {
        candidate = undefined;
      }
    }
    if (message.stop_reason === 'max_tokens') {
      throw new ProviderError(
        'anthropic',
        'invalid_output',
        'The structured response was cut off (max_tokens).',
        undefined,
        { usage },
      );
    }
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      throw new ProviderError(
        'anthropic',
        'invalid_output',
        `The model returned output that does not match ${options.schemaName}.`,
        undefined,
        {
          cause: parsed.error,
          usage,
        },
      );
    }
    return { value: parsed.data, usage, model: message.model };
  }
}
