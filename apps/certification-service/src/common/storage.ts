import { Inject } from '@nestjs/common';
import { LocalDiskStorage, S3Storage, type ObjectStorage } from '@a5/storage';
import type { CertificationConfig } from '../config.js';

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');
export const InjectStorage = () => Inject(OBJECT_STORAGE);

export function createObjectStorage(config: CertificationConfig['storage']): ObjectStorage {
  if (config.driver === 'local') {
    return new LocalDiskStorage({
      root: config.localRoot,
      publicBaseUrl: config.filesBaseUrl,
      signingSecret: config.signingSecret,
    });
  }
  return new S3Storage({
    bucket: config.s3.bucket,
    region: config.s3.region,
    endpoint: config.s3.endpoint,
    publicEndpoint: config.s3.publicEndpoint,
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
    forcePathStyle: config.s3.forcePathStyle,
  });
}

/** Generated object keys. User file names are never part of a key. */
export const storageKeys = {
  asset: (organizationId: string, assetId: string, ext: string) =>
    `certification/${organizationId}/assets/${assetId}.${ext}`,
  certificatePrefix: (organizationId: string, certificateId: string) =>
    `certification/${organizationId}/certificates/${certificateId}/`,
  certificateFile: (organizationId: string, certificateId: string, name: string) =>
    `certification/${organizationId}/certificates/${certificateId}/${name}`,
  preview: (organizationId: string, hash: string) =>
    `certification/${organizationId}/previews/${hash}.pdf`,
};

export function extensionFor(contentType: string): string {
  return contentType === 'image/jpeg' ? 'jpg' : 'png';
}
