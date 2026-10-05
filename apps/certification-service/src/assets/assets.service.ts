import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { EventBus, InjectDb, LOGGER, NotFoundError } from '@a5/nest-kit';
import { uuidv7, type Logger } from '@a5/observability';
import type { ObjectStorage } from '@a5/storage';
import { CERTIFICATION_CONFIG, type CertificationConfig } from '../config.js';
import type { AssetPurpose, Db, Trx } from '../database/index.js';
import { validateCertificateImage, type ValidatedImage } from '../common/images.js';
import { InjectStorage, extensionFor, storageKeys } from '../common/storage.js';
import { SignatoriesService, StampsService } from '../signatories/signatories.service.js';
import type { UploadedImage } from './upload.interceptor.js';

@Injectable()
export class AssetsService {
  constructor(
    @InjectDb() private readonly db: Db,
    @InjectStorage() private readonly storage: ObjectStorage,
    private readonly events: EventBus,
    private readonly signatories: SignatoriesService,
    private readonly stamps: StampsService,
    @Inject(CERTIFICATION_CONFIG) private readonly config: CertificationConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Validate and store an image, then record it inside `write`'s transaction. The object is removed
   * again when the transaction fails so no orphaned files remain.
   */
  private async store<T>(
    p: Principal,
    purpose: AssetPurpose,
    file: UploadedImage,
    write: (trx: Trx, assetId: string, image: ValidatedImage) => Promise<T>,
  ): Promise<T> {
    const image = await validateCertificateImage(file.buffer, file.mimetype, purpose);
    const assetId = uuidv7();
    const key = storageKeys.asset(p.organizationId, assetId, extensionFor(image.contentType));
    await this.storage.putObject(key, file.buffer, { contentType: image.contentType, contentLength: image.byteSize });
    try {
      return await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('certification_assets')
          .values({
            id: assetId,
            organization_id: p.organizationId,
            purpose,
            storage_key: key,
            content_type: image.contentType,
            byte_size: image.byteSize,
            width: image.width,
            height: image.height,
            sha256: image.sha256,
            original_filename: file.originalname ? file.originalname.slice(0, 200) : null,
            created_by: p.userId,
            created_by_name: p.displayName,
          })
          .execute();
        return write(trx, assetId, image);
      });
    } catch (err) {
      await this.storage.deleteObject(key).catch((cleanupErr: unknown) => this.logger.warn({ err: cleanupErr, key }, 'failed to remove orphaned upload'));
      throw err;
    }
  }

  /** New signature version. Issued certificates keep their own copies and never change. */
  async uploadSignature(p: Principal, signatoryId: string, file: UploadedImage) {
    await this.signatories.load(this.db, p, signatoryId);
    await this.store(p, 'signature', file, async (trx, assetId, image) => {
      await trx.selectFrom('signatories').select('id').where('id', '=', signatoryId).forUpdate().executeTakeFirstOrThrow();
      const last = await trx
        .selectFrom('signatory_signatures')
        .select((eb) => eb.fn.max('version').as('v'))
        .where('signatory_id', '=', signatoryId)
        .executeTakeFirst();
      const version = Number(last?.v ?? 0) + 1;
      await trx
        .insertInto('signatory_signatures')
        .values({ id: uuidv7(), signatory_id: signatoryId, version, asset_id: assetId, created_by: p.userId, created_by_name: p.displayName })
        .execute();
      await this.events.audit(trx, {
        action: 'signatory.signature_uploaded',
        resourceType: 'signatory',
        resourceId: signatoryId,
        actorDisplay: p.displayName,
        after: { version, assetId, width: image.width, height: image.height, sha256: image.sha256 },
      });
    });
    return this.signatories.get(p, signatoryId);
  }

  async uploadStampImage(p: Principal, stampId: string, file: UploadedImage) {
    await this.stamps.load(this.db, p, stampId);
    await this.store(p, 'stamp', file, async (trx, assetId, image) => {
      await trx.selectFrom('stamps').select('id').where('id', '=', stampId).forUpdate().executeTakeFirstOrThrow();
      const last = await trx.selectFrom('stamp_images').select((eb) => eb.fn.max('version').as('v')).where('stamp_id', '=', stampId).executeTakeFirst();
      const version = Number(last?.v ?? 0) + 1;
      await trx
        .insertInto('stamp_images')
        .values({ id: uuidv7(), stamp_id: stampId, version, asset_id: assetId, created_by: p.userId, created_by_name: p.displayName })
        .execute();
      await this.events.audit(trx, {
        action: 'stamp.image_uploaded',
        resourceType: 'stamp',
        resourceId: stampId,
        actorDisplay: p.displayName,
        after: { version, assetId, width: image.width, height: image.height, sha256: image.sha256 },
      });
    });
    return this.stamps.get(p, stampId);
  }

  /** Template background, logo or badge image. */
  async uploadImage(p: Principal, purpose: 'background' | 'logo' | 'badge', file: UploadedImage) {
    const id = await this.store(p, purpose, file, async (trx, assetId) => {
      await this.events.audit(trx, { action: 'certification_asset.uploaded', resourceType: 'certification_asset', resourceId: assetId, actorDisplay: p.displayName, after: { purpose } });
      return assetId;
    });
    return this.get(p, id);
  }

  async get(p: Principal, id: string) {
    const a = await this.db
      .selectFrom('certification_assets')
      .selectAll()
      .where('id', '=', id)
      .where('organization_id', '=', p.organizationId)
      .executeTakeFirst();
    if (!a) throw new NotFoundError('Image');
    return {
      id: a.id,
      purpose: a.purpose,
      contentType: a.content_type,
      width: a.width,
      height: a.height,
      byteSize: a.byte_size,
      sha256: a.sha256,
      createdAt: a.created_at.toISOString(),
      previewUrl: await this.storage.signedGetUrl(a.storage_key, { expiresInSeconds: this.config.certification.previewUrlTtlSeconds }),
    };
  }
}
