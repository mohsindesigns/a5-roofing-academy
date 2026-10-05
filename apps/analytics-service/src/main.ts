import 'reflect-metadata';
import { bootstrapService } from '@a5/nest-kit';
import { AppModule } from './app.module.js';
import { loadAnalyticsConfig } from './config.js';

const config = loadAnalyticsConfig();
await bootstrapService({
  config,
  title: 'A5 Analytics Service',
  description: 'Event-fed training facts, dashboards, reports and exports.',
  module: (logger) => AppModule.register(config, logger),
});
