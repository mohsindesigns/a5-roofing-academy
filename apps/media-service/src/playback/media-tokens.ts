import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PlaybackPolicy } from '@a5/contracts/media';
import { CLOCK, type Clock } from '../common/tokens.js';
import { MEDIA_CONFIG, type MediaConfig } from '../config.js';

/** Authorizes fetching the HLS playlists of one asset. Travels in URLs, so it grants nothing else. */
export interface HlsTokenClaims {
  typ: 'hls';
  /** Asset id. */
  aid: string;
  org: string;
  /** Viewer (learner or previewing administrator). */
  sub: string;
  iat: number;
  exp: number;
}

/** Authorizes watch telemetry for one learner, asset and learning context. */
export interface PlaybackTokenClaims {
  typ: 'play';
  sub: string;
  org: string;
  aid: string;
  /** Learning context the progress is credited to (`lesson` + lesson id). */
  ct: string;
  ci: string;
  /** Asset duration in seconds at issue time. */
  dur: number;
  pol: PlaybackPolicy;
  iat: number;
  exp: number;
}

type Claims = HlsTokenClaims | PlaybackTokenClaims;
type Unsigned<T extends Claims> = Omit<T, 'iat' | 'exp'>;

export class MediaTokenError extends Error {
  constructor(readonly reason: 'invalid' | 'expired') {
    super(reason === 'expired' ? 'Token expired' : 'Token invalid');
    this.name = 'MediaTokenError';
  }
}

const VERSION = 'v1';

/**
 * Compact HMAC-SHA256 tokens (`v1.<payload>.<signature>`, base64url) for playback. Purpose-typed so a
 * token minted for one use (HLS URLs) can never be replayed for another (telemetry), and short-lived.
 */
@Injectable()
export class MediaTokens {
  private readonly secret: string;

  constructor(
    @Inject(MEDIA_CONFIG) config: MediaConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.secret = config.media.playbackSecret;
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.secret).update(`${VERSION}.${payload}`).digest('base64url');
  }

  sign<T extends Claims>(
    claims: Unsigned<T>,
    ttlSeconds: number,
  ): { token: string; expiresAt: Date; claims: T } {
    const iat = Math.floor(this.clock.now() / 1000);
    const full = { ...claims, iat, exp: iat + ttlSeconds } as T;
    const payload = Buffer.from(JSON.stringify(full)).toString('base64url');
    return {
      token: `${VERSION}.${payload}.${this.mac(payload)}`,
      expiresAt: new Date(full.exp * 1000),
      claims: full,
    };
  }

  verify<K extends Claims['typ']>(token: string, typ: K): Extract<Claims, { typ: K }> {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== VERSION) throw new MediaTokenError('invalid');
    const [, payload, signature] = parts as [string, string, string];
    const expected = Buffer.from(this.mac(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new MediaTokenError('invalid');
    let claims: Claims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
    } catch {
      throw new MediaTokenError('invalid');
    }
    if (claims.typ !== typ || typeof claims.exp !== 'number') throw new MediaTokenError('invalid');
    if (claims.exp <= Math.floor(this.clock.now() / 1000)) throw new MediaTokenError('expired');
    return claims as Extract<Claims, { typ: K }>;
  }
}
