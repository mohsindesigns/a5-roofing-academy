import { DynamicModule, Global, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { CoreModule, DatabaseModule, EventsModule, RedisModule } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { AccessModule } from './access/access.module.js';
import { AuthModule } from './auth/auth.module.js';
import { IDENTITY_CONFIG, type IdentityConfig } from './config.js';
import { migrations } from './database/migrations/index.js';
import { InternalModule } from './internal/internal.module.js';
import { OrganizationModule } from './organization/organization.module.js';
import { UsersModule } from './users/users.module.js';

@Global()
@Module({})
class IdentityConfigModule {
  static register(config: IdentityConfig): DynamicModule {
    return {
      module: IdentityConfigModule,
      providers: [{ provide: IDENTITY_CONFIG, useValue: config }],
      exports: [IDENTITY_CONFIG],
    };
  }
}

@Module({})
export class AppModule {
  static register(config: IdentityConfig, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(config, logger),
        IdentityConfigModule.register(config),
        DatabaseModule.forRoot({ migrations, migrateOnStart: false }),
        RedisModule,
        EventsModule.forRoot(),
        AccessModule,
        UsersModule,
        AuthModule,
        OrganizationModule,
        InternalModule,
      ],
    };
  }
}

export function configureIdentityApp(app: NestExpressApplication): void {
  app.use(cookieParser());
}
