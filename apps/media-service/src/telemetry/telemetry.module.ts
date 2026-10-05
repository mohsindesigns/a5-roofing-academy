import { Module } from '@nestjs/common';
import { ProgressFlushWorker } from './progress-flush.worker.js';
import { ProgressStore } from './progress-store.js';
import { TelemetryController } from './telemetry.controller.js';
import { TelemetryService } from './telemetry.service.js';
import { WatchBuffer } from './watch-buffer.js';

@Module({
  controllers: [TelemetryController],
  providers: [TelemetryService, WatchBuffer, ProgressStore, ProgressFlushWorker],
  exports: [TelemetryService],
})
export class TelemetryModule {}
