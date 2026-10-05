import { DynamicModule, Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { Logger } from '@a5/observability';
import { AuthGuard } from './auth.js';
import { AppExceptionFilter } from './exception-filter.js';
import { HealthController, HealthRegistry } from './health.js';
import { InternalHttpClient } from './http-client.js';
import { RequestContextMiddleware } from './request-context.js';
import { LOGGER, SERVICE_CONFIG } from './tokens.js';
import { ResponseSchemaInterceptor } from './validation.js';
import type { ServiceRuntimeConfig } from './config.js';

/**
 * Cross-cutting infrastructure for every service: configuration, logging, request context,
 * authentication/authorization guard, error normalization, response contracts and health.
 */
@Global()
@Module({})
export class CoreModule implements NestModule {
  static forRoot(config: ServiceRuntimeConfig, logger: Logger): DynamicModule {
    return {
      module: CoreModule,
      controllers: [HealthController],
      providers: [
        { provide: SERVICE_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
        HealthRegistry,
        InternalHttpClient,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AppExceptionFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseSchemaInterceptor },
      ],
      exports: [SERVICE_CONFIG, LOGGER, HealthRegistry, InternalHttpClient],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
