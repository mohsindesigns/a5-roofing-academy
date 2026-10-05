import { env, z } from '@a5/config';
import { loadServiceConfig } from '@a5/nest-kit';
import { parsePriceTable, type ModelPriceTable } from './providers/pricing.js';

const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

const aiEnv = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.url().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.url().optional(),
  /** auto | anthropic | openai | dev_simulator. Organization settings and scenarios can override it. */
  AI_DEFAULT_PROVIDER: z.enum(['auto', 'anthropic', 'openai', 'dev_simulator']).default('auto'),
  ANTHROPIC_CONVERSATION_MODEL: z.string().default('claude-opus-5-5'),
  ANTHROPIC_EVALUATION_MODEL: z.string().default('claude-opus-5-5'),
  /** Opt into Anthropic server-side refusal fallbacks (`fallbacks: "default"`) on models that support it. */
  ANTHROPIC_SERVER_FALLBACK: env.boolean(true),
  OPENAI_CONVERSATION_MODEL: z.string().default('gpt-5.5'),
  OPENAI_EVALUATION_MODEL: z.string().default('gpt-5.5'),
  /** Default reasoning effort for the homeowner (latency sensitive) and the evaluator. */
  AI_CONVERSATION_EFFORT: effort.default('low'),
  AI_EVALUATION_EFFORT: effort.default('high'),
  AI_CONVERSATION_MAX_TOKENS: env.int(4_000),
  AI_EVALUATION_MAX_TOKENS: env.int(16_000),
  /** Wall-clock limit for one homeowner reply attempt and one evaluation attempt. */
  AI_CONVERSATION_TIMEOUT_MS: env.int(45_000),
  AI_EVALUATION_TIMEOUT_MS: env.int(180_000),
  /** Retries (with exponential backoff) for transient provider errors before the first streamed token. */
  AI_PROVIDER_MAX_RETRIES: env.int(2),
  AI_PROVIDER_RETRY_BASE_MS: env.int(500),
  /** Attempts of the `ai.evaluate` job before the session is marked evaluation_failed. */
  AI_EVALUATION_ATTEMPTS: env.int(4),
  AI_EVALUATION_BACKOFF_MS: env.int(5_000),
  /** Active sessions without activity for this long are ended with reason `timeout`. */
  AI_SESSION_IDLE_TIMEOUT_MINUTES: env.int(30),
  /** Maintenance sweep interval (idle sessions, lost evaluation jobs, transcript retention). */
  AI_SWEEP_INTERVAL_MS: env.int(60_000),
  /** The scripted development simulator; defaults to enabled outside production. */
  AI_DEV_SIMULATOR_ENABLED: env.boolean(),
  /** Delay between simulated streamed words (makes the simulator feel like a real stream). */
  AI_SIMULATOR_STREAM_DELAY_MS: env.int(0),
  /** JSON object of per-model prices in USD per million tokens, merged over the built-in table. */
  AI_MODEL_PRICES: z.string().optional(),
  /** Secret that verifies lesson grants (defaults to INTERNAL_AUTH_SECRET, which learning-service signs with). */
  LESSON_GRANT_SECRET: z.string().min(32).optional(),
});

export interface AiProviderSettings {
  anthropic: {
    apiKey: string | null;
    baseUrl: string | undefined;
    conversationModel: string;
    evaluationModel: string;
    serverFallback: boolean;
  };
  openai: { apiKey: string | null; baseUrl: string | undefined; conversationModel: string; evaluationModel: string };
  defaultProvider: 'auto' | 'anthropic' | 'openai' | 'dev_simulator';
  devSimulatorEnabled: boolean;
  simulatorStreamDelayMs: number;
  conversationEffort: z.infer<typeof effort>;
  evaluationEffort: z.infer<typeof effort>;
  conversationMaxTokens: number;
  evaluationMaxTokens: number;
  conversationTimeoutMs: number;
  evaluationTimeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  prices: ModelPriceTable;
}

export function loadAiConfig(source?: Record<string, string | undefined>) {
  const config = loadServiceConfig('ai-coaching-service', 4050, aiEnv, { source });
  const e = config.env;
  const production = config.nodeEnv === 'production' || config.nodeEnv === 'staging';
  const providers: AiProviderSettings = {
    anthropic: {
      apiKey: e.ANTHROPIC_API_KEY?.trim() || null,
      baseUrl: e.ANTHROPIC_BASE_URL,
      conversationModel: e.ANTHROPIC_CONVERSATION_MODEL,
      evaluationModel: e.ANTHROPIC_EVALUATION_MODEL,
      serverFallback: e.ANTHROPIC_SERVER_FALLBACK ?? true,
    },
    openai: {
      apiKey: e.OPENAI_API_KEY?.trim() || null,
      baseUrl: e.OPENAI_BASE_URL,
      conversationModel: e.OPENAI_CONVERSATION_MODEL,
      evaluationModel: e.OPENAI_EVALUATION_MODEL,
    },
    defaultProvider: e.AI_DEFAULT_PROVIDER,
    devSimulatorEnabled: e.AI_DEV_SIMULATOR_ENABLED ?? !production,
    simulatorStreamDelayMs: e.AI_SIMULATOR_STREAM_DELAY_MS,
    conversationEffort: e.AI_CONVERSATION_EFFORT,
    evaluationEffort: e.AI_EVALUATION_EFFORT,
    conversationMaxTokens: e.AI_CONVERSATION_MAX_TOKENS,
    evaluationMaxTokens: e.AI_EVALUATION_MAX_TOKENS,
    conversationTimeoutMs: e.AI_CONVERSATION_TIMEOUT_MS,
    evaluationTimeoutMs: e.AI_EVALUATION_TIMEOUT_MS,
    maxRetries: Math.max(0, e.AI_PROVIDER_MAX_RETRIES),
    retryBaseMs: Math.max(0, e.AI_PROVIDER_RETRY_BASE_MS),
    prices: parsePriceTable(e.AI_MODEL_PRICES),
  };
  return {
    ...config,
    ai: {
      providers,
      evaluationAttempts: Math.max(1, e.AI_EVALUATION_ATTEMPTS),
      evaluationBackoffMs: Math.max(0, e.AI_EVALUATION_BACKOFF_MS),
      idleTimeoutMinutes: Math.max(1, e.AI_SESSION_IDLE_TIMEOUT_MINUTES),
      sweepIntervalMs: Math.max(1_000, e.AI_SWEEP_INTERVAL_MS),
      lessonGrantSecret: e.LESSON_GRANT_SECRET ?? config.internalAuthSecret,
    },
  };
}

export type AiConfig = ReturnType<typeof loadAiConfig>;
export const AI_CONFIG = Symbol('AI_CONFIG');
