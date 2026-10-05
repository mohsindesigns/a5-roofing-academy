import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller.js';
import { ApprovalsService } from './approvals.service.js';
import { ProgressController } from './progress.controller.js';
import { TeamProgressService } from './team-progress.service.js';

@Module({
  controllers: [ProgressController, ApprovalsController],
  providers: [TeamProgressService, ApprovalsService],
})
export class OversightModule {}
