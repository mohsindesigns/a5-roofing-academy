import { describe, expect, it } from 'vitest';
import { ConfigError, assertProductionSafe, env, loadEnv, serviceEnvSchema, z } from './index.js';

describe('loadEnv', () => {
  it('applies defaults and coercion', () => {
    const cfg = loadEnv(serviceEnvSchema.extend({ PORT: env.port(4010), FLAGS: env.csv('a,b') }), {
      REDIS_URL: 'redis://localhost:6379',
      INTERNAL_AUTH_SECRET: 'x'.repeat(32),
      PORT: '5000',
    });
    expect(cfg.PORT).toBe(5000);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.FLAGS).toEqual(['a', 'b']);
  });

  it('reports every invalid key without echoing values', () => {
    try {
      loadEnv(serviceEnvSchema, { REDIS_URL: 'nope', INTERNAL_AUTH_SECRET: 'short-secret-value' });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const e = err as ConfigError;
      expect(e.issues.map((i) => i.key).sort()).toEqual(['INTERNAL_AUTH_SECRET', 'REDIS_URL']);
      expect(e.message).not.toContain('short-secret-value');
    }
  });

  it('treats empty strings as missing', () => {
    const schema = z.object({ A: z.string().default('fallback') });
    expect(loadEnv(schema, { A: '' }).A).toBe('fallback');
  });

  it('parses booleans', () => {
    const schema = z.object({ A: env.boolean(false), B: env.boolean(false) });
    expect(loadEnv(schema, { A: 'true', B: '0' })).toEqual({ A: true, B: false });
  });
});

describe('assertProductionSafe', () => {
  it('ignores development', () => {
    expect(() => assertProductionSafe('development', [[false, 'nope']])).not.toThrow();
  });
  it('throws in production', () => {
    expect(() =>
      assertProductionSafe('production', [[false, 'COOKIE_SECURE must be true']]),
    ).toThrow(/COOKIE_SECURE/);
  });
});
