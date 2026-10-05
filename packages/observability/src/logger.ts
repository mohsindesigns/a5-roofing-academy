import { pino, type Logger, type LoggerOptions } from 'pino';
import { trace } from '@opentelemetry/api';
import { getContext } from './context.js';

export type { Logger } from 'pino';

/** Paths that must never reach log storage. */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'newPassword',
  '*.newPassword',
  'token',
  '*.token',
  'refreshToken',
  '*.refreshToken',
  'accessToken',
  '*.accessToken',
  'secret',
  '*.secret',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-a5-principal"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
];

export interface LoggerConfig {
  service: string;
  level?: LoggerOptions['level'];
  pretty?: boolean;
}

export function createLogger({ service, level = 'info', pretty = false }: LoggerConfig): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: { level: (label) => ({ level: label }) },
    mixin() {
      const ctx = getContext();
      const span = trace.getActiveSpan()?.spanContext();
      return {
        ...(ctx && {
          requestId: ctx.requestId,
          correlationId: ctx.correlationId !== ctx.requestId ? ctx.correlationId : undefined,
          userId: ctx.userId ?? undefined,
        }),
        ...(span && { traceId: span.traceId, spanId: span.spanId }),
      };
    },
    ...(pretty && {
      transport: { target: 'pino/file', options: { destination: 1 } },
    }),
  });
}
