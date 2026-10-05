import { DynamicModule, Global, Module } from '@nestjs/common';
import { DirectoryModule } from '@a5/directory';
import { CoreModule, DatabaseModule, EventsModule, LOGGER, RedisModule } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { DefaultsService } from './catalog/defaults.js';
import { NOTIFICATION_CONFIG, type NotificationConfig } from './config.js';
import { migrations } from './database/migrations/index.js';
import { DeliveriesController, DeliveriesService } from './email/deliveries.controller.js';
import { EmailDispatcher } from './email/email.dispatcher.js';
import { MaintenanceService } from './email/maintenance.service.js';
import { ContentSealer } from './email/sealer.js';
import { ConsoleTransport, EMAIL_TRANSPORT, SmtpTransport, type EmailTransport } from './email/transports.js';
import { NotificationEventHandlers, ProgramLearnersProjection } from './engine/event-handlers.js';
import { NotificationEngine } from './engine/notification-engine.js';
import { RecipientResolver } from './engine/recipients.js';
import { InboxController } from './inbox/inbox.controller.js';
import { InboxService } from './inbox/inbox.service.js';
import { NotificationsRepository } from './inbox/notifications.repository.js';
import { PreferencesService } from './inbox/preferences.service.js';
import { DelayedPushScheduler } from './realtime/push.scheduler.js';
import { RealtimePublisher } from './realtime/realtime.publisher.js';
import { NotificationStreamController } from './realtime/stream.controller.js';
import { NotificationStreamService } from './realtime/stream.service.js';
import { RulesController } from './rules/rules.controller.js';
import { RulesService } from './rules/rules.service.js';
import { TemplatesController } from './templates/templates.controller.js';
import { TemplatesService } from './templates/templates.service.js';

export interface NotificationAppOptions {
  /** Replace the configured transport (tests use MemoryTransport). */
  emailTransport?: EmailTransport;
}

export function createEmailTransport(config: NotificationConfig, logger: Logger): EmailTransport {
  return config.email.transport === 'smtp' ? new SmtpTransport(config.email.smtpUrl!) : new ConsoleTransport(logger);
}

/** Configuration, delivery infrastructure and shared repositories. */
@Global()
@Module({})
class NotificationCoreModule {
  static register(config: NotificationConfig, options: NotificationAppOptions): DynamicModule {
    const shared = [DefaultsService, NotificationsRepository, RealtimePublisher, DelayedPushScheduler, EmailDispatcher];
    return {
      module: NotificationCoreModule,
      providers: [
        { provide: NOTIFICATION_CONFIG, useValue: config },
        {
          provide: EMAIL_TRANSPORT,
          inject: [LOGGER],
          useFactory: (logger: Logger) => options.emailTransport ?? createEmailTransport(config, logger),
        },
        { provide: ContentSealer, useValue: new ContentSealer(config.sealKey) },
        ...shared,
      ],
      exports: [NOTIFICATION_CONFIG, EMAIL_TRANSPORT, ContentSealer, ...shared],
    };
  }
}

/** Event consumption: rules → recipients → notifications and emails; housekeeping. */
@Module({
  providers: [RecipientResolver, NotificationEngine, NotificationEventHandlers, ProgramLearnersProjection, MaintenanceService],
  exports: [NotificationEngine, MaintenanceService],
})
export class EngineModule {}

/** The caller's inbox, preferences and real-time stream. */
@Module({
  controllers: [InboxController, NotificationStreamController],
  providers: [InboxService, PreferencesService, NotificationStreamService],
  exports: [NotificationStreamService],
})
export class InboxModule {}

/** Administration: templates, rules and the email delivery log (notifications.manage). */
@Module({
  controllers: [TemplatesController, RulesController, DeliveriesController],
  providers: [TemplatesService, RulesService, DeliveriesService],
})
export class AdminModule {}

@Module({})
export class AppModule {
  static register(config: NotificationConfig, logger: Logger, options: NotificationAppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(config, logger),
        NotificationCoreModule.register(config, options),
        DatabaseModule.forRoot({ migrations, migrateOnStart: false }),
        RedisModule,
        EventsModule.forRoot(),
        DirectoryModule,
        EngineModule,
        InboxModule,
        AdminModule,
      ],
    };
  }
}
