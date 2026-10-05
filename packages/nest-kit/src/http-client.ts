import { Inject, Injectable } from '@nestjs/common';
import { SERVICE_TOKEN_HEADER, signServiceToken } from '@a5/auth';
import type { Producer } from '@a5/events';
import { getContext } from '@a5/observability';
import type { z } from 'zod';
import { AppError, ServiceUnavailableError } from './errors.js';
import { SERVICE_CONFIG } from './tokens.js';
import type { ServiceRuntimeConfig } from './config.js';

export interface InternalRequest<S extends z.ZodType | undefined> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null | string[]>;
  timeoutMs?: number;
  schema?: S;
  /** Retries for idempotent GETs on network errors and 502/503/504. */
  retries?: number;
}

/** Service-to-service HTTP for `/internal/*` endpoints, authenticated with a service token. */
@Injectable()
export class InternalHttpClient {
  constructor(@Inject(SERVICE_CONFIG) private readonly config: ServiceRuntimeConfig) {}

  async request<S extends z.ZodType | undefined = undefined>(
    service: Producer,
    path: string,
    req: InternalRequest<S> = {},
  ): Promise<S extends z.ZodType ? z.infer<S> : unknown> {
    const base = this.config.serviceUrls[service];
    if (!base) throw new ServiceUnavailableError(`${service} is not configured.`);
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    const method = req.method ?? 'GET';
    const retries = method === 'GET' ? (req.retries ?? 2) : 0;
    const ctx = getContext();
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers: {
            'content-type': 'application/json',
            [SERVICE_TOKEN_HEADER]: await signServiceToken(this.config.serviceName, this.config.internalAuthSecret),
            ...(ctx && { 'x-request-id': ctx.requestId, 'x-correlation-id': ctx.correlationId }),
          },
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          signal: AbortSignal.timeout(req.timeoutMs ?? 5_000),
        });
        if ([502, 503, 504].includes(res.status) && attempt < retries) {
          lastError = new Error(`HTTP ${res.status}`);
          await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
          continue;
        }
        const text = await res.text();
        const json = text ? (JSON.parse(text) as unknown) : null;
        if (!res.ok) {
          const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
          throw new AppError(res.status, err?.code ?? 'UPSTREAM_ERROR', err?.message ?? `${service} responded ${res.status}`);
        }
        return (req.schema ? req.schema.parse(json) : json) as S extends z.ZodType ? z.infer<S> : unknown;
      } catch (err) {
        if (err instanceof AppError) throw err;
        lastError = err;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      }
    }
    throw new ServiceUnavailableError(undefined, { service, cause: String(lastError) });
  }
}
