import { DynamicModule, Global, Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { HealthRegistry } from '@a5/nest-kit';
import type { ObjectStorage } from '@a5/storage';
import { CERTIFICATION_CONFIG, type CertificationConfig } from '../config.js';
import { AccessService } from './access.js';
import { RecipientResolver } from './recipients.js';
import { OBJECT_STORAGE, createObjectStorage } from './storage.js';

@Injectable()
class StorageHealth implements OnModuleInit {
  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly health: HealthRegistry,
  ) {}

  onModuleInit() {
    this.health.register('storage', () => this.storage.ping());
  }
}

/** Configuration, object storage and cross-feature helpers shared by every certification module. */
@Global()
@Module({})
export class CommonModule {
  static register(config: CertificationConfig, storage?: ObjectStorage): DynamicModule {
    return {
      module: CommonModule,
      providers: [
        { provide: CERTIFICATION_CONFIG, useValue: config },
        { provide: OBJECT_STORAGE, useValue: storage ?? createObjectStorage(config.storage) },
        StorageHealth,
        AccessService,
        RecipientResolver,
      ],
      exports: [CERTIFICATION_CONFIG, OBJECT_STORAGE, AccessService, RecipientResolver],
    };
  }
}
