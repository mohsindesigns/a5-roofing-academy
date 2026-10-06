import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Producer } from '@a5/events';
import { Public } from '@a5/nest-kit';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config.js';

interface OpenApiDoc {
  paths?: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
  tags?: Array<{ name: string }>;
}

/** Operational endpoints: aggregated OpenAPI document and downstream health. */
@ApiExcludeController()
@Controller()
export class PlatformController {
  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  private services(): Array<[Producer, string]> {
    return Object.entries(this.config.serviceUrls).filter((e): e is [Producer, string] =>
      Boolean(e[1]),
    );
  }

  @Public()
  @Get('api/v1/openapi.json')
  async openapi() {
    const merged = {
      openapi: '3.0.0',
      info: {
        title: 'A5 Roofing Sales Academy API',
        version: '1',
        description: 'Public API exposed through the gateway.',
      },
      servers: [{ url: '/' }],
      paths: {} as Record<string, unknown>,
      components: {
        schemas: {} as Record<string, unknown>,
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
      security: [{ bearer: [] }],
      tags: [] as Array<{ name: string }>,
    };
    await Promise.all(
      this.services().map(async ([, url]) => {
        try {
          const res = await fetch(new URL('/docs/json', url), {
            signal: AbortSignal.timeout(3_000),
          });
          if (!res.ok) return;
          const doc = (await res.json()) as OpenApiDoc;
          Object.assign(merged.paths, doc.paths ?? {});
          Object.assign(merged.components.schemas, doc.components?.schemas ?? {});
          merged.tags.push(...(doc.tags ?? []));
        } catch {
          // A service without docs (production) simply contributes nothing.
        }
      }),
    );
    return merged;
  }

  @Public()
  @Get('health/services')
  async services_(@Res() res: Response) {
    const results = await Promise.all(
      this.services().map(async ([name, url]) => {
        const started = Date.now();
        try {
          const r = await fetch(new URL('/health/ready', url), {
            signal: AbortSignal.timeout(2_000),
          });
          return { service: name, ok: r.ok, status: r.status, ms: Date.now() - started };
        } catch (err) {
          return {
            service: name,
            ok: false,
            status: 0,
            ms: Date.now() - started,
            error: (err as Error).message,
          };
        }
      }),
    );
    const ok = results.every((r) => r.ok);
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', services: results });
  }
}
