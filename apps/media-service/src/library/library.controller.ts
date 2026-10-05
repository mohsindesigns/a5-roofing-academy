import { Delete, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { media } from '@a5/contracts';
import {
  ApiController,
  CurrentPrincipal,
  PreconditionError,
  RequirePermissions,
  ZBody,
  ZParam,
  ZQuery,
  ZResponse,
} from '@a5/nest-kit';
import { LibraryService } from './library.service.js';
import { MediaReadService } from './media-read.service.js';

@ApiController('media')
export class LibraryController {
  constructor(
    private readonly library: LibraryService,
    private readonly read: MediaReadService,
  ) {}

  @Get()
  @RequirePermissions('media.view')
  @ZResponse(media.mediaPageSchema)
  list(@CurrentPrincipal() p: Principal, @ZQuery(media.listMediaQuerySchema) q: media.ListMediaQuery) {
    return this.read.list(p.organizationId, {
      q: q.q,
      kind: q.kind,
      status: q.status,
      includeArchived: q.includeArchived,
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get(':id')
  @RequirePermissions('media.view')
  @ZResponse(media.mediaAssetDetailSchema)
  detail(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.read.detail(p.organizationId, id);
  }

  @Patch(':id')
  @RequirePermissions('media.upload')
  @ZResponse(media.mediaAssetDetailSchema)
  update(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZBody(media.updateMediaRequestSchema) body: media.UpdateMediaRequest) {
    return this.library.update(p, id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('media.delete')
  @ZResponse(media.mediaAssetDetailSchema)
  archive(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.library.archive(p, id);
  }

  /** Media is never hard-deleted: lessons, watch history and audit records refer to it. */
  @Delete(':id')
  @RequirePermissions('media.delete')
  remove(@ZParam('id') _id: string): never {
    throw new PreconditionError(
      'HARD_DELETE_NOT_ALLOWED',
      'Media is archived instead of deleted so lesson history and watch records stay intact. Use Archive to remove it from the library.',
    );
  }

  // ---------------------------------------------------------------- chapters

  @Post(':id/chapters')
  @RequirePermissions('media.upload')
  @ZResponse(media.chapterListSchema)
  createChapter(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZBody(media.createChapterRequestSchema) body: media.CreateChapterRequest) {
    return this.library.createChapter(p, id, body);
  }

  @Patch(':id/chapters/:chapterId')
  @RequirePermissions('media.upload')
  @ZResponse(media.chapterListSchema)
  updateChapter(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('chapterId') chapterId: string,
    @ZBody(media.updateChapterRequestSchema) body: media.UpdateChapterRequest,
  ) {
    return this.library.updateChapter(p, id, chapterId, body);
  }

  @Delete(':id/chapters/:chapterId')
  @RequirePermissions('media.upload')
  @ZResponse(media.chapterListSchema)
  deleteChapter(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZParam('chapterId') chapterId: string) {
    return this.library.deleteChapter(p, id, chapterId);
  }

  // ---------------------------------------------------------------- captions

  /** Start a WebVTT upload for this video (complete it with POST /media/uploads/{assetId}/complete). */
  @Post(':id/captions')
  @RequirePermissions('media.upload')
  @ZResponse(media.createCaptionUploadResponseSchema)
  createCaption(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(media.createCaptionUploadRequestSchema) body: media.CreateCaptionUploadRequest,
  ) {
    return this.library.createCaptionUpload(p, id, body);
  }

  @Patch(':id/captions/:captionId')
  @RequirePermissions('media.upload')
  @ZResponse(media.mediaAssetDetailSchema)
  updateCaption(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('captionId') captionId: string,
    @ZBody(media.updateCaptionRequestSchema) body: media.UpdateCaptionRequest,
  ) {
    return this.library.updateCaption(p, id, captionId, body);
  }

  @Delete(':id/captions/:captionId')
  @RequirePermissions('media.upload')
  @ZResponse(media.mediaAssetDetailSchema)
  deleteCaption(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZParam('captionId') captionId: string) {
    return this.library.deleteCaption(p, id, captionId);
  }

  // ---------------------------------------------------------------- transcript

  @Put(':id/transcript')
  @RequirePermissions('media.upload')
  @ZResponse(media.mediaAssetDetailSchema)
  setTranscript(@CurrentPrincipal() p: Principal, @ZParam('id') id: string, @ZBody(media.setTranscriptRequestSchema) body: media.SetTranscriptRequest) {
    return this.library.setTranscript(p, id, body);
  }
}
