import { DynamicModule, Module } from '@nestjs/common';
import type { MediaConfig } from '../config.js';
import { DevStorageController } from './dev-storage.controller.js';

/**
 * Upload/download routes for the local storage driver. Registered only when STORAGE_DRIVER=local
 * (which configuration refuses in staging/production); with S3 the routes do not exist.
 */
@Module({})
export class DevStorageModule {
  static register(config: MediaConfig): DynamicModule {
    return {
      module: DevStorageModule,
      controllers: config.media.storage.driver === 'local' ? [DevStorageController] : [],
    };
  }
}
