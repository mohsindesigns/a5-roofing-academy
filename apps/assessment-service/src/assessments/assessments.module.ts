import { Module } from '@nestjs/common';
import { AssessmentsController } from './assessments.controller.js';
import { AssessmentsService } from './assessments.service.js';
import { StatsService } from './stats.service.js';

@Module({
  controllers: [AssessmentsController],
  providers: [AssessmentsService, StatsService],
  exports: [AssessmentsService],
})
export class AssessmentsModule {}
