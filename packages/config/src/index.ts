import { z } from 'zod';

export const nodeEnvSchema = z.enum(['development', 'test', 'staging', 'production']);
export type NodeEnv = z.infer<typeof nodeEnvSchema>;

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((v) => v === true || v === 'true' || v === '1' || v === 'yes');

const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

export const env = {
  boolean: (fallback?: boolean) =>
    fallback === undefined ? booleanish.optional() : booleanish.default(fallback),
  csv: (fallback?: string) =>
    fallback === undefined ? csv.optional() : z.string().default(fallback).pipe(csv),
  port: (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback),
  int: (fallback: number) => z.coerce.number().int().default(fallback),
  url: () => z.url(),
  secret: (minLength = 32) => z.string().min(minLength, `must be at least ${minLength} characters`),
};

/** Settings shared by every NestJS service. */
export const serviceEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  SERVICE_ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REDIS_URL: z.url(),
  INTERNAL_AUTH_SECRET: env.secret(32),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  SHUTDOWN_GRACE_MS: env.int(10_000),
});

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: env.int(10),
  DATABASE_STATEMENT_TIMEOUT_MS: env.int(15_000),
});

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: Array<{ key: string; message: string }>,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse environment variables against a schema and fail fast with a readable report.
 * Values are never echoed back, so secrets cannot leak into logs.
 */
export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && v !== '') cleaned[k] = v;
  const result = schema.safeParse(cleaned);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({
    key: i.path.join('.') || '(root)',
    message: i.message,
  }));
  const report = issues.map((i) => `  - ${i.key}: ${i.message}`).join('\n');
  throw new ConfigError(`Invalid configuration:\n${report}`, issues);
}

/** Guard against development defaults leaking into deployed environments. */
export function assertProductionSafe(
  nodeEnv: NodeEnv,
  checks: Array<[condition: boolean, message: string]>,
): void {
  if (nodeEnv !== 'production' && nodeEnv !== 'staging') return;
  const failures = checks.filter(([ok]) => !ok).map(([, m]) => ({ key: 'production', message: m }));
  if (failures.length) {
    throw new ConfigError(
      `Unsafe configuration for ${nodeEnv}:\n${failures.map((f) => `  - ${f.message}`).join('\n')}`,
      failures,
    );
  }
}

export { z };
