import { Delete, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Principal } from '@a5/auth';
import { identity, okSchema } from '@a5/contracts';
import {
  ApiController,
  AppError,
  CurrentPrincipal,
  OptionalPrincipal,
  Public,
  UnauthenticatedError,
  ZBody,
  ZParam,
  ZResponse,
} from '@a5/nest-kit';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config.js';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { clearSessionCookies, csrfValid, readRefreshCookie, setSessionCookies } from './cookies.js';

const meSchema = z.object({
  user: identity.sessionUserSchema,
  permissions: z.record(z.string(), z.enum(['own', 'managed', 'organization', 'platform'])),
  featureFlags: z.record(z.string(), z.boolean()),
  managedTeamIds: z.array(z.uuid()),
});

@ApiController('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ZResponse(identity.loginResponseSchema)
  async login(
    @ZBody(identity.loginRequestSchema) body: identity.LoginRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const issued = await this.auth.login(body.email, body.password);
    setSessionCookies(res, this.config, issued.refreshToken, issued.refreshExpiresAt);
    return issued.response;
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ZResponse(identity.loginResponseSchema)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = readRefreshCookie(req);
    if (!token) throw new UnauthenticatedError('UNAUTHENTICATED', 'Sign in to continue.');
    if (!csrfValid(req)) throw new AppError(403, 'CSRF_FAILED', 'Your session could not be verified. Reload the page and sign in again.');
    try {
      const issued = await this.auth.refresh(token);
      setSessionCookies(res, this.config, issued.refreshToken, issued.refreshExpiresAt);
      return issued.response;
    } catch (err) {
      clearSessionCookies(res, this.config);
      throw err;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @ZResponse(okSchema)
  async logout(
    @OptionalPrincipal() principal: Principal | null,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    let sessionId = principal?.sessionId ?? null;
    if (!sessionId) {
      const token = readRefreshCookie(req);
      if (token && csrfValid(req)) sessionId = await this.auth.sessionIdForRefreshToken(token);
    }
    if (sessionId) await this.auth.logoutSession(sessionId);
    clearSessionCookies(res, this.config);
    return { ok: true as const };
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  @ZResponse(okSchema)
  async forgot(@ZBody(identity.forgotPasswordRequestSchema) body: { email: string }) {
    await this.auth.forgotPassword(body.email);
    return { ok: true as const };
  }

  @Public()
  @Get('tokens/:token')
  @ZResponse(identity.tokenInfoSchema)
  tokenInfo(@ZParam('token', z.string().min(16).max(200)) token: string) {
    return this.auth.tokenInfo(token);
  }

  @Public()
  @Post('password/reset')
  @HttpCode(200)
  @ZResponse(okSchema)
  async reset(@ZBody(identity.resetPasswordRequestSchema) body: { token: string; password: string }) {
    await this.auth.resetPassword(body.token, body.password);
    return { ok: true as const };
  }

  @Public()
  @Post('activate')
  @HttpCode(200)
  @ZResponse(identity.loginResponseSchema)
  async activate(
    @ZBody(identity.activateAccountRequestSchema) body: { token: string; password: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const issued = await this.auth.activate(body.token, body.password);
    setSessionCookies(res, this.config, issued.refreshToken, issued.refreshExpiresAt);
    return issued.response;
  }

  @Post('password/change')
  @HttpCode(200)
  @ZResponse(okSchema)
  async changePassword(
    @CurrentPrincipal() p: Principal,
    @ZBody(identity.changePasswordRequestSchema) body: identity.ChangePasswordRequest,
  ) {
    await this.auth.changePassword(p, body.currentPassword, body.newPassword);
    return { ok: true as const };
  }

  @Get('me')
  @ZResponse(meSchema)
  me(@CurrentPrincipal() p: Principal) {
    return this.auth.me(p);
  }

  @Get('sessions')
  @ZResponse(z.object({ items: z.array(identity.sessionSchema) }))
  async sessions(@CurrentPrincipal() p: Principal) {
    return { items: await this.users.sessions(p, p.userId) };
  }

  @Delete('sessions/:id')
  @ZResponse(okSchema)
  async revokeSession(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    await this.users.revokeSessions(p, p.userId, id);
    return { ok: true as const };
  }

  @Get('login-history')
  @ZResponse(z.object({ items: z.array(identity.loginHistoryEntrySchema) }))
  async loginHistory(@CurrentPrincipal() p: Principal) {
    return { items: await this.users.loginHistory(p, p.userId) };
  }
}
