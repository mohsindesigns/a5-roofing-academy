import {
  BeforeApplicationShutdown,
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import {
  Cache,
  DistributedLock,
  QueueFactory,
  RateLimiter,
  RealtimeBus,
  RedisNamespace,
  createRedis,
  type Redis,
} from '@a5/messaging';
import type { Logger } from '@a5/observability';
import { HealthRegistry } from './health.js';
import { LOGGER, REDIS, SERVICE_CONFIG } from './tokens.js';
import type { ServiceRuntimeConfig } from './config.js';

export const InjectRedis = () => Inject(REDIS);

@Injectable()
class RedisLifecycle implements OnModuleInit, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly health: HealthRegistry,
    private readonly queues: QueueFactory,
    private readonly realtime: RealtimeBus,
  ) {}

  onModuleInit() {
    this.health.register('redis', async () => {
      await this.redis.ping();
    });
  }

  /** Stop job workers before the database pool closes. */
  async beforeApplicationShutdown() {
    await this.queues.close();
    await this.realtime.close();
  }

  onApplicationShutdown() {
    this.redis.disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [SERVICE_CONFIG],
      useFactory: (config: ServiceRuntimeConfig) => createRedis(config.redisUrl),
    },
    {
      provide: RedisNamespace,
      inject: [SERVICE_CONFIG],
      useFactory: (config: ServiceRuntimeConfig) => new RedisNamespace(config.redisNamespace),
    },
    {
      provide: Cache,
      inject: [REDIS, RedisNamespace],
      useFactory: (r: Redis, ns: RedisNamespace) => new Cache(r, ns),
    },
    {
      provide: DistributedLock,
      inject: [REDIS, RedisNamespace],
      useFactory: (r: Redis, ns: RedisNamespace) => new DistributedLock(r, ns),
    },
    {
      provide: RateLimiter,
      inject: [REDIS, RedisNamespace],
      useFactory: (r: Redis, ns: RedisNamespace) => new RateLimiter(r, ns),
    },
    {
      provide: RealtimeBus,
      inject: [REDIS, RedisNamespace],
      useFactory: (r: Redis, ns: RedisNamespace) => new RealtimeBus(r, ns),
    },
    {
      provide: QueueFactory,
      inject: [SERVICE_CONFIG, LOGGER],
      useFactory: (config: ServiceRuntimeConfig, logger: Logger) =>
        new QueueFactory({
          redisUrl: config.redisUrl,
          prefix: `${config.redisNamespace}:bull`,
          logger,
        }),
    },
    RedisLifecycle,
  ],
  exports: [REDIS, RedisNamespace, Cache, DistributedLock, RateLimiter, RealtimeBus, QueueFactory],
})
export class RedisModule {}
