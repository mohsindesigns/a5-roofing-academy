import { createHmac } from 'node:crypto';
import type { ObjectStorage } from '@a5/storage';
import type { Clock } from '../common/tokens.js';

export interface SignedGetOptions {
  expiresInSeconds: number;
  /** Force a download with this file name. */
  downloadName?: string;
  contentType?: string;
}

/**
 * Produces time-limited GET URLs for stored objects (HLS segments, posters, captions, documents).
 * Implementations decide where bytes are served from; video bytes never stream through the API
 * except via the development-only local driver route.
 */
export interface UrlSigner {
  readonly kind: 'storage' | 'cdn';
  sign(key: string, options: SignedGetOptions): Promise<string>;
}

/** Signs URLs with the storage driver itself (S3 presigned GET, or the local dev route). */
export class StorageUrlSigner implements UrlSigner {
  readonly kind = 'storage' as const;

  constructor(private readonly storage: ObjectStorage) {}

  sign(key: string, options: SignedGetOptions): Promise<string> {
    return this.storage.signedGetUrl(key, options);
  }
}

/**
 * Signed CDN URLs using a shared HMAC secret ("token authentication"):
 *
 *   {CDN_BASE_URL}/{key}?expires={unix}[&download={name}]&signature={sig}
 *   sig = base64url(HMAC-SHA256(secret, "{path}\n{expires}\n{download}"))
 *
 * where `path` is the URL path below the CDN base (`/media/...`). The edge function (CloudFront
 * Function, Cloudflare Worker, Fastly VCL, …) recomputes the signature, rejects expired or forged
 * URLs and fetches from the private bucket with origin credentials.
 */
export class HmacCdnUrlSigner implements UrlSigner {
  readonly kind = 'cdn' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly clock: Clock,
  ) {}

  static signature(secret: string, path: string, expires: number, downloadName = ''): string {
    return createHmac('sha256', secret).update(`${path}\n${expires}\n${downloadName}`).digest('base64url');
  }

  async sign(key: string, options: SignedGetOptions): Promise<string> {
    const expires = Math.floor(this.clock.now() / 1000) + options.expiresInSeconds;
    const path = `/${key.split('/').map(encodeURIComponent).join('/')}`;
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('expires', String(expires));
    if (options.downloadName) url.searchParams.set('download', options.downloadName);
    url.searchParams.set('signature', HmacCdnUrlSigner.signature(this.secret, path, expires, options.downloadName));
    return url.toString();
  }
}
