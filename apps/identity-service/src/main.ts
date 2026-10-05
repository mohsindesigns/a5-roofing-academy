import 'reflect-metadata';
import { bootstrapService } from '@a5/nest-kit';
import { AppModule, configureIdentityApp } from './app.module.js';
import { loadIdentityConfig } from './config.js';

const config = loadIdentityConfig();
await bootstrapService({
  config,
  title: 'A5 Identity Service',
  description: 'Authentication, users, roles, permissions and organization structure.',
  module: (logger) => AppModule.register(config, logger),
  configure: configureIdentityApp,
});
