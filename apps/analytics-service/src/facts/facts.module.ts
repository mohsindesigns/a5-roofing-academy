import { Module } from '@nestjs/common';
import { ANALYTICS_CONFIG, type AnalyticsConfig } from '../config.js';
import { FactWriter } from './fact-writer.js';
import { FactsConsumer } from './facts.consumer.js';

@Module({
  providers: [
    {
      provide: FactWriter,
      inject: [ANALYTICS_CONFIG],
      useFactory: (config: AnalyticsConfig) => new FactWriter({ timezone: config.analytics.timezone }),
    },
    FactsConsumer,
  ],
  exports: [FactWriter, FactsConsumer],
})
export class FactsModule {}
