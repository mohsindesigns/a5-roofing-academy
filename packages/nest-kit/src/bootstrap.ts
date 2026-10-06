import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { createLogger, startTelemetry, type Logger } from '@a5/observability';
import type { ServiceRuntimeConfig } from './config.js';
import { HealthRegistry } from './health.js';
import { PinoNestLogger } from './logger.js';

export interface BootstrapOptions {
  config: ServiceRuntimeConfig;
  /** Factory so the module can receive the logger (CoreModule.forRoot(config, logger)). */
  module: (logger: Logger) => unknown;
  title: string;
  description?: string;
  configure?: (app: NestExpressApplication) => void | Promise<void>;
  /** Parse JSON/urlencoded bodies globally (disable for the streaming gateway). */
  parseBodies?: boolean;
}

/** Apply middleware and settings shared by production bootstrap and tests. */
export function configureApplication(
  app: NestExpressApplication,
  config: ServiceRuntimeConfig,
  { parseBodies = true }: { parseBodies?: boolean } = {},
): void {
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.disable('x-powered-by');
  app.use(
    helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }),
  );
  if (parseBodies) {
    app.useBodyParser('json', { limit: config.bodyLimit });
    app.useBodyParser('urlencoded', { limit: config.bodyLimit, extended: false });
  }
}

export function setupSwagger(app: INestApplication, title: string, description?: string): void {
  const doc = new DocumentBuilder()
    .setTitle(title)
    .setDescription(description ?? `${title} API`)
    .setVersion('1')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'x-a5-principal' }, 'principal')
    .build();
  const document = SwaggerModule.createDocument(app, doc);
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/json' });
}

export async function bootstrapService(options: BootstrapOptions): Promise<NestExpressApplication> {
  const { config } = options;
  const logger = createLogger({ service: config.serviceName, level: config.logLevel });
  const telemetry = await startTelemetry({
    serviceName: config.serviceName,
    otlpEndpoint: config.otlpEndpoint,
    logger,
  });

  const app = await NestFactory.create<NestExpressApplication>(options.module(logger) as never, {
    logger: new PinoNestLogger(logger),
    bodyParser: false,
    abortOnError: false,
  });
  configureApplication(app, config, { parseBodies: options.parseBodies ?? true });
  if (config.swaggerEnabled) setupSwagger(app, options.title, options.description);
  await options.configure?.(app);

  app.enableShutdownHooks();
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    app.get(HealthRegistry).markShuttingDown();
    const timer = setTimeout(() => {
      logger.error('graceful shutdown timed out');
      process.exit(1);
    }, config.shutdownGraceMs);
    try {
      await app.close();
      await telemetry.shutdown();
    } finally {
      clearTimeout(timer);
    }
  };
  // Nest's own hooks run on app.close(); these handle the signal-triggered sequence.
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen(config.port, config.host);
  logger.info(
    { port: config.port, role: config.role, env: config.nodeEnv },
    `${config.serviceName} listening`,
  );
  return app;
}
