import { Module } from '@nestjs/common';
import { EnrollmentsModule } from '../enrollments/enrollments.module.js';
import { LearnerController } from './learner.controller.js';
import { LearnerService } from './learner.service.js';
import { SearchService } from './search.service.js';

@Module({
  imports: [EnrollmentsModule],
  controllers: [LearnerController],
  providers: [LearnerService, SearchService],
})
export class LearnerModule {}
