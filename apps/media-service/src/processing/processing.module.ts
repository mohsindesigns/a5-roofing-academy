import { Module } from '@nestjs/common';
import { ProcessingQueue, ProcessingWorker } from './processing.queue.js';

@Module({
  providers: [ProcessingQueue, ProcessingWorker],
  exports: [ProcessingQueue],
})
export class ProcessingModule {}
