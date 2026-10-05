import 'reflect-metadata';
import { bootstrapService } from '@a5/nest-kit';
import { AppModule } from './app.module.js';
import { loadCertificationConfig } from './config.js';

const config = loadCertificationConfig();
await bootstrapService({
  config,
  title: 'A5 Certification Service',
  description: 'Certifications, eligibility, templates, signatories, issuance, PDF certificates and public verification.',
  module: (logger) => AppModule.register(config, logger),
});
