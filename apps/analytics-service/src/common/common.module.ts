import { DynamicModule, Global, Module } from '@nestjs/common';
import { ANALYTICS_CONFIG, type AnalyticsConfig } from '../config.js';
import { AnalyticsClock } from './clock.js';
import { AnalyticsScope } from './scope.service.js';
import { SettingsService } from './settings.service.js';
import { StorageProvider } from '../storage/storage.provider.js';

/** Configuration and cross-feature services (clock, settings, scope, object storage). */
@Global()
@Module({})
export class CommonModule {
  static register(config: AnalyticsConfig): DynamicModule {
    return {
      module: CommonModule,
      providers: [
        { provide: ANALYTICS_CONFIG, useValue: config },
        AnalyticsClock,
        SettingsService,
        AnalyticsScope,
        StorageProvider,
      ],
      exports: [ANALYTICS_CONFIG, AnalyticsClock, SettingsService, AnalyticsScope, StorageProvider],
    };
  }
}
