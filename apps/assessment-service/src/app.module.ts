import { DynamicModule, Global, Module } from '@nestjs/common';
import { DirectoryModule } from '@a5/directory';
import { CoreModule, DatabaseModule, EventsModule, RedisModule } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { AssessmentsModule } from './assessments/assessments.module.js';
import { AttemptsModule } from './attempts/attempts.module.js';
import { Clock } from './common/clock.js';
import { CommonModule } from './common/common.module.js';
import { ASSESSMENT_CONFIG, type AssessmentConfig } from './config.js';
import { migrations } from './database/migrations/index.js';
import { QuestionBankModule } from './question-bank/question-bank.module.js';
import { ReviewModule } from './review/review.module.js';

@Global()
@Module({})
class AssessmentConfigModule {
  static register(config: AssessmentConfig): DynamicModule {
    return {
      module: AssessmentConfigModule,
      providers: [{ provide: ASSESSMENT_CONFIG, useValue: config }],
      exports: [ASSESSMENT_CONFIG],
    };
  }
}

@Module({})
export class AppModule {
  static register(
    config: AssessmentConfig,
    logger: Logger,
    options: { clock?: Clock } = {},
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(config, logger),
        AssessmentConfigModule.register(config),
        DatabaseModule.forRoot({ migrations, migrateOnStart: false }),
        RedisModule,
        EventsModule.forRoot(),
        DirectoryModule,
        CommonModule.register(options.clock),
        QuestionBankModule,
        AssessmentsModule,
        AttemptsModule,
        ReviewModule,
      ],
    };
  }
}
