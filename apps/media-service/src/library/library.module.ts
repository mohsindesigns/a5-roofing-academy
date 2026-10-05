import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module.js';
import { LibraryController } from './library.controller.js';
import { LibraryService } from './library.service.js';
import { MediaReadModule } from './media-read.module.js';

@Module({
  imports: [MediaReadModule, UploadsModule],
  controllers: [LibraryController],
  providers: [LibraryService],
})
export class LibraryModule {}
