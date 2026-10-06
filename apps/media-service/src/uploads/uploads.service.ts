import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { media } from '@a5/contracts';
import { isUniqueViolation } from '@a5/database';
import { mediaEvents } from '@a5/events';
import {
  ConflictError,
  EventBus,
  InjectDb,
  LOGGER,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '@a5/nest-kit';
import { uuidv7, type Logger } from '@a5/observability';
import { validateFileContent, type ObjectStorage } from '@a5/storage';
import { OBJECT_STORAGE } from '../common/tokens.js';
import { MEDIA_CONFIG, type MediaConfig } from '../config.js';
import type { Db, Trx } from '../database/index.js';
import { MediaReadService, type AssetRow } from '../library/media-read.service.js';
import { ProcessingQueue } from '../processing/processing.queue.js';
import { mediaKeys } from '../storage/keys.js';
import { formatBytes, sanitizeFilename, validateUpload } from './upload-policy.js';

const SNIFF_BYTES = 4096;

export interface CaptionUploadInput {
  videoAssetId: string;
  language: string;
  label: string;
  isDefault: boolean;
}

@Injectable()
export class UploadsService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MEDIA_CONFIG) private readonly config: MediaConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly events: EventBus,
    private readonly read: MediaReadService,
    private readonly processing: ProcessingQueue,
  ) {}

  /** Register an upload and hand out a direct-to-storage upload target. */
  async create(
    p: Principal,
    input: media.CreateUploadRequest,
  ): Promise<media.CreateUploadResponse & { captionId?: string }> {
    const errors = validateUpload(input, this.config.media.limits);
    if (errors.length) throw new ValidationError(errors);
    const caption = input.kind === 'caption' ? input.caption : null;
    if (caption) {
      const video = await this.read.find(p.organizationId, caption.videoAssetId);
      if (!video || video.status === 'archived')
        throw new ValidationError([
          { path: 'caption.videoAssetId', message: 'Choose a video from the media library.' },
        ]);
      if (video.kind !== 'video')
        throw new ValidationError([
          { path: 'caption.videoAssetId', message: 'Captions can only be added to videos.' },
        ]);
    }

    const id = uuidv7();
    const key = mediaKeys.source(p.organizationId, id);
    const filename = sanitizeFilename(input.filename);
    let captionId: string | undefined;
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('media_assets')
          .values({
            id,
            organization_id: p.organizationId,
            kind: input.kind,
            title: input.title,
            description: input.description ?? null,
            original_filename: filename,
            storage_key: key,
            mime_type: input.mimeType,
            size_bytes: input.sizeBytes,
            checksum: null,
            status: 'awaiting_upload',
            duration_seconds: null,
            width: null,
            height: null,
            hls_master_key: null,
            thumbnail_key: null,
            error: null,
            parent_asset_id: caption?.videoAssetId ?? null,
            uploaded_at: null,
            ready_at: null,
            archived_at: null,
            created_by: p.userId,
            updated_by: p.userId,
          })
          .execute();
        if (caption) captionId = await this.linkCaption(trx, p, id, key, caption);
        await this.events.audit(trx, {
          action: 'media.upload_started',
          resourceType: 'media_asset',
          resourceId: id,
          actorDisplay: p.displayName,
          after: {
            kind: input.kind,
            title: input.title,
            filename,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
          },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'media_captions_label_uq')) {
        throw new ConflictError(
          'CAPTION_EXISTS',
          'This video already has captions with that language and label. Use a different label or remove the existing captions.',
        );
      }
      throw err;
    }

    const maxBytes = this.config.media.limits[input.kind];
    const upload = await this.storage.createUploadTarget(key, {
      contentType: input.mimeType,
      maxBytes,
      expiresInSeconds: this.config.media.uploadUrlTtlSeconds,
    });
    return { assetId: id, upload, maxBytes, ...(captionId && { captionId }) };
  }

  private async linkCaption(
    trx: Trx,
    p: Principal,
    captionAssetId: string,
    key: string,
    caption: CaptionUploadInput,
  ): Promise<string> {
    const captionId = uuidv7();
    if (caption.isDefault) {
      await trx
        .updateTable('media_captions')
        .set({ is_default: false })
        .where('asset_id', '=', caption.videoAssetId)
        .where('is_default', '=', true)
        .execute();
    }
    await trx
      .insertInto('media_captions')
      .values({
        id: captionId,
        asset_id: caption.videoAssetId,
        caption_asset_id: captionAssetId,
        language: caption.language,
        label: caption.label,
        storage_key: key,
        is_default: caption.isDefault,
        created_by: p.userId,
      })
      .execute();
    return captionId;
  }

  /**
   * The client finished uploading: verify the stored object (existence, size, magic bytes) and queue
   * processing. Idempotent for uploads that were already accepted.
   */
  async complete(p: Principal, id: string): Promise<media.MediaAssetDetail> {
    const asset = await this.read.get(p.organizationId, id);
    switch (asset.status) {
      case 'awaiting_upload':
        break;
      case 'uploaded':
      case 'scanning':
      case 'processing':
      case 'ready':
        return this.read.detail(p.organizationId, id);
      case 'rejected':
      case 'failed':
        throw new PreconditionError(
          'UPLOAD_REJECTED',
          asset.error ?? 'This upload was rejected. Start a new upload.',
          { assetId: id },
        );
      case 'archived':
        throw new NotFoundError('Media');
    }

    const head = await this.storage.headObject(asset.storage_key);
    if (!head) {
      throw new PreconditionError(
        'UPLOAD_NOT_FOUND',
        'The file has not been uploaded yet. Upload it, then try again.',
        { assetId: id },
      );
    }
    const limit = this.config.media.limits[asset.kind];
    if (head.size > limit)
      await this.reject(p, asset, `The file is larger than the allowed ${formatBytes(limit)}.`);
    if (head.size !== asset.size_bytes) {
      await this.reject(
        p,
        asset,
        `The uploaded file (${formatBytes(head.size)}) does not match the selected file (${formatBytes(asset.size_bytes)}). Upload it again.`,
      );
    }
    const bytes = await this.storage.getBytes(asset.storage_key, {
      start: 0,
      end: Math.min(head.size, SNIFF_BYTES) - 1,
    });
    const verdict = await validateFileContent(asset.kind, asset.mime_type, bytes);
    if (!verdict.ok) await this.reject(p, asset, verdict.reason);

    const accepted = await this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('media_assets')
        .set({ status: 'uploaded', uploaded_at: new Date(), updated_by: p.userId })
        .where('id', '=', id)
        .where('status', '=', 'awaiting_upload')
        .returning('id')
        .executeTakeFirst();
      if (!updated) return false;
      await this.events.audit(trx, {
        action: 'media.uploaded',
        resourceType: 'media_asset',
        resourceId: id,
        actorDisplay: p.displayName,
        after: { sizeBytes: head.size, mimeType: asset.mime_type },
      });
      return true;
    });
    if (accepted) {
      try {
        await this.processing.enqueue(id);
      } catch (err) {
        // The maintenance sweep re-enqueues uploads that never reached the queue.
        this.logger.error(
          { err, assetId: id },
          'could not enqueue media processing; it will be retried by the sweeper',
        );
      }
    }
    return this.read.detail(p.organizationId, id);
  }

  private async reject(p: Principal, asset: AssetRow, reason: string): Promise<never> {
    await this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('media_assets')
        .set({ status: 'rejected', error: reason, updated_by: p.userId })
        .where('id', '=', asset.id)
        .where('status', '=', 'awaiting_upload')
        .returning('id')
        .executeTakeFirst();
      if (!updated) return;
      await this.events.emit(
        trx,
        mediaEvents.assetFailed,
        { assetId: asset.id, title: asset.title, error: reason },
        { organizationId: asset.organization_id, subject: { type: 'media_asset', id: asset.id } },
      );
      await this.events.audit(trx, {
        action: 'media.upload_rejected',
        resourceType: 'media_asset',
        resourceId: asset.id,
        actorDisplay: p.displayName,
        reason,
      });
    });
    // Rejected content is never kept.
    await this.storage
      .deleteObject(asset.storage_key)
      .catch((err: unknown) =>
        this.logger.warn({ err, assetId: asset.id }, 'could not delete rejected upload'),
      );
    throw new PreconditionError('UPLOAD_REJECTED', reason, { assetId: asset.id });
  }
}
