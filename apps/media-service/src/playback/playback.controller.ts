import { Get, Header, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Principal } from '@a5/auth';
import { media } from '@a5/contracts';
import {
  ApiController,
  CurrentPrincipal,
  Public,
  RequirePermissions,
  ZBody,
  ZParam,
  ZResponse,
} from '@a5/nest-kit';
import { HlsService } from './hls.service.js';
import { PlaybackService } from './playback.service.js';

@ApiController('media/playback', 'media')
export class PlaybackController {
  constructor(private readonly playback: PlaybackService) {}

  /** Any signed-in learner: the lesson grant from learning-service is the authorization. */
  @Post()
  @HttpCode(200)
  @ZResponse(media.playbackDescriptorSchema)
  describe(
    @CurrentPrincipal() p: Principal,
    @ZBody(media.playbackRequestSchema) body: media.PlaybackRequest,
  ) {
    return this.playback.forLesson(p, body.grant);
  }
}

@ApiController('media')
export class PreviewController {
  constructor(private readonly playback: PlaybackService) {}

  @Post(':id/preview')
  @HttpCode(200)
  @RequirePermissions('media.view')
  @ZResponse(media.playbackDescriptorSchema)
  preview(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.playback.preview(p, id);
  }
}

/** Public: authorized by the short-lived token issued with the playback descriptor. */
@Public()
@ApiController('media/hls', 'media')
export class HlsController {
  constructor(private readonly hls: HlsService) {}

  @Get(':assetId/:file')
  @Header('Cache-Control', 'private, no-store')
  async playlist(
    @ZParam('assetId') assetId: string,
    @Param('file') file: string,
    @Query('token') token: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const text = await this.hls.playlist(assetId, file, token);
    res.type('application/vnd.apple.mpegurl');
    return text;
  }
}
