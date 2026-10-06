import { Get, Post, UploadedFile, UseInterceptors, applyDecorators } from '@nestjs/common';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
import type { Principal } from '@a5/auth';
import { certification } from '@a5/contracts';
import {
  ApiController,
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermissions,
  ZParam,
  ZQuery,
  ZResponse,
} from '@a5/nest-kit';
import { AssetsService } from './assets.service.js';
import { ImageUpload, type UploadedImage } from './upload.interceptor.js';

const c = certification;
const RULES = c.IMAGE_UPLOAD_RULES;

function MultipartImage(maxBytes: number) {
  return applyDecorators(
    UseInterceptors(ImageUpload(maxBytes)),
    ApiConsumes('multipart/form-data'),
    ApiBody({
      schema: {
        type: 'object',
        required: ['file'],
        properties: {
          file: {
            type: 'string',
            format: 'binary',
            description: 'PNG or JPEG image (SVG is not accepted)',
          },
        },
      },
    }),
  );
}

/** Authenticated multipart uploads of certificate artwork (signatures, stamps, template images). */
@ApiController('certification-assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Post('signatories/:id/signature')
  @RequirePermissions('signatures.manage')
  @MultipartImage(RULES.signature.maxBytes)
  @ZResponse(c.signatorySchema)
  uploadSignature(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @UploadedFile() file: UploadedImage,
  ) {
    return this.assets.uploadSignature(p, id, file);
  }

  @Post('stamps/:id/image')
  @RequirePermissions('stamps.manage')
  @MultipartImage(RULES.stamp.maxBytes)
  @ZResponse(c.stampSchema)
  uploadStamp(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @UploadedFile() file: UploadedImage,
  ) {
    return this.assets.uploadStampImage(p, id, file);
  }

  @Post('images')
  @RequireAnyPermission(
    'certificate_templates.create',
    'certificate_templates.update',
    'certifications.update',
  )
  @MultipartImage(Math.max(RULES.background.maxBytes, RULES.logo.maxBytes, RULES.badge.maxBytes))
  @ZResponse(c.assetSchema)
  uploadImage(
    @CurrentPrincipal() p: Principal,
    @ZQuery(c.uploadImageQuerySchema) q: { purpose: 'background' | 'logo' | 'badge' },
    @UploadedFile() file: UploadedImage,
  ) {
    return this.assets.uploadImage(p, q.purpose, file);
  }

  @Get(':id')
  @RequireAnyPermission(
    'certificate_templates.view',
    'certifications.view',
    'signatures.manage',
    'stamps.manage',
  )
  @ZResponse(c.assetSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.assets.get(p, id);
  }
}
