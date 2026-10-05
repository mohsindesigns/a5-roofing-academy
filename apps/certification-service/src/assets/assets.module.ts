import { Module } from '@nestjs/common';
import { SignatoriesModule } from '../signatories/signatories.module.js';
import { AssetsController } from './assets.controller.js';
import { AssetsService } from './assets.service.js';
import { FilesController } from './files.controller.js';

@Module({
  imports: [SignatoriesModule],
  controllers: [AssetsController, FilesController],
  providers: [AssetsService],
})
export class AssetsModule {}
