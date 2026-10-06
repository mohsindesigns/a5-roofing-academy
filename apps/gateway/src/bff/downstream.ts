import { Inject, Injectable } from '@nestjs/common';
import { PRINCIPAL_HEADER } from '@a5/auth';
import type { Producer } from '@a5/events';
import { AppError, LOGGER } from '@a5/nest-kit';
import { getContext, type Logger } from '@a5/observability';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config.js';

export type Section<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

/**
 * Calls services on behalf of the current user (forwarding the internal principal) for BFF
 * aggregation. Each section fails independently so one slow service never blanks a dashboard.
 */
@Injectable()
export class Downstream {
  constructor(
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async get<T>(
    service: Producer,
    path: string,
    principalToken: string,
    timeoutMs = 4_000,
  ): Promise<T> {
    const base = this.config.serviceUrls[service];
    if (!base) throw new AppError(503, 'SERVICE_UNAVAILABLE', `${service} is not configured.`);
    const ctx = getContext();
    const res = await fetch(new URL(path, base), {
      headers: {
        [PRINCIPAL_HEADER]: principalToken,
        ...(ctx && { 'x-request-id': ctx.requestId, 'x-correlation-id': ctx.correlationId }),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as {
      error?: { code: string; message: string };
    } | null;
    if (!res.ok)
      throw new AppError(
        res.status,
        body?.error?.code ?? 'UPSTREAM_ERROR',
        body?.error?.message ?? `${service} responded ${res.status}`,
      );
    return body as T;
  }

  async section<T>(service: Producer, path: string, principalToken: string): Promise<Section<T>> {
    try {
      return { ok: true, data: await this.get<T>(service, path, principalToken) };
    } catch (err) {
      const e = err instanceof AppError ? err : null;
      if (!e || e.status >= 500) this.logger.warn({ err, service, path }, 'BFF section failed');
      return {
        ok: false,
        error: {
          code: e?.code ?? 'SERVICE_UNAVAILABLE',
          message: e && e.status < 500 ? e.message : 'This section is temporarily unavailable.',
        },
      };
    }
  }
}
