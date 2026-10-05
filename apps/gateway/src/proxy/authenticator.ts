import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import {
  SERVICE_TOKEN_HEADER,
  TokenError,
  importAccessKeys,
  signServiceToken,
  verifyAccessToken,
  type PrincipalData,
} from '@a5/auth';
import { InjectRedis, ServiceUnavailableError, UnauthenticatedError } from '@a5/nest-kit';
import { RedisNamespace, type Redis } from '@a5/messaging';
import { getContext } from '@a5/observability';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config.js';

interface CachedPrincipal {
  epoch: number;
  data: PrincipalData;
}

/** Key layout owned by identity-service (see identity-service/src/common/iam-keys.ts). */
const keys = (ns: RedisNamespace) => ({
  session: (sid: string) => ns.key('iam', 'sess', sid),
  epoch: (org: string) => ns.key('iam', 'epoch', org),
  principal: (userId: string) => ns.key('iam', 'principal', userId),
});

/**
 * Turns a bearer access token into a principal:
 * 1. verify the Ed25519 signature locally (no network);
 * 2. one Redis MGET for session liveness, the organization epoch and the cached principal;
 * 3. on miss or stale epoch, ask identity-service (which also re-validates the session).
 * Permissions are never read from the token, so revocations apply on the next request.
 */
@Injectable()
export class Authenticator implements OnModuleInit {
  private publicKey: Awaited<ReturnType<typeof importAccessKeys>>['publicKey'] | null = null;
  private readonly k: ReturnType<typeof keys>;

  constructor(
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    @InjectRedis() private readonly redis: Redis,
    @Inject(RedisNamespace) ns: RedisNamespace,
  ) {
    this.k = keys(ns);
  }

  async onModuleInit() {
    this.publicKey = (await importAccessKeys(undefined, this.config.gateway.publicKeyPem)).publicKey;
  }

  async authenticate(authorization: string | undefined): Promise<PrincipalData> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
    if (!token) throw new UnauthenticatedError('UNAUTHENTICATED', 'Sign in to continue.');
    let claims;
    try {
      claims = await verifyAccessToken(token, this.publicKey!);
    } catch (err) {
      if (err instanceof TokenError && err.code === 'expired') {
        throw new UnauthenticatedError('SESSION_EXPIRED', 'Your session expired. Sign in again.');
      }
      throw new UnauthenticatedError('TOKEN_INVALID', 'Your sign-in could not be verified. Sign in again.');
    }

    let session: string | null | undefined;
    let epochRaw: string | null | undefined;
    let cachedRaw: string | null | undefined;
    try {
      [session, epochRaw, cachedRaw] = await this.redis.mget(
        this.k.session(claims.sid),
        this.k.epoch(claims.org),
        this.k.principal(claims.sub),
      );
    } catch {
      throw new ServiceUnavailableError('Authentication is temporarily unavailable. Retry in a moment.');
    }

    if (session && cachedRaw) {
      const cached = JSON.parse(cachedRaw) as CachedPrincipal;
      if (cached.epoch === Number(epochRaw ?? 0) && cached.data.organizationId === claims.org) {
        return { ...cached.data, sessionId: claims.sid };
      }
    }

    const resolved = await this.fetchPrincipal(claims.sub, session ? null : claims.sid);
    if (!resolved.sessionActive) throw new UnauthenticatedError('SESSION_REVOKED', 'You were signed out. Sign in again.');
    if (!resolved.principal || resolved.principal.organizationId !== claims.org) {
      throw new UnauthenticatedError('ACCOUNT_DISABLED', 'Your account is not active. Contact your administrator.');
    }
    return { ...resolved.principal, sessionId: claims.sid };
  }

  private async fetchPrincipal(
    userId: string,
    sessionId: string | null,
  ): Promise<{ principal: PrincipalData | null; sessionActive: boolean }> {
    const base = this.config.serviceUrls['identity-service'];
    if (!base) throw new ServiceUnavailableError('Identity service is not configured.');
    const url = new URL(`/internal/principals/${userId}`, base);
    if (sessionId) url.searchParams.set('sessionId', sessionId);
    const ctx = getContext();
    try {
      const res = await fetch(url, {
        headers: {
          [SERVICE_TOKEN_HEADER]: await signServiceToken('gateway', this.config.internalAuthSecret),
          ...(ctx && { 'x-request-id': ctx.requestId }),
        },
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) throw new Error(`identity responded ${res.status}`);
      return (await res.json()) as { principal: PrincipalData | null; sessionActive: boolean };
    } catch {
      throw new ServiceUnavailableError('Sign-in could not be verified right now. Retry in a moment.');
    }
  }
}
