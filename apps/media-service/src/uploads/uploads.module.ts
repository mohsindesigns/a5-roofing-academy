import { Module } from '@nestjs/common';
import { MediaReadModule } from '../library/media-read.module.js';
import { ProcessingModule } from '../processing/processing.module.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

@Module({
  imports: [MediaReadModule, ProcessingModule],
  controllers: [UploadsController],
  providers: [UploadsService],
  exports: [UploadsService],
})
export class UploadsModule {}
