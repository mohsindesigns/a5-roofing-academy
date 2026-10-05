import type { LoggerService } from '@nestjs/common';
import type { Logger } from '@a5/observability';

/** Routes Nest framework logs through pino. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  private meta(optional: unknown[]): Record<string, unknown> {
    const context = optional.find((o) => typeof o === 'string');
    return context ? { context } : {};
  }

  log(message: unknown, ...optional: unknown[]) {
    this.logger.info(this.meta(optional), String(message));
  }
  error(message: unknown, ...optional: unknown[]) {
    const stack = optional.find((o) => typeof o === 'string' && o.includes('\n'));
    this.logger.error({ ...this.meta(optional), stack }, String(message));
  }
  warn(message: unknown, ...optional: unknown[]) {
    this.logger.warn(this.meta(optional), String(message));
  }
  debug(message: unknown, ...optional: unknown[]) {
    this.logger.debug(this.meta(optional), String(message));
  }
  verbose(message: unknown, ...optional: unknown[]) {
    this.logger.trace(this.meta(optional), String(message));
  }
  fatal(message: unknown, ...optional: unknown[]) {
    this.logger.fatal(this.meta(optional), String(message));
  }
}
