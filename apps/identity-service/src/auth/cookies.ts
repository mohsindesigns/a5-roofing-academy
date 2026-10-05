import type { Request, Response } from 'express';
import { randomToken } from '@a5/observability';
import type { IdentityConfig } from '../config.js';

export const REFRESH_COOKIE = 'a5_rt';
export const CSRF_COOKIE = 'a5_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const REFRESH_PATH = '/api/v1/auth';

/**
 * Refresh token: HttpOnly, SameSite=Strict, scoped to the auth path.
 * CSRF token: readable by the SPA, echoed in `X-CSRF-Token` (double submit) on cookie-auth calls.
 */
export function setSessionCookies(res: Response, config: IdentityConfig, refreshToken: string, expiresAt: Date): void {
  const base = {
    secure: config.auth.cookieSecure,
    sameSite: 'strict' as const,
    domain: config.auth.cookieDomain,
    expires: expiresAt,
  };
  res.cookie(REFRESH_COOKIE, refreshToken, { ...base, httpOnly: true, path: REFRESH_PATH });
  res.cookie(CSRF_COOKIE, randomToken(24), { ...base, httpOnly: false, path: '/' });
}

export function clearSessionCookies(res: Response, config: IdentityConfig): void {
  const base = { secure: config.auth.cookieSecure, sameSite: 'strict' as const, domain: config.auth.cookieDomain };
  res.clearCookie(REFRESH_COOKIE, { ...base, httpOnly: true, path: REFRESH_PATH });
  res.clearCookie(CSRF_COOKIE, { ...base, path: '/' });
}

export function readRefreshCookie(req: Request): string | null {
  const value = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 20 ? value : null;
}

/** Double-submit check: header must equal the CSRF cookie. */
export function csrfValid(req: Request): boolean {
  const cookie = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
  const header = req.header(CSRF_HEADER);
  return Boolean(cookie && header && cookie.length >= 16 && cookie === header);
}
