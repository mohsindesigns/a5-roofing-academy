import { DynamicModule, Global, Module } from '@nestjs/common';
import { CoreModule, DatabaseModule, EventsModule, RedisModule } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { AUDIT_CONFIG, type AuditConfig } from './config.js';
import { migrations } from './database/migrations/index.js';
import { AuditIngest } from './ingest/audit-ingest.js';
import { LogsController } from './logs/logs.controller.js';
import { LogsRepository } from './logs/logs.repository.js';
import { LogsService } from './logs/logs.service.js';
import { PartitionMaintenance } from './partitions/partition-maintenance.js';

@Global()
@Module({})
class AuditConfigModule {
  static register(config: AuditConfig): DynamicModule {
    return { module: AuditConfigModule, providers: [{ provide: AUDIT_CONFIG, useValue: config }], exports: [AUDIT_CONFIG] };
  }
}

/** Consumption of `audit.recorded` from every producer and monthly partition upkeep. */
@Module({ providers: [AuditIngest, PartitionMaintenance], exports: [AuditIngest, PartitionMaintenance] })
export class IngestModule {}

/** Read API over the trail (audit_logs.view). */
@Module({ controllers: [LogsController], providers: [LogsService, LogsRepository] })
export class LogsModule {}

@Module({})
export class AppModule {
  static register(config: AuditConfig, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(config, logger),
        AuditConfigModule.register(config),
        DatabaseModule.forRoot({ migrations, migrateOnStart: false }),
        RedisModule,
        // The audit service only consumes events; it has no outbox to relay.
        EventsModule.forRoot({ relay: false }),
        IngestModule,
        LogsModule,
      ],
    };
  }
}
