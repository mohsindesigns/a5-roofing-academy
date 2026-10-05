import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { runWithContext, uuidv7, type Logger } from '@a5/observability';
import { LOGGER } from './tokens.js';
import type { A5Request } from './types.js';

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Establishes the async request context (request id, correlation id) and writes one access log
 * line per request with route, status and duration.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  use(req: A5Request, res: Response, next: NextFunction): void {
    const incoming = req.header('x-request-id');
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : uuidv7();
    const correlation = req.header('x-correlation-id');
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    const started = process.hrtime.bigint();
    const ctx = {
      requestId,
      correlationId: correlation && REQUEST_ID.test(correlation) ? correlation : requestId,
      ip: (req.header('x-forwarded-for')?.split(',')[0]?.trim() || req.ip) ?? null,
      userAgent: req.header('user-agent') ?? null,
    };
    res.on('finish', () => {
      if (req.originalUrl.startsWith('/health')) return;
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      this.logger[level](
        {
          requestId,
          method: req.method,
          route: (req.route as { path?: string } | undefined)?.path ?? req.path,
          status: res.statusCode,
          durationMs: Math.round(durationMs * 10) / 10,
          userId: req.principal?.userId,
          caller: req.serviceCaller,
        },
        'request completed',
      );
    });
    runWithContext(ctx, () => next());
  }
}
