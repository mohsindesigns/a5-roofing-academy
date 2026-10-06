import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { NextFunction, Request, Response } from 'express';
import {
  PRINCIPAL_HEADER,
  SERVICE_TOKEN_HEADER,
  signPrincipalToken,
  type PrincipalData,
} from '@a5/auth';
import type { Producer } from '@a5/events';
import { AppError, LOGGER, RateLimitedError, ServiceUnavailableError } from '@a5/nest-kit';
import { RateLimiter } from '@a5/messaging';
import { getContext, patchContext, type Logger } from '@a5/observability';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config.js';
import { Authenticator } from './authenticator.js';
import { matchRoute, type RouteRule } from './routes.js';

/** Hop-by-hop and internal headers that must never be forwarded from the client. */
const STRIP_REQUEST = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'authorization',
  PRINCIPAL_HEADER,
  SERVICE_TOKEN_HEADER,
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-request-id',
  'x-correlation-id',
]);

const STRIP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'x-powered-by',
  'server',
]);

const agents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 512, keepAliveMsecs: 10_000 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 512, keepAliveMsecs: 10_000 }),
};

export type ProxiedRequest = Request & { principal?: PrincipalData };

function writeError(res: Response, err: AppError): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof RateLimitedError) res.setHeader('Retry-After', String(err.retryAfterSeconds));
  res.status(err.status).json({
    error: {
      code: err.code,
      message: err.message,
      ...(err.details && { details: err.details }),
      requestId: getContext()?.requestId,
    },
  });
}

/**
 * Edge pipeline for every /api/v1 route owned by a downstream service:
 * route match → rate limit → authenticate → mint internal principal → stream to the service.
 * Bodies are streamed, never buffered, and capped by size.
 */
@Injectable()
export class ProxyMiddleware implements NestMiddleware {
  constructor(
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    private readonly authenticator: Authenticator,
    private readonly limiter: RateLimiter,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async use(req: ProxiedRequest, res: Response, next: NextFunction): Promise<void> {
    const path = req.originalUrl.split('?')[0]!;
    const rule = matchRoute(path, req.method);
    if (!rule) return next();

    try {
      const principal = await this.authenticate(req, rule);
      await this.rateLimit(req, rule, principal);
      this.assertBodySize(req, rule);
      const target = this.config.serviceUrls[rule.service];
      if (!target) throw new ServiceUnavailableError(`${rule.service} is not configured.`);
      const headers = await this.upstreamHeaders(req, principal);
      this.forward(req, res, rule, target, headers);
    } catch (err) {
      if (err instanceof AppError) return writeError(res, err);
      this.logger.error({ err, path }, 'gateway pipeline failed');
      writeError(
        res,
        new AppError(
          500,
          'INTERNAL',
          'An unexpected error occurred. Retry or contact support with the request id.',
        ),
      );
    }
  }

  private async authenticate(req: ProxiedRequest, rule: RouteRule): Promise<PrincipalData | null> {
    const authorization = req.header('authorization');
    if (rule.access === 'public') return null;
    if (rule.access === 'optional') {
      if (!authorization) return null;
      try {
        return await this.authenticator.authenticate(authorization);
      } catch {
        return null;
      }
    }
    const principal = await this.authenticator.authenticate(authorization);
    req.principal = principal;
    patchContext({ userId: principal.userId, organizationId: principal.organizationId });
    return principal;
  }

  private async rateLimit(
    req: Request,
    rule: RouteRule,
    principal: PrincipalData | null,
  ): Promise<void> {
    const limits = this.config.gateway.rateLimits;
    const limit = limits[rule.rate];
    // Authenticated traffic is limited per user, anonymous traffic per client IP.
    const subject =
      rule.rate === 'default' && principal ? `u:${principal.userId}` : `ip:${req.ip ?? 'unknown'}`;
    let result;
    try {
      result = await this.limiter.hit(rule.rate, subject, limit, 60);
    } catch {
      // Rate limiting must not take the API down if Redis blips; authentication already needs Redis.
      return;
    }
    if (!result.allowed) throw new RateLimitedError(result.resetSeconds);
  }

  private assertBodySize(req: Request, rule: RouteRule): void {
    const max = rule.upload
      ? this.config.gateway.maxUploadBodyBytes
      : this.config.gateway.maxBodyBytes;
    const length = Number(req.header('content-length') ?? 0);
    if (length > max) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request is too large.');
  }

  private async upstreamHeaders(
    req: Request,
    principal: PrincipalData | null,
  ): Promise<IncomingHttpHeaders> {
    const headers: IncomingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!STRIP_REQUEST.has(key.toLowerCase())) headers[key] = value;
    }
    const ctx = getContext();
    if (ctx) {
      headers['x-request-id'] = ctx.requestId;
      headers['x-correlation-id'] = ctx.correlationId;
    }
    headers['x-forwarded-for'] = req.ip ?? '';
    headers['x-forwarded-proto'] = req.protocol;
    if (principal)
      headers[PRINCIPAL_HEADER] = await signPrincipalToken(
        principal,
        this.config.internalAuthSecret,
        60,
      );
    return headers;
  }

  private forward(
    req: Request,
    res: Response,
    rule: RouteRule,
    target: string,
    headers: IncomingHttpHeaders,
  ): void {
    const url = new URL(req.originalUrl, target);
    const isHttps = url.protocol === 'https:';
    const started = Date.now();
    const max = rule.upload
      ? this.config.gateway.maxUploadBodyBytes
      : this.config.gateway.maxBodyBytes;

    const upstream = (isHttps ? https : http).request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        agent: isHttps ? agents.https : agents.http,
        timeout: rule.stream ? 0 : this.config.gateway.upstreamTimeoutMs,
      },
      (upRes) => {
        const out: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(upRes.headers)) {
          if (value !== undefined && !STRIP_RESPONSE.has(key)) out[key] = value;
        }
        if (String(upRes.headers['content-type'] ?? '').startsWith('text/event-stream')) {
          out['cache-control'] = 'no-cache, no-transform';
          out['x-accel-buffering'] = 'no';
          res.socket?.setTimeout(0);
        }
        res.writeHead(upRes.statusCode ?? 502, out);
        upRes.pipe(res);
        upRes.on('end', () => {
          if (Date.now() - started > 2_000 && !rule.stream) {
            this.logger.warn(
              { service: rule.service, path: url.pathname, ms: Date.now() - started },
              'slow upstream',
            );
          }
        });
      },
    );

    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (err) => {
      const service = rule.service as Producer;
      this.logger.error({ err, service, path: url.pathname }, 'upstream request failed');
      const timeout = err.message === 'upstream timeout';
      writeError(
        res,
        timeout
          ? new AppError(504, 'UPSTREAM_TIMEOUT', 'The request took too long. Retry in a moment.', {
              service,
            })
          : new ServiceUnavailableError(undefined, { service }),
      );
    });
    // Client went away: stop the upstream work (important for SSE and AI streams).
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });

    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > max) {
        upstream.destroy();
        writeError(res, new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request is too large.'));
        req.unpipe(upstream);
      }
    });
    req.pipe(upstream);
  }
}
