import { DynamicModule, Module } from '@nestjs/common';
import { DirectoryModule } from '@a5/directory';
import { CoreModule, DatabaseModule, EventsModule, RedisModule } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { CommonModule } from './common/common.module.js';
import type { AnalyticsConfig } from './config.js';
import { migrations } from './database/migrations/index.js';
import { FactsModule } from './facts/facts.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { RollupsModule } from './rollups/rollups.module.js';

@Module({})
export class AppModule {
  static register(config: AnalyticsConfig, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(config, logger),
        CommonModule.register(config),
        DatabaseModule.forRoot({ migrations, migrateOnStart: false }),
        RedisModule,
        EventsModule.forRoot(),
        DirectoryModule,
        FactsModule,
        RollupsModule,
        AnalyticsModule,
        ReportsModule,
      ],
    };
  }
}
