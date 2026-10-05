import { Module } from '@nestjs/common';
import { PreviewService } from './preview.service.js';
import { TemplatesController } from './templates.controller.js';
import { TemplatesService } from './templates.service.js';

@Module({
  controllers: [TemplatesController],
  providers: [TemplatesService, PreviewService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
