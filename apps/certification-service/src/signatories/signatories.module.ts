import { Module } from '@nestjs/common';
import { SignatoriesController, StampsController } from './signatories.controller.js';
import { SignatoriesService, StampsService } from './signatories.service.js';

@Module({
  controllers: [SignatoriesController, StampsController],
  providers: [SignatoriesService, StampsService],
  exports: [SignatoriesService, StampsService],
})
export class SignatoriesModule {}
