import { DynamicModule, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { CoreModule, DatabaseModule, EventsModule, RedisModule } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { MediaInfraModule, type MediaAppOverrides } from './common/media-infra.module.js';
import type { MediaConfig } from './config.js';
import { migrations } from './database/migrations/index.js';
import { InternalModule } from './internal/internal.module.js';
import { LibraryModule } from './library/library.module.js';
import { PlaybackModule } from './playback/playback.module.js';
import { ProcessingModule } from './processing/processing.module.js';
import { DevStorageModule } from './storage/dev-storage.module.js';
import { TelemetryModule } from './telemetry/telemetry.module.js';
import { UploadsModule } from './uploads/uploads.module.js';

@Module({})
export class AppModule {
  static register(
    config: MediaConfig,
    logger: Logger,
    overrides: MediaAppOverrides = {},
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(config, logger),
        DatabaseModule.forRoot({ migrations, migrateOnStart: false }),
        RedisModule,
        EventsModule.forRoot(),
        MediaInfraModule.register(config, overrides),
        DevStorageModule.register(config),
        ProcessingModule,
        UploadsModule,
        PlaybackModule,
        TelemetryModule,
        InternalModule,
        LibraryModule,
      ],
    };
  }
}

/** Beacons from `navigator.sendBeacon(url, string)` arrive as text/plain. */
export function configureMediaApp(app: NestExpressApplication): void {
  app.use('/api/v1/media/playback/beacon', express.text({ type: 'text/plain', limit: '64kb' }));
}
