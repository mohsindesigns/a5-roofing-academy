import { LocalDiskStorage, S3Storage, type ObjectStorage } from '@a5/storage';
import type { StorageConfig } from '../config.js';

export function createObjectStorage(config: StorageConfig): ObjectStorage {
  if (config.driver === 'local') {
    return new LocalDiskStorage({ root: config.root, publicBaseUrl: config.publicBaseUrl, signingSecret: config.signingSecret });
  }
  return new S3Storage({
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint,
    publicEndpoint: config.publicEndpoint,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle,
  });
}
