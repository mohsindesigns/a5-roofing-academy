import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { defaultServerConditions } from 'vite';

/**
 * Shared Vitest configuration.
 * - `@a5/source` makes workspace packages resolve to their TypeScript sources.
 * - oxc legacy decorators + metadata keep NestJS dependency injection working.
 */
export function createVitestConfig(overrides: ViteUserConfig = {}): ViteUserConfig {
  const conditions = ['@a5/source', ...defaultServerConditions];
  return defineConfig({
    oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
    resolve: { conditions },
    ssr: { resolve: { conditions, externalConditions: ['@a5/source'] } },
    ...overrides,
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
      testTimeout: 20_000,
      hookTimeout: 60_000,
      ...overrides.test,
    },
  } as ViteUserConfig);
}
