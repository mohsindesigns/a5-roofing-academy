import { DynamicModule, Global, Inject, Injectable, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { createDatabase, migrateToLatest, type Database, type Kysely, type MigrationMap } from '@a5/database';
import type { Logger } from '@a5/observability';
import { HealthRegistry } from './health.js';
import { DATABASE, DATABASE_HANDLE, LOGGER, SERVICE_CONFIG } from './tokens.js';
import type { ServiceRuntimeConfig } from './config.js';

/** Inject the service's Kysely instance. */
export const InjectDb = () => Inject(DATABASE);

export interface DatabaseModuleOptions {
  migrations: MigrationMap;
  /** Run pending migrations at startup (development and tests only). */
  migrateOnStart?: boolean;
}

@Injectable()
class DatabaseLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly handle: Database<unknown>,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly health: HealthRegistry,
    @Inject('A5_DB_OPTIONS') private readonly options: DatabaseModuleOptions,
  ) {}

  async onModuleInit() {
    this.health.register('postgres', () => this.handle.ping());
    if (this.options.migrateOnStart) {
      const applied = await migrateToLatest(this.handle.db as Kysely<unknown>, this.options.migrations);
      if (applied.length) this.logger.info({ applied }, 'database migrations applied');
    }
  }

  async onApplicationShutdown() {
    await this.handle.destroy();
  }
}

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: 'A5_DB_OPTIONS', useValue: options },
        {
          provide: DATABASE_HANDLE,
          inject: [SERVICE_CONFIG, LOGGER],
          useFactory: (config: ServiceRuntimeConfig, logger: Logger) => {
            if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
            return createDatabase({
              url: config.databaseUrl,
              poolMax: config.databasePoolMax,
              statementTimeoutMs: config.databaseStatementTimeoutMs,
              applicationName: config.serviceName,
              onSlowQuery: (e) => logger.warn({ durationMs: e.durationMs, sql: e.sql }, 'slow query'),
              onError: (e) => logger.debug({ err: e.error, sql: e.sql }, 'query error'),
            });
          },
        },
        { provide: DATABASE, inject: [DATABASE_HANDLE], useFactory: (h: Database<unknown>) => h.db },
        DatabaseLifecycle,
      ],
      exports: [DATABASE, DATABASE_HANDLE],
    };
  }
}
