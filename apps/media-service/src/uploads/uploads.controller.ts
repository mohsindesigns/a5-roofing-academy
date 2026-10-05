import { HttpCode, Post } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { media } from '@a5/contracts';
import { ApiController, CurrentPrincipal, RequirePermissions, ZBody, ZParam, ZResponse } from '@a5/nest-kit';
import { UploadsService } from './uploads.service.js';

@ApiController('media/uploads', 'media')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /** Register an upload; the browser then sends the file straight to storage using `upload`. */
  @Post()
  @RequirePermissions('media.upload')
  @ZResponse(media.createUploadResponseSchema)
  create(@CurrentPrincipal() p: Principal, @ZBody(media.createUploadRequestSchema) body: media.CreateUploadRequest) {
    return this.uploads.create(p, body);
  }

  /** Verify the uploaded file and start processing. */
  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermissions('media.upload')
  @ZResponse(media.mediaAssetDetailSchema)
  complete(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.uploads.complete(p, id);
  }
}
