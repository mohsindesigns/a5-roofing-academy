import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ConfigError, assertProductionSafe, env, loadEnv, z } from '@a5/config';
import type { MediaKind } from '@a5/contracts/media';
import { loadServiceConfig } from '@a5/nest-kit';

const megabytes = (fallback: number) => z.coerce.number().int().min(1).max(1_048_576).default(fallback);
const seconds = (fallback: number, min = 1, max = 7 * 24 * 3600) => z.coerce.number().int().min(min).max(max).default(fallback);

/** Object storage settings (shared by the service and the seed CLI). */
const storageEnv = z.object({
  PUBLIC_APP_URL: z.url().default('http://localhost:5173'),
  /** Public origin of the API gateway when it differs from the web app origin. */
  PUBLIC_API_URL: z.url().optional(),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().min(1).default('./storage'),
  STORAGE_SIGNING_SECRET: env.secret(32).optional(),
  S3_BUCKET: z.string().min(3).optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_ENDPOINT: z.url().optional(),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: env.boolean(),
});

const mediaEnv = storageEnv.extend({
  /** Optional CDN in front of the bucket; segment, poster, caption and document URLs are signed for it. */
  CDN_BASE_URL: z.url().optional(),
  CDN_SIGNING_SECRET: env.secret(32).optional(),
  MEDIA_MAX_VIDEO_MB: megabytes(2048),
  MEDIA_MAX_DOCUMENT_MB: megabytes(50),
  MEDIA_MAX_IMAGE_MB: megabytes(10),
  MEDIA_MAX_CAPTION_MB: megabytes(2),
  MEDIA_UPLOAD_URL_TTL_SECONDS: seconds(3600, 60, 24 * 3600),
  MEDIA_SIGNED_URL_TTL_SECONDS: seconds(900, 30, 24 * 3600),
  MEDIA_PLAYBACK_TTL_SECONDS: seconds(7200, 60, 12 * 3600),
  MEDIA_HEARTBEAT_INTERVAL_SECONDS: seconds(15, 5, 300),
  MEDIA_TELEMETRY_TOLERANCE_SECONDS: z.coerce.number().min(0).max(30).default(2),
  MEDIA_PROGRESS_FLUSH_INTERVAL_SECONDS: seconds(30, 5, 3600),
  MEDIA_PROCESS_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  MEDIA_TRANSCODE_TIMEOUT_SECONDS: seconds(3 * 3600, 30, 24 * 3600),
  MEDIA_WORK_DIR: z.string().min(1).optional(),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  /** `clamav` (clamd INSTREAM) or `none`. Defaults to clamav in staging/production. */
  MALWARE_SCANNER: z.enum(['clamav', 'none']).optional(),
  CLAMAV_HOST: z.string().min(1).optional(),
  CLAMAV_PORT: env.port(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  /** Secret learning-service signs lesson grants with. Defaults to INTERNAL_AUTH_SECRET. */
  LESSON_GRANT_SECRET: env.secret(32).optional(),
  /** Secret for playback/HLS tokens. Defaults to a key derived from INTERNAL_AUTH_SECRET. */
  PLAYBACK_SIGNING_SECRET: env.secret(32).optional(),
});

export type StorageConfig =
  | { driver: 'local'; root: string; signingSecret: string; publicBaseUrl: string }
  | {
      driver: 's3';
      bucket: string;
      region: string;
      endpoint?: string;
      publicEndpoint?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      forcePathStyle?: boolean;
    };

export type ScannerConfig = { kind: 'clamav'; host: string; port: number; timeoutMs: number } | { kind: 'none' };

const MB = 1024 * 1024;

type StorageEnv = z.infer<typeof storageEnv>;

function publicApiBase(e: StorageEnv): string {
  return (e.PUBLIC_API_URL ?? e.PUBLIC_APP_URL).replace(/\/$/, '');
}

function storageConfig(e: StorageEnv, issues: string[], signingSecretFallback?: string): StorageConfig {
  if (e.STORAGE_DRIVER === 'local') {
    const signingSecret = e.STORAGE_SIGNING_SECRET ?? signingSecretFallback;
    if (!signingSecret) issues.push('STORAGE_SIGNING_SECRET is required when STORAGE_DRIVER=local (run `pnpm keys:generate`)');
    return {
      driver: 'local',
      root: resolve(process.cwd(), e.STORAGE_LOCAL_ROOT),
      signingSecret: signingSecret ?? '',
      publicBaseUrl: `${publicApiBase(e)}/api/v1/media/dev-storage`,
    };
  }
  if (!e.S3_BUCKET) issues.push('S3_BUCKET is required when STORAGE_DRIVER=s3');
  if (!e.S3_REGION) issues.push('S3_REGION is required when STORAGE_DRIVER=s3');
  if (Boolean(e.S3_ACCESS_KEY_ID) !== Boolean(e.S3_SECRET_ACCESS_KEY)) {
    issues.push('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together (or both omitted to use the default AWS credential chain)');
  }
  return {
    driver: 's3',
    bucket: e.S3_BUCKET ?? '',
    region: e.S3_REGION ?? '',
    endpoint: e.S3_ENDPOINT,
    publicEndpoint: e.S3_PUBLIC_ENDPOINT,
    accessKeyId: e.S3_ACCESS_KEY_ID,
    secretAccessKey: e.S3_SECRET_ACCESS_KEY,
    forcePathStyle: e.S3_FORCE_PATH_STYLE,
  };
}

function fail(issues: string[]): never {
  throw new ConfigError(
    `Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    issues.map((message) => ({ key: 'media', message })),
  );
}

/** HKDF-style key separation: a derived key never equals the secret it came from. */
function deriveSecret(secret: string, purpose: string): string {
  return createHmac('sha256', secret).update(`a5-media:${purpose}:v1`).digest('base64url');
}

export function loadMediaConfig(source?: Record<string, string | undefined>) {
  const config = loadServiceConfig('media-service', 4030, mediaEnv, { source });
  const e = config.env;
  const issues: string[] = [];

  const storage = storageConfig(e, issues);
  if (e.CDN_BASE_URL && !e.CDN_SIGNING_SECRET) issues.push('CDN_SIGNING_SECRET is required when CDN_BASE_URL is set');
  const production = config.nodeEnv === 'production' || config.nodeEnv === 'staging';
  const scannerKind = e.MALWARE_SCANNER ?? (production ? 'clamav' : 'none');
  if (scannerKind === 'clamav' && !e.CLAMAV_HOST) issues.push('CLAMAV_HOST is required when MALWARE_SCANNER=clamav');
  if (issues.length) fail(issues);

  assertProductionSafe(config.nodeEnv, [
    [storage.driver === 's3', 'STORAGE_DRIVER must be s3 (the local driver and its delivery routes are for development only)'],
    [scannerKind === 'clamav', 'MALWARE_SCANNER must be clamav'],
  ]);

  const scanner: ScannerConfig =
    scannerKind === 'clamav'
      ? { kind: 'clamav', host: e.CLAMAV_HOST!, port: e.CLAMAV_PORT, timeoutMs: e.CLAMAV_TIMEOUT_MS }
      : { kind: 'none' };

  const limits: Record<MediaKind, number> = {
    video: e.MEDIA_MAX_VIDEO_MB * MB,
    document: e.MEDIA_MAX_DOCUMENT_MB * MB,
    image: e.MEDIA_MAX_IMAGE_MB * MB,
    caption: e.MEDIA_MAX_CAPTION_MB * MB,
  };

  return {
    ...config,
    media: {
      publicApiBaseUrl: publicApiBase(e),
      storage,
      cdn: e.CDN_BASE_URL ? { baseUrl: e.CDN_BASE_URL.replace(/\/$/, ''), signingSecret: e.CDN_SIGNING_SECRET! } : null,
      limits,
      uploadUrlTtlSeconds: e.MEDIA_UPLOAD_URL_TTL_SECONDS,
      signedUrlTtlSeconds: e.MEDIA_SIGNED_URL_TTL_SECONDS,
      playbackTtlSeconds: e.MEDIA_PLAYBACK_TTL_SECONDS,
      heartbeatIntervalSeconds: e.MEDIA_HEARTBEAT_INTERVAL_SECONDS,
      telemetryToleranceSeconds: e.MEDIA_TELEMETRY_TOLERANCE_SECONDS,
      progressFlushIntervalSeconds: e.MEDIA_PROGRESS_FLUSH_INTERVAL_SECONDS,
      processing: {
        concurrency: e.MEDIA_PROCESS_CONCURRENCY,
        timeoutSeconds: e.MEDIA_TRANSCODE_TIMEOUT_SECONDS,
        workDir: e.MEDIA_WORK_DIR ? resolve(process.cwd(), e.MEDIA_WORK_DIR) : tmpdir(),
        ffmpegPath: e.FFMPEG_PATH,
        ffprobePath: e.FFPROBE_PATH,
      },
      scanner,
      lessonGrantSecret: e.LESSON_GRANT_SECRET ?? config.internalAuthSecret,
      playbackSecret: e.PLAYBACK_SIGNING_SECRET ?? deriveSecret(config.internalAuthSecret, 'playback'),
    },
  };
}

export type MediaConfig = ReturnType<typeof loadMediaConfig>;
export type MediaSettings = MediaConfig['media'];
export const MEDIA_CONFIG = Symbol('MEDIA_CONFIG');

/**
 * Storage configuration for offline tools (seed). The seed writes objects directly and never signs
 * URLs, so the local driver does not need STORAGE_SIGNING_SECRET there.
 */
export function loadStorageConfigForTools(source: Record<string, string | undefined> = process.env): StorageConfig {
  const e = loadEnv(storageEnv, source);
  const issues: string[] = [];
  const storage = storageConfig(e, issues, deriveSecret(`offline-${Date.now()}-${Math.random()}`, 'unused'));
  if (issues.length) fail(issues);
  return storage;
}
