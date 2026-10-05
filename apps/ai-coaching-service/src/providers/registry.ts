import { Inject, Injectable } from '@nestjs/common';
import { LOGGER, ServiceUnavailableError } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { AI_CONFIG, type AiConfig } from '../config.js';
import type { ProviderPreference } from '../database/schema.js';
import { ClaudeProvider } from './claude.provider.js';
import { OpenAIProvider } from './openai.provider.js';
import {
  DEV_SIMULATOR_LABEL,
  DEV_SIMULATOR_MODEL,
  DevSimulatorProvider,
} from './simulator/simulator.provider.js';
import type { AIProvider, ProviderName } from './types.js';

export type Purpose = 'conversation' | 'evaluation';

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: 'Anthropic Claude',
  openai: 'OpenAI',
  dev_simulator: DEV_SIMULATOR_LABEL,
};

const ORDER: ProviderName[] = ['anthropic', 'openai', 'dev_simulator'];

export interface ProviderInfo {
  name: ProviderName;
  label: string;
  model: string;
  simulated: boolean;
}

export function providerInfo(name: ProviderName, model: string): ProviderInfo {
  return { name, label: PROVIDER_LABELS[name], model, simulated: name === 'dev_simulator' };
}

/** Provider family a model id belongs to, when recognisable. */
export function providerForModel(model: string | null | undefined): ProviderName | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.startsWith('claude-') || m.startsWith('anthropic.')) return 'anthropic';
  if (/^(gpt-|o\d|chatgpt-)/.test(m)) return 'openai';
  if (m.startsWith('a5-dev-simulator')) return 'dev_simulator';
  return null;
}

export interface ResolveInput {
  /** Scenario / prompt version preference (null = organization default). */
  provider: ProviderName | null;
  /** Purpose-specific model of the scenario (null = organization default). */
  model: string | null;
  settings: {
    defaultProvider: ProviderPreference;
    conversationModel: string | null;
    evaluationModel: string | null;
  };
}

export interface Resolved {
  provider: AIProvider;
  model: string;
  /** The preferred provider was not configured and another one was used. */
  fellBack: boolean;
}

/**
 * Chooses the provider and model for a call: scenario preference → organization default →
 * configured keys (Anthropic, then OpenAI) → development simulator (when enabled).
 */
@Injectable()
export class ProviderRegistry {
  private readonly providers = new Map<ProviderName, AIProvider>();

  constructor(
    @Inject(AI_CONFIG) private readonly config: AiConfig,
    simulator: DevSimulatorProvider,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    const p = config.ai.providers;
    if (p.anthropic.apiKey) {
      this.providers.set(
        'anthropic',
        new ClaudeProvider({
          apiKey: p.anthropic.apiKey,
          baseUrl: p.anthropic.baseUrl,
          serverFallback: p.anthropic.serverFallback,
        }),
      );
    }
    if (p.openai.apiKey)
      this.providers.set(
        'openai',
        new OpenAIProvider({ apiKey: p.openai.apiKey, baseUrl: p.openai.baseUrl }),
      );
    if (p.devSimulatorEnabled) this.providers.set('dev_simulator', simulator);
  }

  available(): ProviderName[] {
    return ORDER.filter((n) => this.providers.has(n));
  }

  isAvailable(name: ProviderName): boolean {
    return this.providers.has(name);
  }

  get(name: ProviderName): AIProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new ServiceUnavailableError(
        name === 'dev_simulator'
          ? 'The development simulator is disabled. Configure ANTHROPIC_API_KEY or OPENAI_API_KEY.'
          : `${PROVIDER_LABELS[name]} is not configured. Ask an administrator to add its API key or choose another provider in AI settings.`,
        { provider: name },
      );
    }
    return provider;
  }

  defaultModel(name: ProviderName, purpose: Purpose): string {
    const p = this.config.ai.providers;
    if (name === 'anthropic')
      return purpose === 'conversation'
        ? p.anthropic.conversationModel
        : p.anthropic.evaluationModel;
    if (name === 'openai')
      return purpose === 'conversation' ? p.openai.conversationModel : p.openai.evaluationModel;
    return DEV_SIMULATOR_MODEL;
  }

  resolve(purpose: Purpose, input: ResolveInput): Resolved {
    const preference: ProviderPreference =
      input.provider ?? input.settings.defaultProvider ?? this.config.ai.providers.defaultProvider;
    const firstAvailable = this.available()[0];
    if (!firstAvailable) {
      throw new ServiceUnavailableError(
        'No AI provider is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY for this service.',
      );
    }
    let name: ProviderName;
    let fellBack = false;
    if (preference === 'auto') name = firstAvailable;
    else if (this.isAvailable(preference)) name = preference;
    else {
      name = firstAvailable;
      fellBack = true;
      this.logger.warn(
        { preferred: preference, using: name, purpose },
        'preferred AI provider is not configured; falling back',
      );
    }
    const orgModel =
      purpose === 'conversation'
        ? input.settings.conversationModel
        : input.settings.evaluationModel;
    const model =
      [input.model, orgModel].find((m) => m && providerForModel(m) === name) ??
      this.defaultModel(name, purpose);
    return { provider: this.get(name), model, fellBack };
  }

  status() {
    return ORDER.map((name) => ({
      name,
      label: PROVIDER_LABELS[name],
      available: this.isAvailable(name),
      simulated: name === 'dev_simulator',
      defaultConversationModel: this.defaultModel(name, 'conversation'),
      defaultEvaluationModel: this.defaultModel(name, 'evaluation'),
    }));
  }
}
