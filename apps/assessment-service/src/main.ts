import 'reflect-metadata';
import { bootstrapService } from '@a5/nest-kit';
import { AppModule } from './app.module.js';
import { loadAssessmentConfig } from './config.js';

const config = loadAssessmentConfig();
await bootstrapService({
  config,
  title: 'A5 Assessment Service',
  description: 'Question banks, assessments, attempts, grading and review.',
  module: (logger) => AppModule.register(config, logger),
});
