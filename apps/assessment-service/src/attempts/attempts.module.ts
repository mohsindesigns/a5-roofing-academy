import { Module } from '@nestjs/common';
import { AttemptLifecycle } from './attempt-lifecycle.js';
import { AttemptsController, LearnerAssessmentsController } from './attempts.controller.js';
import { AttemptsService } from './attempts.service.js';
import { ExpirySweeper } from './expiry.sweeper.js';

@Module({
  controllers: [LearnerAssessmentsController, AttemptsController],
  providers: [AttemptsService, AttemptLifecycle, ExpirySweeper],
  exports: [AttemptLifecycle, ExpirySweeper],
})
export class AttemptsModule {}
