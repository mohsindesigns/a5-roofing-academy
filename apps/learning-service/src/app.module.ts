import { DynamicModule, Global, Module } from '@nestjs/common';
import { DirectoryModule } from '@a5/directory';
import { CoreModule, DatabaseModule, EventsModule, RedisModule } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { LEARNING_CONFIG, type LearningConfig } from './config.js';
import { ConsumersModule } from './consumers/consumers.module.js';
import { migrations } from './database/migrations/index.js';
import { EngineModule } from './engine/engine.module.js';
import { EnrollmentsModule } from './enrollments/enrollments.module.js';
import { InternalModule } from './internal/internal.module.js';
import { LearnerModule } from './learner/learner.module.js';
import { OversightModule } from './oversight/oversight.module.js';
import { ProgramsModule } from './programs/programs.module.js';

@Global()
@Module({})
class LearningConfigModule {
  static register(config: LearningConfig): DynamicModule {
    return {
      module: LearningConfigModule,
      providers: [{ provide: LEARNING_CONFIG, useValue: config }],
      exports: [LEARNING_CONFIG],
    };
  }
}

@Module({})
export class AppModule {
  static register(config: LearningConfig, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(config, logger),
        LearningConfigModule.register(config),
        DatabaseModule.forRoot({ migrations, migrateOnStart: false }),
        RedisModule,
        EventsModule.forRoot(),
        DirectoryModule,
        EngineModule,
        ProgramsModule,
        EnrollmentsModule,
        LearnerModule,
        OversightModule,
        ConsumersModule,
        InternalModule,
      ],
    };
  }
}
