import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { PRINCIPAL_HEADER, signPrincipalToken } from '@a5/auth';
import { AppError } from '@a5/nest-kit';
import { getContext, patchContext } from '@a5/observability';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config.js';
import { Authenticator } from './authenticator.js';

/**
 * Authenticates requests to the gateway's own BFF endpoints and converts the bearer token into
 * the same internal principal header services receive, so the shared AuthGuard applies.
 */
@Injectable()
export class BffAuthMiddleware implements NestMiddleware {
  constructor(
    private readonly authenticator: Authenticator,
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    delete req.headers[PRINCIPAL_HEADER];
    try {
      const principal = await this.authenticator.authenticate(req.header('authorization'));
      patchContext({ userId: principal.userId, organizationId: principal.organizationId });
      req.headers[PRINCIPAL_HEADER] = await signPrincipalToken(
        principal,
        this.config.internalAuthSecret,
        60,
      );
      next();
    } catch (err) {
      if (err instanceof AppError) {
        res.status(err.status).json({
          error: { code: err.code, message: err.message, requestId: getContext()?.requestId },
        });
        return;
      }
      next(err);
    }
  }
}
