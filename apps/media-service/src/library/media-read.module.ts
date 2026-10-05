import { Module } from '@nestjs/common';
import { MediaReadService } from './media-read.service.js';

@Module({
  providers: [MediaReadService],
  exports: [MediaReadService],
})
export class MediaReadModule {}
