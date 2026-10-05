import 'reflect-metadata';
import { bootstrapService } from '@a5/nest-kit';
import { AppModule, configureMediaApp } from './app.module.js';
import { loadMediaConfig } from './config.js';

const config = loadMediaConfig();
await bootstrapService({
  config,
  title: 'A5 Media Service',
  description: 'Media library, uploads, processing, playback authorization and watch telemetry.',
  module: (logger) => AppModule.register(config, logger),
  configure: configureMediaApp,
});
