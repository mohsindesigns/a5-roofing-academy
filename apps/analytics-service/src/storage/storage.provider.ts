import { resolve } from 'node:path';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { HealthRegistry } from '@a5/nest-kit';
import { LocalDiskStorage, S3Storage, type ObjectStorage } from '@a5/storage';
import { ANALYTICS_CONFIG, type AnalyticsConfig } from '../config.js';

/** Object storage for export files: S3-compatible in deployed environments, local disk in development. */
@Injectable()
export class StorageProvider implements OnModuleInit {
  readonly storage: ObjectStorage;
  /** Set when the local driver is active; its signed links are served by the reports file route. */
  readonly local: LocalDiskStorage | null;

  constructor(
    @Inject(ANALYTICS_CONFIG) config: AnalyticsConfig,
    private readonly health: HealthRegistry,
  ) {
    const s = config.storage;
    if (s.driver === 's3') {
      this.local = null;
      this.storage = new S3Storage({
        bucket: s.s3.bucket,
        region: s.s3.region,
        endpoint: s.s3.endpoint,
        publicEndpoint: s.s3.publicEndpoint,
        accessKeyId: s.s3.accessKeyId,
        secretAccessKey: s.s3.secretAccessKey,
      });
    } else {
      this.local = new LocalDiskStorage({ root: resolve(s.localRoot), publicBaseUrl: s.publicBaseUrl, signingSecret: s.signingSecret });
      this.storage = this.local;
    }
  }

  onModuleInit() {
    this.health.register('storage', () => this.storage.ping());
  }
}
