import 'reflect-metadata';
import { bootstrapService } from '@a5/nest-kit';
import { AppModule } from './app.module.js';
import { loadNotificationConfig } from './config.js';

const config = loadNotificationConfig();
await bootstrapService({
  config,
  title: 'A5 Notification Service',
  description: 'In-app notifications, real-time stream, email delivery, templates and rules.',
  module: (logger) => AppModule.register(config, logger),
});
