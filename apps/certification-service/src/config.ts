import { resolve } from 'node:path';
import { ConfigError, assertProductionSafe, env, z } from '@a5/config';
import { loadServiceConfig } from '@a5/nest-kit';

const certificationEnv = z.object({
  /** `local` keeps files on disk (development, tests); `s3` works with S3, MinIO or R2. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./storage'),
  /** HMAC secret for local signed URLs. Required for the local driver. */
  STORAGE_SIGNING_SECRET: env.secret(32).optional(),
  /** Public base URL of the signed-file route (local driver). Defaults to the gateway path on PUBLIC_APP_URL. */
  CERTIFICATION_FILES_URL: z.url().optional(),
  S3_BUCKET: z.string().default('a5-academy'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.url().optional(),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: env.boolean(),
  /** Lifetime of signed PDF download links. */
  CERT_DOWNLOAD_URL_TTL_SECONDS: env.int(300),
  /** Lifetime of signed preview and image links for administrators. */
  CERT_PREVIEW_URL_TTL_SECONDS: env.int(900),
  /** Daily expiry + renewal-window run (cron, UTC). */
  CERT_LIFECYCLE_CRON: z.string().default('17 6 * * *'),
  /** Daily expiry reminder run (cron, UTC). */
  CERT_REMINDERS_CRON: z.string().default('27 6 * * *'),
  /** Interval of the in-process sweeper (pending eligibility evaluations, stuck PDFs). */
  CERT_SWEEP_INTERVAL_MS: env.int(30_000),
  /** Certificates whose PDF is still pending after this long are re-enqueued. */
  CERT_PDF_STUCK_AFTER_SECONDS: env.int(120),
  CERT_PDF_CONCURRENCY: env.int(3),
  /** Wait for a concurrent issuance of the same person and certification before giving up. */
  CERT_ISSUE_LOCK_WAIT_MS: env.int(15_000),
});

export function loadCertificationConfig(source?: Record<string, string | undefined>) {
  const config = loadServiceConfig('certification-service', 4060, certificationEnv, { source });
  const e = config.env;
  if (e.STORAGE_DRIVER === 'local' && !e.STORAGE_SIGNING_SECRET) {
    throw new ConfigError('Invalid configuration:\n  - STORAGE_SIGNING_SECRET: required when STORAGE_DRIVER=local. Run `pnpm keys:generate`.', [
      { key: 'STORAGE_SIGNING_SECRET', message: 'required when STORAGE_DRIVER=local' },
    ]);
  }
  assertProductionSafe(config.nodeEnv, [[e.STORAGE_DRIVER === 's3', 'STORAGE_DRIVER must be s3 (local disk storage is for development only)']]);
  return {
    ...config,
    storage: {
      driver: e.STORAGE_DRIVER,
      localRoot: resolve(e.STORAGE_LOCAL_ROOT),
      signingSecret: e.STORAGE_SIGNING_SECRET ?? '',
      filesBaseUrl: (e.CERTIFICATION_FILES_URL ?? `${config.publicAppUrl}/api/v1/certification-files`).replace(/\/$/, ''),
      s3: {
        bucket: e.S3_BUCKET,
        region: e.S3_REGION,
        endpoint: e.S3_ENDPOINT,
        publicEndpoint: e.S3_PUBLIC_ENDPOINT,
        accessKeyId: e.S3_ACCESS_KEY_ID,
        secretAccessKey: e.S3_SECRET_ACCESS_KEY,
        forcePathStyle: e.S3_FORCE_PATH_STYLE,
      },
    },
    certification: {
      downloadUrlTtlSeconds: e.CERT_DOWNLOAD_URL_TTL_SECONDS,
      previewUrlTtlSeconds: e.CERT_PREVIEW_URL_TTL_SECONDS,
      lifecycleCron: e.CERT_LIFECYCLE_CRON,
      remindersCron: e.CERT_REMINDERS_CRON,
      sweepIntervalMs: e.CERT_SWEEP_INTERVAL_MS,
      pdfStuckAfterSeconds: e.CERT_PDF_STUCK_AFTER_SECONDS,
      pdfConcurrency: e.CERT_PDF_CONCURRENCY,
      issueLockWaitMs: e.CERT_ISSUE_LOCK_WAIT_MS,
    },
  };
}

export type CertificationConfig = ReturnType<typeof loadCertificationConfig>;
export const CERTIFICATION_CONFIG = Symbol('CERTIFICATION_CONFIG');
