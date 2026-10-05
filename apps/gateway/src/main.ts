import 'reflect-metadata';
import compression from 'compression';
import express, { type Request, type Response } from 'express';
import { bootstrapService } from '@a5/nest-kit';
import { GatewayModule } from './app.module.js';
import { loadGatewayConfig } from './config.js';

const config = loadGatewayConfig();
await bootstrapService({
  config,
  title: 'A5 API Gateway',
  module: (logger) => GatewayModule.register(config, logger),
  // Proxied bodies are streamed to services untouched; only the gateway's own BFF routes parse JSON.
  parseBodies: false,
  configure: (app) => {
    app.use('/api/v1/bff', express.json({ limit: '256kb' }));
    app.enableCors({
      origin: config.gateway.corsOrigins.length ? config.gateway.corsOrigins : false,
      credentials: true,
      exposedHeaders: ['x-request-id', 'retry-after'],
    });
    app.use(
      compression({
        filter: (req: Request, res: Response) =>
          !String(res.getHeader('content-type') ?? '').startsWith('text/event-stream') && compression.filter(req, res),
      }),
    );
  },
});
