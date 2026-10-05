import 'reflect-metadata';
import { bootstrapService } from '@a5/nest-kit';
import { AppModule } from './app.module.js';
import { loadAiConfig } from './config.js';

const config = loadAiConfig();
await bootstrapService({
  config,
  title: 'A5 AI Coaching Service',
  description:
    'AI homeowner objection trainer: personas, scenarios, immutable prompt versions, streamed role-play conversations, asynchronous scorecards and coaching reviews.',
  module: (logger) => AppModule.register(config, logger),
});
