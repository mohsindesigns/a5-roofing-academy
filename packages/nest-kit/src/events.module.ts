import {
  BeforeApplicationShutdown,
  DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
  Optional,
  SetMetadata,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import {
  PRODUCERS,
  auditEvents,
  buildEvent,
  eventSigningSecretEnvName,
  streamFor,
  type AuditRecord,
  type EventDefinition,
  type EventEnvelope,
  type Producer,
} from '@a5/events';
import { writeOutbox, type Kysely, type OutboxSchema, type Transaction } from '@a5/database';
import {
  OutboxRelay,
  RedisNamespace,
  StreamConsumer,
  StreamPublisher,
  signEvent,
  type DeliveryInfo,
  type Redis,
} from '@a5/messaging';
import { getContext, uuidv7, type Logger } from '@a5/observability';
import type { z } from 'zod';
import { runsWorkers, type ServiceRuntimeConfig } from './config.js';
import { DATABASE, LOGGER, REDIS, SERVICE_CONFIG } from './tokens.js';

type AnyDefinition = EventDefinition<string, z.ZodType>;
type OutboxExecutor = Transaction<OutboxSchema> | Kysely<OutboxSchema>;

export interface EmitOptions {
  subject?: { type: string; id: string } | null;
  organizationId?: string | null;
  /** Defaults to the authenticated user of the current request, or the system. */
  actor?: EventEnvelope['actor'];
}

/**
 * Writes domain events to the transactional outbox. Always pass the transaction that performs the
 * state change so the event commits (or rolls back) with it.
 */
@Injectable()
export class EventBus {
  constructor(@Inject(SERVICE_CONFIG) private readonly config: ServiceRuntimeConfig) {}

  build<T extends string, S extends z.ZodType>(
    def: EventDefinition<T, S>,
    payload: z.input<S>,
    options: EmitOptions = {},
  ): EventEnvelope<z.infer<S>, T> {
    const ctx = getContext();
    const event = buildEvent(def, payload, {
      id: uuidv7(),
      producer: this.config.serviceName,
      organizationId:
        options.organizationId !== undefined
          ? options.organizationId
          : (ctx?.organizationId ?? null),
      actor:
        options.actor ??
        (ctx?.userId ? { type: 'user', id: ctx.userId } : { type: 'system', id: null }),
      correlationId: ctx?.correlationId ?? null,
      causationId: ctx?.causationId ?? null,
      subject: options.subject ?? null,
    });
    return this.config.eventSigningSecret
      ? signEvent(event, this.config.eventSigningSecret)
      : event;
  }

  async emit<T extends string, S extends z.ZodType>(
    trx: OutboxExecutor,
    def: EventDefinition<T, S>,
    payload: z.input<S>,
    options: EmitOptions = {},
  ): Promise<EventEnvelope<z.infer<S>, T>> {
    const event = this.build(def, payload, options);
    await this.write(trx, [event]);
    return event;
  }

  /** Record an audit entry through the outbox (consumed by audit-service). */
  async audit(trx: OutboxExecutor, record: AuditRecord, options: EmitOptions = {}): Promise<void> {
    const ctx = getContext();
    await this.emit(
      trx,
      auditEvents.recorded,
      {
        ...record,
        ip: record.ip ?? ctx?.ip ?? null,
        userAgent: record.userAgent ?? ctx?.userAgent ?? null,
        requestId: record.requestId ?? ctx?.requestId ?? null,
      },
      {
        subject: record.resourceId ? { type: record.resourceType, id: record.resourceId } : null,
        ...options,
      },
    );
  }

  async write(trx: OutboxExecutor, events: EventEnvelope[]): Promise<void> {
    const stream = streamFor(this.config.serviceName);
    await writeOutbox(
      trx,
      events.map((e) => ({
        id: e.id,
        type: e.type,
        version: e.version,
        stream,
        envelope: e,
        published_at: null,
        last_error: null,
      })),
    );
  }
}

const ON_EVENT = 'a5:on-event';

interface OnEventMeta {
  type: string;
  producers: Producer[] | 'all';
}

/**
 * Subscribe a provider method to a domain event. The consumer group is the service name, so each
 * service receives every event once; handlers must be idempotent (use `processOnce`).
 */
export function OnEvent(
  def: AnyDefinition,
  options: { fromAllProducers?: boolean } = {},
): MethodDecorator {
  const meta: OnEventMeta = {
    type: def.type,
    producers: options.fromAllProducers ? 'all' : [def.producer],
  };
  return SetMetadata(ON_EVENT, meta);
}

export interface EventsModuleOptions {
  /** Run the outbox relay in worker processes (requires a database). */
  relay?: boolean;
  /** Extra streams to consume besides those implied by @OnEvent handlers. */
  extraStreams?: string[];
}

@Injectable()
class EventsLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private relay: OutboxRelay | null = null;
  private consumer: StreamConsumer | null = null;

  constructor(
    @Inject(SERVICE_CONFIG) private readonly config: ServiceRuntimeConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly ns: RedisNamespace,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    @Inject('A5_EVENTS_OPTIONS') private readonly options: EventsModuleOptions,
    @Optional() @Inject(DATABASE) private readonly db: Kysely<OutboxSchema> | null,
  ) {}

  async onApplicationBootstrap() {
    if (!runsWorkers(this.config)) return;
    if (this.options.relay !== false && this.db && this.config.databaseUrl) {
      this.relay = new OutboxRelay({
        db: this.db,
        databaseUrl: this.config.databaseUrl,
        publisher: new StreamPublisher(this.redis, this.ns),
        logger: this.logger,
      });
      await this.relay.start();
    }
    const handlers = this.discoverHandlers();
    if (handlers.length === 0) return;
    const streams = new Set<string>(this.options.extraStreams ?? []);
    for (const h of handlers) {
      const producers = h.meta.producers === 'all' ? PRODUCERS : h.meta.producers;
      for (const p of producers) streams.add(streamFor(p));
    }
    if (!this.config.allowUnsignedEvents) {
      for (const producer of PRODUCERS) {
        if (
          streams.has(streamFor(producer)) &&
          !this.config.eventSigningKeys[producer]
        ) {
          throw new Error(
            `Invalid event configuration: ${eventSigningSecretEnvName(producer)} is required to consume ${streamFor(producer)}`,
          );
        }
      }
    }
    this.consumer = new StreamConsumer({
      redis: this.redis,
      ns: this.ns,
      group: this.config.serviceName,
      streams: [...streams],
      logger: this.logger,
      signingKeys: this.config.eventSigningKeys,
      allowUnsignedEvents: this.config.allowUnsignedEvents,
    });
    for (const h of handlers) this.consumer.on(h.meta.type, h.handler);
    await this.consumer.start();
    this.logger.info(
      { streams: [...streams], handlers: handlers.map((h) => h.meta.type) },
      'event consumer started',
    );
  }

  async beforeApplicationShutdown() {
    await this.consumer?.stop();
    await this.relay?.stop();
  }

  private discoverHandlers(): Array<{
    meta: OnEventMeta;
    handler: (e: EventEnvelope, d: DeliveryInfo) => Promise<void>;
  }> {
    const found: Array<{
      meta: OnEventMeta;
      handler: (e: EventEnvelope, d: DeliveryInfo) => Promise<void>;
    }> = [];
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== 'object') continue;
      const proto = Object.getPrototypeOf(instance) as object;
      for (const name of this.scanner.getAllMethodNames(proto)) {
        const method = instance[name] as (...args: unknown[]) => Promise<void>;
        const meta = this.reflector.get<OnEventMeta | undefined>(ON_EVENT, method);
        if (meta) found.push({ meta, handler: (e, d) => method.call(instance, e, d) });
      }
    }
    return found;
  }
}

@Global()
@Module({})
export class EventsModule {
  static forRoot(options: EventsModuleOptions = {}): DynamicModule {
    return {
      module: EventsModule,
      imports: [DiscoveryModule],
      providers: [{ provide: 'A5_EVENTS_OPTIONS', useValue: options }, EventBus, EventsLifecycle],
      exports: [EventBus],
    };
  }
}
