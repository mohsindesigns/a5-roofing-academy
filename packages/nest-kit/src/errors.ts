import type { FieldError } from './types.js';

/**
 * Application errors carry an HTTP status, a stable machine code and a message written for the
 * person who will read it in the UI. Never use generic "Something went wrong" messages.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly fields?: FieldError[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, details?: Record<string, unknown>) {
    super(404, 'NOT_FOUND', `${resource} was not found or you do not have access to it.`, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to perform this action.',
    details?: Record<string, unknown>,
  ) {
    super(403, 'FORBIDDEN', message, details);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(code = 'UNAUTHENTICATED', message = 'Sign in to continue.') {
    super(401, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(409, code, message, details);
  }
}

export class PreconditionError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(422, code, message, details);
  }
}

export class ValidationError extends AppError {
  constructor(fields: FieldError[], message = 'Some fields need attention.') {
    super(400, 'VALIDATION_FAILED', message, undefined, fields);
  }
}

export class RateLimitedError extends AppError {
  constructor(
    readonly retryAfterSeconds: number,
    message = 'Too many requests. Wait a moment and try again.',
  ) {
    super(429, 'RATE_LIMITED', message, { retryAfterSeconds });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(
    message = 'A required service is temporarily unavailable. Retry in a moment.',
    details?: Record<string, unknown>,
  ) {
    super(503, 'SERVICE_UNAVAILABLE', message, details);
  }
}
