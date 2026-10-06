import { assertProductionSafe, env, z } from '@a5/config';
import { loadServiceConfig } from '@a5/nest-kit';

const analyticsEnv = z.object({
  /** IANA time zone used to bucket facts into calendar days (rollups, date filters). */
  REPORTING_TIMEZONE: z
    .string()
    .default('America/Chicago')
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'must be a valid IANA time zone'),
  DASHBOARD_CACHE_TTL_SECONDS: env.int(60),
  /** How often dirty rollup days are recomputed. */
  ROLLUP_INTERVAL_MINUTES: env.int(15),
  /** Trailing window rebuilt nightly so directory moves (team/location changes) are reflected. */
  ROLLUP_FULL_REFRESH_DAYS: env.int(400),
  EXPORT_RETENTION_HOURS: env.int(72),
  EXPORT_LINK_TTL_SECONDS: env.int(300),
  EXPORT_MAX_ROWS: env.int(100_000),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./storage/analytics'),
  STORAGE_SIGNING_SECRET: z.string().optional(),
  /** Base URL of the signed local file route as reached by browsers (through the gateway). */
  REPORT_FILES_PUBLIC_URL: z.url().optional(),
  S3_BUCKET: z.string().default('a5-academy'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.url().optional(),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
});

export function loadAnalyticsConfig(source?: Record<string, string | undefined>) {
  const config = loadServiceConfig('analytics-service', 4080, analyticsEnv, { source });
  const e = config.env;
  if (
    e.STORAGE_DRIVER === 'local' &&
    (!e.STORAGE_SIGNING_SECRET || e.STORAGE_SIGNING_SECRET.length < 32)
  ) {
    throw new Error(
      'Invalid configuration:\n  - STORAGE_SIGNING_SECRET: required (at least 32 characters) for the local storage driver. Run `pnpm keys:generate`.',
    );
  }
  assertProductionSafe(config.nodeEnv, [[e.STORAGE_DRIVER === 's3', 'STORAGE_DRIVER must be s3']]);
  const positive = (value: number, name: string) => {
    if (value <= 0)
      throw new Error(`Invalid configuration:\n  - ${name}: must be greater than zero`);
    return value;
  };
  return {
    ...config,
    analytics: {
      timezone: e.REPORTING_TIMEZONE,
      dashboardCacheTtlSeconds: positive(
        e.DASHBOARD_CACHE_TTL_SECONDS,
        'DASHBOARD_CACHE_TTL_SECONDS',
      ),
      rollupIntervalMinutes: positive(e.ROLLUP_INTERVAL_MINUTES, 'ROLLUP_INTERVAL_MINUTES'),
      rollupFullRefreshDays: positive(e.ROLLUP_FULL_REFRESH_DAYS, 'ROLLUP_FULL_REFRESH_DAYS'),
    },
    exports: {
      retentionHours: positive(e.EXPORT_RETENTION_HOURS, 'EXPORT_RETENTION_HOURS'),
      linkTtlSeconds: positive(e.EXPORT_LINK_TTL_SECONDS, 'EXPORT_LINK_TTL_SECONDS'),
      maxRows: positive(e.EXPORT_MAX_ROWS, 'EXPORT_MAX_ROWS'),
    },
    storage: {
      driver: e.STORAGE_DRIVER,
      localRoot: e.STORAGE_LOCAL_ROOT,
      signingSecret: e.STORAGE_SIGNING_SECRET ?? '',
      publicBaseUrl: (
        e.REPORT_FILES_PUBLIC_URL ?? `${config.publicAppUrl}/api/v1/reports/files`
      ).replace(/\/$/, ''),
      s3: {
        bucket: e.S3_BUCKET,
        region: e.S3_REGION,
        endpoint: e.S3_ENDPOINT,
        publicEndpoint: e.S3_PUBLIC_ENDPOINT,
        accessKeyId: e.S3_ACCESS_KEY_ID,
        secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      },
    },
  };
}

export type AnalyticsConfig = ReturnType<typeof loadAnalyticsConfig>;
export const ANALYTICS_CONFIG = Symbol('ANALYTICS_CONFIG');
