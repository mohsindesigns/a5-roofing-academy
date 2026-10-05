import { Module } from '@nestjs/common';
import { EnrollmentsModule } from '../enrollments/enrollments.module.js';
import { LearningEventsConsumer } from './learning-events.consumer.js';

@Module({
  imports: [EnrollmentsModule],
  providers: [LearningEventsConsumer],
  exports: [LearningEventsConsumer],
})
export class ConsumersModule {}
