import { Module } from '@nestjs/common';
import { MediaReadModule } from '../library/media-read.module.js';
import { TelemetryModule } from '../telemetry/telemetry.module.js';
import { HlsService } from './hls.service.js';
import { HlsController, PlaybackController, PreviewController } from './playback.controller.js';
import { PlaybackService } from './playback.service.js';

@Module({
  imports: [MediaReadModule, TelemetryModule],
  controllers: [PlaybackController, PreviewController, HlsController],
  providers: [PlaybackService, HlsService],
})
export class PlaybackModule {}
