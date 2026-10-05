import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Response } from 'express';
import { getContext, type Logger } from '@a5/observability';
import { AppError } from './errors.js';
import { LOGGER } from './tokens.js';
import { ResponseContractError } from './validation.js';
import type { A5Request } from './types.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Array<{ path: string; message: string }>;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

const HTTP_CODES: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'The request could not be understood.' },
  401: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' },
  403: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' },
  404: { code: 'NOT_FOUND', message: 'The requested resource does not exist.' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'This operation is not supported.' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'The content type is not supported.' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests. Wait a moment and try again.' },
};

/** Normalizes every error into `{ error: { code, message, fields?, details?, requestId } }`. */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<A5Request>();
    const requestId = getContext()?.requestId ?? req.requestId;
    const { status, body } = this.toBody(exception);
    body.error.requestId = requestId;

    if (status >= 500) {
      this.logger.error({ err: exception, status, path: req.path }, 'request failed');
    } else if (status !== 404 && status !== 401) {
      this.logger.info({ status, code: body.error.code, path: req.path }, 'request rejected');
    }
    if (exception instanceof AppError && exception.status === 429 && exception.details?.retryAfterSeconds) {
      res.setHeader('Retry-After', String(exception.details.retryAfterSeconds));
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json(body);
  }

  private toBody(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            ...(exception.fields && { fields: exception.fields }),
            ...(exception.details && { details: exception.details }),
          },
        },
      };
    }
    if (exception instanceof ResponseContractError) {
      return { status: 500, body: { error: { code: 'INTERNAL', message: 'The server produced an invalid response. The issue has been logged.' } } };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const cause = (exception as { cause?: { type?: string } }).cause;
      if (status === 400 && (cause?.type === 'entity.parse.failed' || /JSON/i.test(exception.message))) {
        return { status, body: { error: { code: 'MALFORMED_JSON', message: 'The request body is not valid JSON.' } } };
      }
      const known = HTTP_CODES[status] ?? { code: 'HTTP_ERROR', message: exception.message };
      return { status, body: { error: { ...known } } };
    }
    const typed = exception as { type?: string; status?: number };
    if (typed?.type === 'entity.too.large') return { status: 413, body: { error: HTTP_CODES[413]! } };
    if (typed?.type === 'entity.parse.failed') {
      return { status: 400, body: { error: { code: 'MALFORMED_JSON', message: 'The request body is not valid JSON.' } } };
    }
    return {
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'An unexpected error occurred. The issue has been logged; retry or contact support with the request id.' } },
    };
  }
}
