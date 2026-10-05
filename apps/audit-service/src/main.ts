import 'reflect-metadata';
import { bootstrapService } from '@a5/nest-kit';
import { AppModule } from './app.module.js';
import { loadAuditConfig } from './config.js';

const config = loadAuditConfig();
await bootstrapService({
  config,
  title: 'A5 Audit Service',
  description: 'Immutable audit trail of administrative and security-relevant actions.',
  module: (logger) => AppModule.register(config, logger),
});
