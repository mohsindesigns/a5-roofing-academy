import type { z } from 'zod';
import type { ProviderName, RubricCategoryRecord } from '../database/schema.js';

export type { ProviderName };

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Provider-neutral chat message. The homeowner is the `assistant`; the representative is the `user`. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TokenUsage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Persona as captured in a prompt version. */
export interface PersonaSnapshot {
  id: string;
  name: string;
  description: string;
  temperament: string;
  speakingStyle: string;
  background: string;
  traits: string[];
}

/** Prompt-relevant scenario fields as captured in a prompt version. */
export interface ScenarioSnapshot {
  id: string;
  title: string;
  category: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  objection: string;
  background: string;
  propertyContext: string;
  trigger: string;
  hiddenConcern: string;
  expectedBehaviors: string[];
  requiredTalkingPoints: string[];
  forbiddenClaims: string[];
  aiInstructions: string;
  openingLine: string;
  passingScore: number;
  maxTurns: number;
}

export interface TranscriptLine {
  seq: number;
  role: 'homeowner' | 'rep';
  content: string;
}

/**
 * Structured context next to the compiled prompt. Real providers only use the prompt; the
 * development simulator uses this to play the homeowner and score transcripts deterministically.
 */
export type SimulationContext =
  | { kind: 'conversation'; persona: PersonaSnapshot; scenario: ScenarioSnapshot }
  | {
      kind: 'evaluation';
      persona: PersonaSnapshot;
      scenario: ScenarioSnapshot;
      categories: RubricCategoryRecord[];
      transcript: TranscriptLine[];
      endReason: string | null;
    };

export interface ProviderCallOptions {
  model: string;
  system: string;
  maxOutputTokens: number;
  timeoutMs: number;
  effort?: Effort;
  temperature?: number;
  signal?: AbortSignal;
  simulation?: SimulationContext;
}

export interface StructuredCallOptions extends ProviderCallOptions {
  /** Tool / schema name, e.g. `submit_scorecard`. */
  schemaName: string;
  schemaDescription: string;
}

export interface CompletionResult {
  text: string;
  usage: TokenUsage;
  model: string;
  stopReason: string | null;
}

export type StreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string; usage: TokenUsage; model: string; stopReason: string | null };

export interface StructuredResult<T> {
  value: T;
  usage: TokenUsage;
  model: string;
}

export interface AIProvider {
  readonly name: ProviderName;
  /** Human label shown in API responses. */
  readonly label: string;
  /** True for the development simulator (never a real model). */
  readonly simulated: boolean;
  complete(messages: ChatMessage[], options: ProviderCallOptions): Promise<CompletionResult>;
  /** Text deltas followed by exactly one `done` chunk with the final usage. */
  stream(messages: ChatMessage[], options: ProviderCallOptions): AsyncIterable<StreamChunk>;
  /** Schema-validated object. */
  structured<S extends z.ZodType>(
    schema: S,
    messages: ChatMessage[],
    options: StructuredCallOptions,
  ): Promise<StructuredResult<z.infer<S>>>;
}

export type ProviderErrorKind =
  | 'timeout'
  | 'rate_limited'
  | 'overloaded'
  | 'connection'
  | 'server'
  | 'auth'
  | 'bad_request'
  | 'refusal'
  | 'invalid_output'
  | 'unavailable'
  | 'aborted';

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(['timeout', 'rate_limited', 'overloaded', 'connection', 'server', 'invalid_output']);

/** Normalized provider failure. `retryable` drives backoff in the engine and the evaluation job. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  /** Tokens spent before the failure (e.g. output that failed schema validation). */
  readonly usage: TokenUsage | undefined;

  constructor(
    readonly provider: ProviderName,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown; retryable?: boolean; usage?: TokenUsage },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'ProviderError';
    this.retryable = options?.retryable ?? RETRYABLE.has(kind);
    this.usage = options?.usage;
  }

  get code(): string {
    return `AI_PROVIDER_${this.kind.toUpperCase()}`;
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'APIUserAbortError');
}
