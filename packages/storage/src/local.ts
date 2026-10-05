import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile, open } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ObjectHead, ObjectStorage, SignedUrlOptions, UploadTarget } from './types.js';

export interface LocalDiskStorageOptions {
  root: string;
  /** Base URL of the service route that serves/accepts local objects (development only). */
  publicBaseUrl: string;
  signingSecret: string;
}

/**
 * Development/test storage on the local file system. Signed URLs point at a development-only route
 * of the owning service, which verifies the HMAC signature. Never use in production.
 */
export class LocalDiskStorage implements ObjectStorage {
  readonly driver = 'local' as const;

  constructor(private readonly options: LocalDiskStorageOptions) {}

  private path(key: string): string {
    const resolved = normalize(join(this.options.root, key));
    if (!resolved.startsWith(normalize(this.options.root) + sep)) throw new Error('Invalid object key');
    return resolved;
  }

  private metaPath(key: string): string {
    return `${this.path(key)}.meta.json`;
  }

  async putObject(key: string, body: Buffer | Readable, options: { contentType: string }) {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    if (Buffer.isBuffer(body)) await writeFile(file, body);
    else await pipeline(body, createWriteStream(file));
    await writeFile(this.metaPath(key), JSON.stringify({ contentType: options.contentType }));
  }

  async getObject(key: string) {
    const head = await this.headObject(key);
    if (!head) throw Object.assign(new Error('Object not found'), { code: 'NoSuchKey' });
    return { body: createReadStream(this.path(key)), contentType: head.contentType, size: head.size };
  }

  /** Stream an object or an inclusive byte range of it (development delivery route, HTTP Range). */
  readStream(key: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.path(key), range ? { start: range.start, end: range.end } : {});
  }

  async getBytes(key: string, range?: { start: number; end: number }) {
    if (!range) return readFile(this.path(key));
    const handle = await open(this.path(key), 'r');
    try {
      const length = range.end - range.start + 1;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, range.start);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const s = await stat(this.path(key));
      let contentType: string | null = null;
      try {
        contentType = (JSON.parse(await readFile(this.metaPath(key), 'utf8')) as { contentType?: string }).contentType ?? null;
      } catch {
        contentType = null;
      }
      return { size: s.size, contentType, etag: `${s.size}-${s.mtimeMs}` };
    } catch {
      return null;
    }
  }

  async deleteObject(key: string) {
    await rm(this.path(key), { force: true });
    await rm(this.metaPath(key), { force: true });
  }

  async deletePrefix(prefix: string) {
    await rm(this.path(prefix), { recursive: true, force: true });
    return 0;
  }

  async copyObject(sourceKey: string, targetKey: string) {
    await mkdir(dirname(this.path(targetKey)), { recursive: true });
    await copyFile(this.path(sourceKey), this.path(targetKey));
    try {
      await copyFile(this.metaPath(sourceKey), this.metaPath(targetKey));
    } catch {
      // metadata is optional
    }
  }

  sign(key: string, expires: number, extra = ''): string {
    return createHmac('sha256', this.options.signingSecret).update(`${key}\n${expires}\n${extra}`).digest('base64url');
  }

  verify(key: string, expires: number, signature: string, extra = ''): boolean {
    if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
    const expected = Buffer.from(this.sign(key, expires, extra));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async createUploadTarget(
    key: string,
    options: { contentType: string; maxBytes: number; expiresInSeconds: number },
  ): Promise<UploadTarget> {
    const expires = Math.floor(Date.now() / 1000) + options.expiresInSeconds;
    const extra = `PUT ${options.contentType} ${options.maxBytes}`;
    const url = new URL(`${this.options.publicBaseUrl}/upload`);
    url.searchParams.set('key', key);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('max', String(options.maxBytes));
    url.searchParams.set('type', options.contentType);
    url.searchParams.set('sig', this.sign(key, expires, extra));
    return {
      method: 'PUT',
      url: url.toString(),
      fields: {},
      headers: { 'content-type': options.contentType },
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  async signedGetUrl(key: string, options: SignedUrlOptions) {
    const expires = Math.floor(Date.now() / 1000) + options.expiresInSeconds;
    const url = new URL(`${this.options.publicBaseUrl}/object`);
    url.searchParams.set('key', key);
    url.searchParams.set('expires', String(expires));
    if (options.downloadName) url.searchParams.set('download', options.downloadName);
    url.searchParams.set('sig', this.sign(key, expires, options.downloadName ?? ''));
    return url.toString();
  }

  async ping() {
    await mkdir(this.options.root, { recursive: true });
  }
}

export { Readable };
