import { readFileSync } from 'node:fs';
import { assertProductionSafe, env, z } from '@a5/config';
import { loadServiceConfig } from '@a5/nest-kit';

const identityEnv = z.object({
  AUTH_JWT_PRIVATE_KEY: z.string().optional(),
  AUTH_JWT_PRIVATE_KEY_FILE: z.string().optional(),
  AUTH_JWT_PUBLIC_KEY: z.string().optional(),
  AUTH_JWT_PUBLIC_KEY_FILE: z.string().optional(),
  AUTH_JWT_KID: z.string().default('a5-1'),
  ACCESS_TOKEN_TTL_SECONDS: env.int(600),
  ACTIVATION_TOKEN_TTL_HOURS: env.int(72),
  RESET_TOKEN_TTL_MINUTES: env.int(30),
  COOKIE_SECURE: env.boolean(),
  COOKIE_DOMAIN: z.string().optional(),
  /** Return activation links in API responses (non-production convenience when email is not configured). */
  EXPOSE_ACTIVATION_LINKS: env.boolean(),
});

function pem(value: string | undefined, file: string | undefined): string | undefined {
  if (value) return value.replace(/\\n/g, '\n');
  if (file) return readFileSync(file, 'utf8');
  return undefined;
}

export function loadIdentityConfig(source?: Record<string, string | undefined>) {
  const config = loadServiceConfig('identity-service', 4010, identityEnv, { source });
  const e = config.env;
  const privateKey = pem(e.AUTH_JWT_PRIVATE_KEY, e.AUTH_JWT_PRIVATE_KEY_FILE);
  const publicKey = pem(e.AUTH_JWT_PUBLIC_KEY, e.AUTH_JWT_PUBLIC_KEY_FILE);
  if (!privateKey || !publicKey) {
    throw new Error(
      'Invalid configuration:\n  - AUTH_JWT_PRIVATE_KEY / AUTH_JWT_PUBLIC_KEY (or *_FILE) are required. Run `pnpm keys:generate`.',
    );
  }
  const production = config.nodeEnv === 'production' || config.nodeEnv === 'staging';
  const cookieSecure = e.COOKIE_SECURE ?? production;
  const exposeLinks = e.EXPOSE_ACTIVATION_LINKS ?? !production;
  assertProductionSafe(config.nodeEnv, [
    [cookieSecure, 'COOKIE_SECURE must be true'],
    [!exposeLinks, 'EXPOSE_ACTIVATION_LINKS must be false'],
  ]);
  return {
    ...config,
    auth: {
      privateKeyPem: privateKey,
      publicKeyPem: publicKey,
      kid: e.AUTH_JWT_KID,
      accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
      activationTokenTtlHours: e.ACTIVATION_TOKEN_TTL_HOURS,
      resetTokenTtlMinutes: e.RESET_TOKEN_TTL_MINUTES,
      cookieSecure,
      cookieDomain: e.COOKIE_DOMAIN,
      exposeActivationLinks: exposeLinks,
    },
  };
}

export type IdentityConfig = ReturnType<typeof loadIdentityConfig>;
export const IDENTITY_CONFIG = Symbol('IDENTITY_CONFIG');
