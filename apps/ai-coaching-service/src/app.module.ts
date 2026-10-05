import { DynamicModule, Global, Module } from '@nestjs/common';
import { DirectoryModule } from '@a5/directory';
import { CoreModule, DatabaseModule, EventsModule, RedisModule } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { CommonModule } from './common/common.module.js';
import { AI_CONFIG, type AiConfig } from './config.js';
import { migrations } from './database/migrations/index.js';
import { ReviewModule, ScenariosModule, SessionsModule, SettingsModule } from './modules.js';
import { ProvidersModule } from './providers/providers.module.js';

@Global()
@Module({})
class AiConfigModule {
  static register(config: AiConfig): DynamicModule {
    return {
      module: AiConfigModule,
      providers: [{ provide: AI_CONFIG, useValue: config }],
      exports: [AI_CONFIG],
    };
  }
}

@Module({})
export class AppModule {
  static register(config: AiConfig, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(config, logger),
        AiConfigModule.register(config),
        DatabaseModule.forRoot({ migrations, migrateOnStart: false }),
        RedisModule,
        EventsModule.forRoot(),
        DirectoryModule,
        CommonModule,
        ProvidersModule,
        SettingsModule,
        ScenariosModule,
        SessionsModule,
        ReviewModule,
      ],
    };
  }
}
