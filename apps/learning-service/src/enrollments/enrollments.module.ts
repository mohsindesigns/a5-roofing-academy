import { Module } from '@nestjs/common';
import { EnrollmentsController } from './enrollments.controller.js';
import { EnrollmentsService } from './enrollments.service.js';
import { OverdueService } from './overdue.service.js';

@Module({
  controllers: [EnrollmentsController],
  providers: [EnrollmentsService, OverdueService],
  exports: [EnrollmentsService, OverdueService],
})
export class EnrollmentsModule {}
