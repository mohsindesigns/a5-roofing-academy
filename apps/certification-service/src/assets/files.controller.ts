import { Get, Res } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AppError, ApiController, NotFoundError, Public, ZQuery } from '@a5/nest-kit';
import { LocalDiskStorage, type ObjectStorage } from '@a5/storage';
import { InjectStorage } from '../common/storage.js';

const signedQuerySchema = z.object({
  key: z.string().min(1).max(400),
  expires: z.coerce.number().int().positive(),
  sig: z.string().min(16).max(200),
  download: z.string().max(200).optional(),
});

/**
 * Serves objects for the local storage driver through HMAC-signed, short-lived URLs (the same
 * contract S3 presigned URLs give in production). Disabled when the S3 driver is configured.
 */
@ApiController('certification-files')
export class FilesController {
  constructor(@InjectStorage() private readonly storage: ObjectStorage) {}

  @Get('object')
  @Public()
  @ApiExcludeEndpoint()
  async object(@ZQuery(signedQuerySchema) q: z.infer<typeof signedQuerySchema>, @Res() res: Response) {
    const storage = this.storage;
    if (!(storage instanceof LocalDiskStorage)) throw new NotFoundError('File');
    if (!storage.verify(q.key, q.expires, q.sig, q.download ?? '')) {
      throw new AppError(403, 'LINK_EXPIRED', 'This link has expired or is invalid. Request a new link and try again.');
    }
    let object: Awaited<ReturnType<ObjectStorage['getObject']>>;
    try {
      object = await storage.getObject(q.key);
    } catch {
      throw new NotFoundError('File');
    }
    const fileName = q.download?.replace(/[^A-Za-z0-9._ -]/g, '_');
    res.setHeader('Content-Type', object.contentType ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(object.size));
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', fileName ? `attachment; filename="${fileName}"` : 'inline');
    object.body.on('error', () => res.destroy());
    object.body.pipe(res);
  }
}
