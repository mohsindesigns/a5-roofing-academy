import { randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { Get, Inject, Put, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiController, AppError, LOGGER, Public } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { LocalDiskStorage, type ObjectStorage } from '@a5/storage';
import { CLOCK, OBJECT_STORAGE, type Clock } from '../common/tokens.js';

class UploadTooLargeError extends Error {}

function param(req: Request, name: string): string | null {
  const value = req.query[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function forbidden(): AppError {
  return new AppError(403, 'SIGNATURE_INVALID', 'This link is invalid or has expired. Request a new one and try again.');
}

/** Parse a single `bytes=start-end` range. Returns null when absent, 'invalid' when unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (match[1] === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(match[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

/**
 * Development-only delivery for the local storage driver: accepts signed PUT uploads and serves
 * signed GETs (with HTTP Range for video). With the S3 driver this controller is not registered;
 * browsers upload to and download from the bucket/CDN directly.
 */
@Public()
@ApiExcludeController()
@ApiController('media/dev-storage', 'media')
export class DevStorageController {
  private readonly storage: LocalDiskStorage;

  constructor(
    @Inject(OBJECT_STORAGE) storage: ObjectStorage,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    if (!(storage instanceof LocalDiskStorage)) throw new Error('DevStorageController requires the local storage driver');
    this.storage = storage;
  }

  @Put('upload')
  async upload(@Req() req: Request, @Res() res: Response): Promise<void> {
    const key = param(req, 'key');
    const expires = Number(param(req, 'expires'));
    const max = Number(param(req, 'max'));
    const type = param(req, 'type');
    const sig = param(req, 'sig');
    if (!key || !type || !sig || !Number.isSafeInteger(max) || max <= 0) throw forbidden();
    if (!this.storage.verify(key, expires, sig, `PUT ${type} ${max}`)) throw forbidden();

    const contentType = (req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (contentType !== type) {
      throw new AppError(415, 'CONTENT_TYPE_MISMATCH', `Upload the file with the content type ${type}.`);
    }
    const declared = req.header('content-length');
    if (declared !== undefined && Number(declared) > max) {
      throw new AppError(413, 'FILE_TOO_LARGE', `The file is larger than the allowed ${formatBytes(max)}.`);
    }

    // Write to a temporary key and move it into place only once the whole body arrived within the
    // limit, so a partial or oversized upload never becomes visible under the real key.
    const partialKey = `${key}.uploading-${randomBytes(6).toString('hex')}`;
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > max) callback(new UploadTooLargeError());
        else callback(null, chunk);
      },
    });
    // The limiter can fail before storage attaches its pipeline; keep the first error from the start.
    let streamError: Error | null = null;
    limiter.on('error', (err) => {
      streamError ??= err;
    });
    req.once('error', (err) => limiter.destroy(err));
    req.once('close', () => {
      if (!req.complete) limiter.destroy(new Error('Upload aborted by the client'));
    });
    req.pipe(limiter);

    try {
      await this.storage.putObject(partialKey, limiter, { contentType: type });
      if (streamError) throw streamError;
      if (received === 0) throw new AppError(400, 'EMPTY_UPLOAD', 'The file is empty. Choose a file and try again.');
      await this.storage.copyObject(partialKey, key);
    } catch (caught) {
      const err = streamError ?? caught;
      req.unpipe(limiter);
      if (!req.complete) req.resume();
      if (err instanceof UploadTooLargeError) {
        throw new AppError(413, 'FILE_TOO_LARGE', `The file is larger than the allowed ${formatBytes(max)}.`);
      }
      if (err instanceof AppError) throw err;
      this.logger.warn({ err }, 'development upload failed');
      throw new AppError(400, 'UPLOAD_INCOMPLETE', 'The upload did not finish. Check your connection and try again.');
    } finally {
      await this.storage.deleteObject(partialKey).catch(() => undefined);
    }
    res.status(204).end();
  }

  @Get('object')
  async object(@Req() req: Request, @Res() res: Response): Promise<void> {
    const key = param(req, 'key');
    const expires = Number(param(req, 'expires'));
    const sig = param(req, 'sig');
    const download = param(req, 'download');
    if (!key || !sig) throw forbidden();
    if (!this.storage.verify(key, expires, sig, download ?? '')) throw forbidden();
    const head = await this.storage.headObject(key);
    if (!head) throw new AppError(404, 'NOT_FOUND', 'The file was not found.');

    const range = parseRange(req.header('range'), head.size);
    if (range === 'invalid') {
      res.status(416).setHeader('Content-Range', `bytes */${head.size}`).end();
      return;
    }
    const remaining = Math.max(0, expires - Math.floor(this.clock.now() / 1000));
    res.setHeader('Content-Type', head.contentType ?? 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', `private, max-age=${Math.min(remaining, 3600)}`);
    if (head.etag) res.setHeader('ETag', `"${head.etag}"`);
    if (download) res.setHeader('Content-Disposition', `attachment; filename="${download.replace(/["\\\r\n]/g, '')}"`);
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${head.size}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
    } else {
      res.status(200);
      res.setHeader('Content-Length', String(head.size));
    }
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = this.storage.readStream(key, range ?? undefined);
    stream.on('error', (err) => {
      this.logger.warn({ err }, 'development object stream failed');
      res.destroy(err);
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 ** 2) * 10) / 10} MB`;
  return `${Math.round((bytes / 1024) * 10) / 10} KB`;
}
