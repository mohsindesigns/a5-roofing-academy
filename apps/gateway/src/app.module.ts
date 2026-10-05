import { DynamicModule, Global, MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { CoreModule, RedisModule } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { PlatformController } from './bff/platform.controller.js';
import { Downstream } from './bff/downstream.js';
import { GATEWAY_CONFIG, type GatewayConfig } from './config.js';
import { Authenticator } from './proxy/authenticator.js';
import { BffAuthMiddleware } from './proxy/bff-auth.middleware.js';
import { ProxyMiddleware } from './proxy/proxy.middleware.js';

@Global()
@Module({})
class GatewayConfigModule {
  static register(config: GatewayConfig): DynamicModule {
    return { module: GatewayConfigModule, providers: [{ provide: GATEWAY_CONFIG, useValue: config }], exports: [GATEWAY_CONFIG] };
  }
}

@Module({})
export class GatewayModule implements NestModule {
  static register(config: GatewayConfig, logger: Logger): DynamicModule {
    return {
      module: GatewayModule,
      imports: [CoreModule.forRoot(config, logger), GatewayConfigModule.register(config), RedisModule],
      controllers: [PlatformController],
      providers: [Authenticator, ProxyMiddleware, BffAuthMiddleware, Downstream],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(BffAuthMiddleware).forRoutes({ path: 'api/v1/bff/*path', method: RequestMethod.ALL });
    consumer.apply(ProxyMiddleware).exclude({ path: 'api/v1/bff/*path', method: RequestMethod.ALL }).forRoutes({ path: 'api/v1/*path', method: RequestMethod.ALL });
  }
}
