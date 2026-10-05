import { Controller, Get, HttpCode, Injectable, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from './auth.js';

export type HealthCheck = () => Promise<void>;

/** Services register dependency checks (database, redis, storage) for readiness. */
@Injectable()
export class HealthRegistry {
  private readonly checks = new Map<string, HealthCheck>();
  private shuttingDown = false;

  register(name: string, check: HealthCheck): void {
    this.checks.set(name, check);
  }

  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  async run(timeoutMs = 2_000): Promise<{ ok: boolean; checks: Record<string, { ok: boolean; error?: string; ms: number }> }> {
    const results: Record<string, { ok: boolean; error?: string; ms: number }> = {};
    await Promise.all(
      [...this.checks].map(async ([name, check]) => {
        const started = Date.now();
        try {
          await Promise.race([
            check(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
          ]);
          results[name] = { ok: true, ms: Date.now() - started };
        } catch (err) {
          results[name] = { ok: false, error: (err as Error).message, ms: Date.now() - started };
        }
      }),
    );
    const ok = !this.shuttingDown && Object.values(results).every((r) => r.ok);
    return { ok, checks: results };
  }
}

@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(private readonly registry: HealthRegistry) {}

  @Public()
  @Get('live')
  @HttpCode(200)
  live() {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(@Res() res: Response) {
    const result = await this.registry.run();
    res.status(result.ok ? 200 : 503).json({ status: result.ok ? 'ok' : 'unavailable', checks: result.checks });
  }
}
