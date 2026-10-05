import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@a5/nest-kit';
import type { ObjectStorage } from '@a5/storage';
import { CLOCK, OBJECT_STORAGE, URL_SIGNER, type Clock } from '../common/tokens.js';
import { HLS_FILE, HLS_PLAYLIST_FILE, mediaKeys } from '../storage/keys.js';
import type { UrlSigner } from '../storage/url-signer.js';
import { MediaTokenError, MediaTokens, type HlsTokenClaims } from './media-tokens.js';

export interface PlaylistUriMappers {
  /** Rewrites a reference to another playlist (master → variant). */
  playlist(name: string): string | Promise<string>;
  /** Rewrites a reference to a stored object (segment, init segment, key). */
  object(name: string): string | Promise<string>;
}

/**
 * Rewrite every URI of an HLS playlist: URI lines and `URI="..."` attributes (EXT-X-MEDIA,
 * EXT-X-I-FRAME-STREAM-INF, EXT-X-MAP, EXT-X-KEY). Playlists we generated only reference flat
 * file names; anything else is refused rather than passed through.
 */
export async function rewritePlaylist(text: string, map: PlaylistUriMappers): Promise<string> {
  const lines = text.split(/\r?\n/);
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  const rewrite = async (uri: string): Promise<string> => {
    if (!HLS_FILE.test(uri)) throw new Error(`Unexpected URI "${uri}" in HLS playlist`);
    return isMaster && HLS_PLAYLIST_FILE.test(uri) ? map.playlist(uri) : map.object(uri);
  };
  const out = await Promise.all(
    lines.map(async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        const attr = /URI="([^"]*)"/.exec(trimmed);
        return attr ? trimmed.replace(attr[0], `URI="${await rewrite(attr[1]!)}"`) : line;
      }
      return rewrite(trimmed);
    }),
  );
  return out.join('\n');
}

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 256;

function isMissing(err: unknown): boolean {
  const e = err as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.code === 'ENOENT' || e?.code === 'NoSuchKey' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Serves master and variant playlists (small text files) after verifying the playback token; every
 * segment is individually signed for storage/CDN so video bytes never pass through this service.
 */
@Injectable()
export class HlsService {
  /** Raw playlists are immutable once an asset is ready; cache them per process. */
  private readonly cache = new Map<string, { text: string; expires: number }>();

  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(URL_SIGNER) private readonly signer: UrlSigner,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tokens: MediaTokens,
  ) {}

  verify(token: string | undefined, assetId: string): HlsTokenClaims {
    let claims: HlsTokenClaims;
    try {
      claims = this.tokens.verify(token ?? '', 'hls');
    } catch (err) {
      if (err instanceof MediaTokenError && err.reason === 'expired') {
        throw new UnauthenticatedError('PLAYBACK_EXPIRED', 'This playback link expired. Reload the lesson to continue watching.');
      }
      throw new UnauthenticatedError('PLAYBACK_TOKEN_INVALID', 'This playback link is not valid. Reload the lesson to continue watching.');
    }
    if (claims.aid !== assetId) throw new ForbiddenError('This playback link belongs to a different video.');
    return claims;
  }

  async playlist(assetId: string, file: string, token: string | undefined): Promise<string> {
    const claims = this.verify(token, assetId);
    if (!HLS_PLAYLIST_FILE.test(file)) throw new NotFoundError('Playlist');
    const text = await this.load(mediaKeys.hls(claims.org, assetId, file));
    if (text === null) throw new NotFoundError('Playlist');
    // Segment URLs stay valid exactly as long as the token that authorized this playlist.
    const expiresInSeconds = Math.max(1, claims.exp - Math.floor(this.clock.now() / 1000));
    return rewritePlaylist(text, {
      playlist: (name) => `${name}?token=${encodeURIComponent(token!)}`,
      object: (name) => this.signer.sign(mediaKeys.hls(claims.org, assetId, name), { expiresInSeconds }),
    });
  }

  private async load(key: string): Promise<string | null> {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.text;
    let text: string;
    try {
      text = (await this.storage.getBytes(key)).toString('utf8');
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    this.cache.delete(key);
    this.cache.set(key, { text, expires: now + CACHE_TTL_MS });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return text;
  }
}
