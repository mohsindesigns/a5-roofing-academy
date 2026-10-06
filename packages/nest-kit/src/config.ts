import { databaseEnvSchema, env, loadEnv, serviceEnvSchema, z } from '@a5/config';
import { eventSigningSecretEnvName, PRODUCERS, type Producer } from '@a5/events';

export interface ServiceRuntimeConfig {
  serviceName: Producer;
  nodeEnv: 'development' | 'test' | 'staging' | 'production';
  role: 'api' | 'worker' | 'all';
  host: string;
  port: number;
  logLevel: string;
  redisUrl: string;
  redisNamespace: string;
  internalAuthSecret: string;
  eventSigningSecret?: string;
  eventSigningKeys: Partial<Record<Producer, string>>;
  allowUnsignedEvents: boolean;
  databaseUrl?: string | undefined;
  databasePoolMax: number;
  databaseStatementTimeoutMs: number;
  otlpEndpoint?: string | undefined;
  swaggerEnabled: boolean;
  bodyLimit: string;
  shutdownGraceMs: number;
  /** Base URLs of other services for internal calls, keyed by service name. */
  serviceUrls: Partial<Record<Producer, string>>;
  /** Public web origin, used to build links (activation, verification). */
  publicAppUrl: string;
}

const signingSecretShape = Object.fromEntries(
  PRODUCERS.map((producer) => [eventSigningSecretEnvName(producer), z.string().min(32).optional()]),
);

const baseSchema = serviceEnvSchema.extend({
  ...signingSecretShape,
  EVENTS_ALLOW_UNSIGNED: env.boolean(),
  REDIS_NAMESPACE: z
    .string()
    .regex(/^[a-zA-Z0-9:_-]+$/)
    .default('a5'),
  SWAGGER_ENABLED: env.boolean(),
  BODY_LIMIT: z.string().default('1mb'),
  PUBLIC_APP_URL: z.url().default('http://localhost:5173'),
  IDENTITY_SERVICE_URL: z.url().optional(),
  LEARNING_SERVICE_URL: z.url().optional(),
  MEDIA_SERVICE_URL: z.url().optional(),
  ASSESSMENT_SERVICE_URL: z.url().optional(),
  AI_SERVICE_URL: z.url().optional(),
  CERTIFICATION_SERVICE_URL: z.url().optional(),
  NOTIFICATION_SERVICE_URL: z.url().optional(),
  ANALYTICS_SERVICE_URL: z.url().optional(),
  AUDIT_SERVICE_URL: z.url().optional(),
});

/**
 * Load the runtime configuration shared by every service plus a service-specific schema.
 * Fails fast on missing or invalid values.
 */
export function loadServiceConfig<S extends z.ZodObject>(
  serviceName: Producer,
  defaultPort: number,
  extra: S,
  options: { database?: boolean; source?: Record<string, string | undefined> } = {},
): ServiceRuntimeConfig & { env: z.infer<S> } {
  const schema = baseSchema
    .extend({ PORT: env.port(defaultPort) })
    .extend(options.database === false ? {} : databaseEnvSchema.shape)
    .extend(extra.shape);
  const raw = loadEnv(schema, options.source) as Record<string, unknown>;
  const nodeEnv = raw.NODE_ENV as ServiceRuntimeConfig['nodeEnv'];
  const eventSigningKeys = Object.fromEntries(
    PRODUCERS.flatMap((producer) => {
      const secret = raw[eventSigningSecretEnvName(producer)] as string | undefined;
      return secret ? [[producer, secret]] : [];
    }),
  ) as Partial<Record<Producer, string>>;
  const eventSigningSecret = eventSigningKeys[serviceName];
  if ((nodeEnv === 'production' || nodeEnv === 'staging') && !eventSigningSecret) {
    throw new Error(`Invalid configuration:\n  - ${eventSigningSecretEnvName(serviceName)} is required`);
  }
  return {
    serviceName,
    nodeEnv,
    role: raw.SERVICE_ROLE as ServiceRuntimeConfig['role'],
    host: raw.HOST as string,
    port: raw.PORT as number,
    logLevel: raw.LOG_LEVEL as string,
    redisUrl: raw.REDIS_URL as string,
    redisNamespace: raw.REDIS_NAMESPACE as string,
    internalAuthSecret: raw.INTERNAL_AUTH_SECRET as string,
    eventSigningSecret,
    eventSigningKeys,
    allowUnsignedEvents:
      (raw.EVENTS_ALLOW_UNSIGNED as boolean | undefined) ??
      (nodeEnv === 'development' || nodeEnv === 'test'),
    databaseUrl: raw.DATABASE_URL as string | undefined,
    databasePoolMax: (raw.DATABASE_POOL_MAX as number | undefined) ?? 10,
    databaseStatementTimeoutMs: (raw.DATABASE_STATEMENT_TIMEOUT_MS as number | undefined) ?? 15_000,
    otlpEndpoint: raw.OTEL_EXPORTER_OTLP_ENDPOINT as string | undefined,
    swaggerEnabled: (raw.SWAGGER_ENABLED as boolean | undefined) ?? nodeEnv !== 'production',
    bodyLimit: raw.BODY_LIMIT as string,
    shutdownGraceMs: raw.SHUTDOWN_GRACE_MS as number,
    publicAppUrl: (raw.PUBLIC_APP_URL as string).replace(/\/$/, ''),
    serviceUrls: {
      'identity-service': raw.IDENTITY_SERVICE_URL as string | undefined,
      'learning-service': raw.LEARNING_SERVICE_URL as string | undefined,
      'media-service': raw.MEDIA_SERVICE_URL as string | undefined,
      'assessment-service': raw.ASSESSMENT_SERVICE_URL as string | undefined,
      'ai-coaching-service': raw.AI_SERVICE_URL as string | undefined,
      'certification-service': raw.CERTIFICATION_SERVICE_URL as string | undefined,
      'notification-service': raw.NOTIFICATION_SERVICE_URL as string | undefined,
      'analytics-service': raw.ANALYTICS_SERVICE_URL as string | undefined,
      'audit-service': raw.AUDIT_SERVICE_URL as string | undefined,
    },
    env: raw as z.infer<S>,
  };
}

export function runsWorkers(config: Pick<ServiceRuntimeConfig, 'role'>): boolean {
  return config.role === 'worker' || config.role === 'all';
}
