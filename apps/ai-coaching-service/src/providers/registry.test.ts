import { describe, expect, it } from 'vitest';
import { testLogger } from '@a5/nest-kit/testing';
import { loadAiConfig } from '../config.js';
import { ProviderRegistry, providerForModel } from './registry.js';
import { DevSimulatorProvider } from './simulator/simulator.provider.js';

const BASE = {
  NODE_ENV: 'test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  DATABASE_URL: 'postgres://a5:a5@127.0.0.1:5432/a5_ai',
  INTERNAL_AUTH_SECRET: 'test-internal-secret-0123456789abcdef0123',
};
const noSettings = {
  defaultProvider: 'auto' as const,
  conversationModel: null,
  evaluationModel: null,
};

function registry(env: Record<string, string> = {}) {
  return new ProviderRegistry(
    loadAiConfig({ ...BASE, ...env }),
    new DevSimulatorProvider(),
    testLogger(),
  );
}

describe('provider selection', () => {
  it('uses the development simulator when no API key is configured', () => {
    const r = registry();
    expect(r.available()).toEqual(['dev_simulator']);
    const picked = r.resolve('conversation', { provider: null, model: null, settings: noSettings });
    expect(picked.provider.name).toBe('dev_simulator');
    expect(picked.model).toBe('a5-dev-simulator-v1');
    expect(picked.provider.label).toBe('Development simulator');
  });

  it('selects a real provider automatically as soon as its key is configured', () => {
    const claude = registry({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(claude.available()).toEqual(['anthropic', 'dev_simulator']);
    const picked = claude.resolve('conversation', {
      provider: null,
      model: null,
      settings: noSettings,
    });
    expect(picked.provider.name).toBe('anthropic');
    expect(picked.model).toBe('claude-opus-5-5');
    expect(
      claude.resolve('evaluation', { provider: null, model: null, settings: noSettings }).model,
    ).toBe('claude-opus-5-5');

    const openai = registry({ OPENAI_API_KEY: 'sk-test' });
    expect(
      openai.resolve('conversation', { provider: null, model: null, settings: noSettings }),
    ).toMatchObject({ model: 'gpt-5.5', fellBack: false });
    expect(
      openai.resolve('conversation', { provider: null, model: null, settings: noSettings }).provider
        .name,
    ).toBe('openai');

    // Both keys: Anthropic wins unless the scenario or organization chooses otherwise.
    const both = registry({ ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' });
    expect(
      both.resolve('conversation', { provider: null, model: null, settings: noSettings }).provider
        .name,
    ).toBe('anthropic');
  });

  it('honours scenario and organization preferences, then models, in that order', () => {
    const r = registry({ ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' });
    expect(
      r.resolve('conversation', { provider: 'openai', model: null, settings: noSettings }).provider
        .name,
    ).toBe('openai');
    expect(
      r.resolve('conversation', {
        provider: null,
        model: null,
        settings: { ...noSettings, defaultProvider: 'openai' },
      }).provider.name,
    ).toBe('openai');
    expect(
      r.resolve('conversation', {
        provider: 'anthropic',
        model: null,
        settings: { ...noSettings, defaultProvider: 'openai' },
      }).provider.name,
    ).toBe('anthropic');
    const scenarioModel = r.resolve('conversation', {
      provider: null,
      model: 'claude-sonnet-5-5',
      settings: { ...noSettings, conversationModel: 'claude-opus-4-8' },
    });
    expect(scenarioModel.model).toBe('claude-sonnet-5-5');
    const orgModel = r.resolve('evaluation', {
      provider: null,
      model: null,
      settings: { ...noSettings, evaluationModel: 'claude-opus-4-8' },
    });
    expect(orgModel.model).toBe('claude-opus-4-8');
    // A model from another provider family is ignored rather than sent to the wrong API.
    expect(
      r.resolve('conversation', {
        provider: 'openai',
        model: 'claude-opus-5-5',
        settings: noSettings,
      }).model,
    ).toBe('gpt-5.5');
  });

  it('falls back to what is configured when the preferred provider has no key', () => {
    const r = registry();
    const picked = r.resolve('conversation', {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      settings: noSettings,
    });
    expect(picked).toMatchObject({ fellBack: true, model: 'a5-dev-simulator-v1' });
    expect(picked.provider.name).toBe('dev_simulator');
  });

  it('refuses to run without any provider in production', () => {
    const r = registry({ NODE_ENV: 'production', COOKIE_SECURE: 'true' });
    expect(r.available()).toEqual([]);
    expect(() =>
      r.resolve('conversation', { provider: null, model: null, settings: noSettings }),
    ).toThrow(/No AI provider is configured/);
    expect(() => r.get('anthropic')).toThrow(/not configured/);
    expect(registry({ NODE_ENV: 'production', ANTHROPIC_API_KEY: 'k' }).available()).toEqual([
      'anthropic',
    ]);
  });

  it('reports status for the settings screen and recognises model families', () => {
    expect(
      registry({ ANTHROPIC_API_KEY: 'k' })
        .status()
        .map((s) => [s.name, s.available]),
    ).toEqual([
      ['anthropic', true],
      ['openai', false],
      ['dev_simulator', true],
    ]);
    expect(providerForModel('claude-opus-5-5')).toBe('anthropic');
    expect(providerForModel('gpt-5.5')).toBe('openai');
    expect(providerForModel('o4-mini')).toBe('openai');
    expect(providerForModel('a5-dev-simulator-v1')).toBe('dev_simulator');
    expect(providerForModel('llama-3')).toBeNull();
    expect(providerForModel(null)).toBeNull();
  });
});

describe('configuration', () => {
  it('has safe, documented defaults for models, effort, timeouts and retries', () => {
    const c = loadAiConfig({ ...BASE }).ai.providers;
    expect(c).toMatchObject({
      defaultProvider: 'auto',
      devSimulatorEnabled: true,
      conversationEffort: 'low',
      evaluationEffort: 'high',
      conversationTimeoutMs: 45_000,
      evaluationTimeoutMs: 180_000,
      maxRetries: 2,
    });
    expect(c.anthropic.conversationModel).toBe('claude-opus-5-5');
    expect(c.anthropic.serverFallback).toBe(true);
    expect(c.prices['claude-opus-5-5']).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20 });
  });

  it('rejects invalid values and never echoes secrets', () => {
    expect(() => loadAiConfig({ ...BASE, AI_CONVERSATION_EFFORT: 'extreme' })).toThrow(
      /AI_CONVERSATION_EFFORT/,
    );
    expect(() => loadAiConfig({ ...BASE, AI_MODEL_PRICES: '{oops' })).toThrow(/AI_MODEL_PRICES/);
    expect(() =>
      loadAiConfig({ ...BASE, ANTHROPIC_API_KEY: 'sk-ant-secret', AI_DEFAULT_PROVIDER: 'bard' }),
    ).not.toThrow(/sk-ant-secret/);
  });
});
