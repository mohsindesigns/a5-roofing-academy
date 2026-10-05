import { assertProductionSafe, env, z } from '@a5/config';
import { loadServiceConfig } from '@a5/nest-kit';

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const notificationEnv = z.object({
  /** SMTP connection, e.g. `smtp://127.0.0.1:1025` (Mailpit) or `smtps://user:pass@smtp.example.com`. */
  SMTP_URL: z.url().optional(),
  /** `smtp` sends through SMTP_URL; `console` writes messages to the log (development only). */
  EMAIL_TRANSPORT: z.enum(['smtp', 'console']).optional(),
  EMAIL_FROM: z.string().min(3).default('A5 Roofing Sales Academy <academy@a5roofing.example>'),
  EMAIL_REPLY_TO: z.string().min(3).optional(),
  EMAIL_MAX_ATTEMPTS: env.int(6),
  /** Base delay of the exponential retry backoff. */
  EMAIL_BACKOFF_MS: env.int(30_000),
  EMAIL_CONCURRENCY: env.int(5),
  /** Key for sealing security email content until it is delivered. Defaults to a key derived from INTERNAL_AUTH_SECRET. */
  NOTIFICATION_SEAL_KEY: env.secret(32).optional(),
  /** Time zone used to format dates in notifications. */
  NOTIFICATION_TIMEZONE: z.string().default('America/Chicago').refine(isTimeZone, 'must be an IANA time zone such as America/Chicago'),
  /** Read notifications and delivery logs older than this are deleted. */
  NOTIFICATION_RETENTION_DAYS: env.int(730),
  SSE_HEARTBEAT_MS: env.int(25_000),
  SSE_MAX_CONNECTIONS_PER_USER: env.int(10),
  MAINTENANCE_INTERVAL_MS: env.int(60_000),
});

export function loadNotificationConfig(source?: Record<string, string | undefined>) {
  const config = loadServiceConfig('notification-service', 4070, notificationEnv, { source });
  const e = config.env;
  const transport = e.EMAIL_TRANSPORT ?? (e.SMTP_URL ? 'smtp' : 'console');
  if (transport === 'smtp' && !e.SMTP_URL) {
    throw new Error('Invalid configuration:\n  - SMTP_URL is required when EMAIL_TRANSPORT=smtp.');
  }
  assertProductionSafe(config.nodeEnv, [[transport === 'smtp', 'EMAIL_TRANSPORT must be smtp (set SMTP_URL)']]);
  return {
    ...config,
    email: {
      transport,
      smtpUrl: e.SMTP_URL,
      from: e.EMAIL_FROM,
      replyTo: e.EMAIL_REPLY_TO ?? null,
      maxAttempts: Math.max(1, e.EMAIL_MAX_ATTEMPTS),
      backoffMs: Math.max(1, e.EMAIL_BACKOFF_MS),
      concurrency: Math.max(1, e.EMAIL_CONCURRENCY),
    },
    sealKey: e.NOTIFICATION_SEAL_KEY ?? config.internalAuthSecret,
    timezone: e.NOTIFICATION_TIMEZONE,
    retentionDays: Math.max(30, e.NOTIFICATION_RETENTION_DAYS),
    sse: {
      heartbeatMs: Math.max(50, e.SSE_HEARTBEAT_MS),
      maxConnectionsPerUser: Math.max(1, e.SSE_MAX_CONNECTIONS_PER_USER),
    },
    maintenanceIntervalMs: Math.max(1_000, e.MAINTENANCE_INTERVAL_MS),
  };
}

export type NotificationConfig = ReturnType<typeof loadNotificationConfig>;
export const NOTIFICATION_CONFIG = Symbol('NOTIFICATION_CONFIG');
