import 'reflect-metadata';
import { bootstrapService } from '@a5/nest-kit';
import { AppModule } from './app.module.js';
import { loadLearningConfig } from './config.js';

const config = loadLearningConfig();
await bootstrapService({
  config,
  title: 'A5 Learning Service',
  description: 'Programs, structure, enrollment, progress, unlock rules and approvals.',
  module: (logger) => AppModule.register(config, logger),
});
