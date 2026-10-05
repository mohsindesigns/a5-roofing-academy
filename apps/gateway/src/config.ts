import { readFileSync } from 'node:fs';
import { env, z } from '@a5/config';
import { loadServiceConfig } from '@a5/nest-kit';

const gatewayEnv = z.object({
  AUTH_JWT_PUBLIC_KEY: z.string().optional(),
  AUTH_JWT_PUBLIC_KEY_FILE: z.string().optional(),
  CORS_ORIGINS: env.csv(''),
  UPSTREAM_TIMEOUT_MS: env.int(30_000),
  MAX_BODY_BYTES: env.int(2 * 1024 * 1024),
  MAX_UPLOAD_BODY_BYTES: env.int(12 * 1024 * 1024),
  RATE_LIMIT_DEFAULT_PER_MINUTE: env.int(600),
  RATE_LIMIT_LOGIN_PER_MINUTE: env.int(10),
  RATE_LIMIT_SENSITIVE_PER_MINUTE: env.int(20),
  RATE_LIMIT_PUBLIC_PER_MINUTE: env.int(120),
});

export function loadGatewayConfig(source?: Record<string, string | undefined>) {
  const config = loadServiceConfig('gateway', 4000, gatewayEnv, { database: false, source });
  const e = config.env;
  const publicKey = e.AUTH_JWT_PUBLIC_KEY?.replace(/\\n/g, '\n') ?? (e.AUTH_JWT_PUBLIC_KEY_FILE ? readFileSync(e.AUTH_JWT_PUBLIC_KEY_FILE, 'utf8') : undefined);
  if (!publicKey) {
    throw new Error('Invalid configuration:\n  - AUTH_JWT_PUBLIC_KEY (or AUTH_JWT_PUBLIC_KEY_FILE) is required. Run `pnpm keys:generate`.');
  }
  const missing = Object.entries(config.serviceUrls)
    .filter(([, url]) => !url)
    .map(([name]) => name);
  if (missing.length && config.nodeEnv !== 'test') {
    throw new Error(`Invalid configuration:\n${missing.map((m) => `  - ${m.toUpperCase().replace(/-SERVICE$/, '').replace(/-/g, '_')}_SERVICE_URL is required`).join('\n')}`);
  }
  return {
    ...config,
    gateway: {
      publicKeyPem: publicKey,
      corsOrigins: e.CORS_ORIGINS ?? [],
      upstreamTimeoutMs: e.UPSTREAM_TIMEOUT_MS,
      maxBodyBytes: e.MAX_BODY_BYTES,
      maxUploadBodyBytes: e.MAX_UPLOAD_BODY_BYTES,
      rateLimits: {
        default: e.RATE_LIMIT_DEFAULT_PER_MINUTE,
        login: e.RATE_LIMIT_LOGIN_PER_MINUTE,
        sensitive: e.RATE_LIMIT_SENSITIVE_PER_MINUTE,
        public: e.RATE_LIMIT_PUBLIC_PER_MINUTE,
      },
    },
  };
}

export type GatewayConfig = ReturnType<typeof loadGatewayConfig>;
export const GATEWAY_CONFIG = Symbol('GATEWAY_CONFIG');
