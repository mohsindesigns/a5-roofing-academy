import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { media } from '@a5/contracts';
import { isUniqueViolation, sql } from '@a5/database';
import { ConflictError, EventBus, InjectDb, NotFoundError, PreconditionError, ValidationError } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import type { Db, Trx } from '../database/index.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { MediaReadService, type AssetRow } from './media-read.service.js';

@Injectable()
export class LibraryService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly read: MediaReadService,
    private readonly uploads: UploadsService,
    private readonly events: EventBus,
  ) {}

  private async editable(p: Principal, id: string, trx: Db | Trx = this.db): Promise<AssetRow> {
    const asset = await this.read.get(p.organizationId, id, trx);
    if (asset.status === 'archived') throw new PreconditionError('MEDIA_ARCHIVED', 'Archived media cannot be edited.');
    return asset;
  }

  private async video(p: Principal, id: string, trx: Db | Trx = this.db): Promise<AssetRow> {
    const asset = await this.editable(p, id, trx);
    if (asset.kind !== 'video') throw new PreconditionError('NOT_A_VIDEO', 'Chapters, captions and transcripts can only be added to videos.');
    return asset;
  }

  async update(p: Principal, id: string, input: media.UpdateMediaRequest): Promise<media.MediaAssetDetail> {
    await this.db.transaction().execute(async (trx) => {
      const before = await this.editable(p, id, trx);
      await trx
        .updateTable('media_assets')
        .set({
          ...(input.title !== undefined && { title: input.title }),
          ...(input.description !== undefined && { description: input.description }),
          updated_by: p.userId,
        })
        .where('id', '=', id)
        .execute();
      await this.events.audit(trx, {
        action: 'media.updated',
        resourceType: 'media_asset',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { title: before.title, description: before.description },
        after: { title: input.title ?? before.title, description: input.description !== undefined ? input.description : before.description },
      });
    });
    return this.read.detail(p.organizationId, id);
  }

  /** Soft delete. Ready media stays playable for lessons that still reference it. */
  async archive(p: Principal, id: string): Promise<media.MediaAssetDetail> {
    await this.db.transaction().execute(async (trx) => {
      const asset = await this.read.get(p.organizationId, id, trx);
      if (asset.status === 'archived') return;
      await trx
        .updateTable('media_assets')
        .set({ status: 'archived', archived_at: new Date(), updated_by: p.userId })
        .where('id', '=', id)
        .execute();
      // An archived caption file is no longer offered to viewers of its video.
      if (asset.kind === 'caption') await trx.deleteFrom('media_captions').where('caption_asset_id', '=', id).execute();
      await this.events.audit(trx, {
        action: 'media.archived',
        resourceType: 'media_asset',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { status: asset.status },
        after: { status: 'archived' },
      });
    });
    return this.read.detail(p.organizationId, id);
  }

  // ---------------------------------------------------------------- chapters

  private async renumberChapters(trx: Trx, assetId: string): Promise<void> {
    await sql`
      update media_chapters c set position = r.rn
      from (select id, row_number() over (order by start_seconds, id) as rn from media_chapters where asset_id = ${assetId}) r
      where c.id = r.id and c.position <> r.rn
    `.execute(trx);
  }

  private assertWithinDuration(asset: AssetRow, startSeconds: number | undefined): void {
    if (startSeconds !== undefined && asset.duration_seconds !== null && startSeconds >= asset.duration_seconds) {
      throw new ValidationError([{ path: 'startSeconds', message: `Chapters must start before the end of the video (${asset.duration_seconds} s).` }]);
    }
  }

  private async withChapterConflicts<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('CHAPTER_EXISTS', 'Another chapter already starts at this time. Choose a different start time.');
      throw err;
    }
  }

  async createChapter(p: Principal, assetId: string, input: media.CreateChapterRequest): Promise<{ items: media.Chapter[] }> {
    await this.withChapterConflicts(() =>
      this.db.transaction().execute(async (trx) => {
        const asset = await this.video(p, assetId, trx);
        this.assertWithinDuration(asset, input.startSeconds);
        const id = uuidv7();
        await trx
          .insertInto('media_chapters')
          .values({ id, asset_id: assetId, start_seconds: input.startSeconds, title: input.title, position: 1, created_by: p.userId, updated_by: p.userId })
          .execute();
        await this.renumberChapters(trx, assetId);
        await this.events.audit(trx, {
          action: 'media.chapter_created',
          resourceType: 'media_asset',
          resourceId: assetId,
          actorDisplay: p.displayName,
          after: { chapterId: id, startSeconds: input.startSeconds, title: input.title },
        });
      }),
    );
    return { items: await this.read.chapters(assetId) };
  }

  async updateChapter(p: Principal, assetId: string, chapterId: string, input: media.UpdateChapterRequest): Promise<{ items: media.Chapter[] }> {
    await this.withChapterConflicts(() =>
      this.db.transaction().execute(async (trx) => {
        const asset = await this.video(p, assetId, trx);
        this.assertWithinDuration(asset, input.startSeconds);
        const before = await trx.selectFrom('media_chapters').selectAll().where('id', '=', chapterId).where('asset_id', '=', assetId).executeTakeFirst();
        if (!before) throw new NotFoundError('Chapter');
        await trx
          .updateTable('media_chapters')
          .set({
            ...(input.startSeconds !== undefined && { start_seconds: input.startSeconds }),
            ...(input.title !== undefined && { title: input.title }),
            updated_by: p.userId,
          })
          .where('id', '=', chapterId)
          .execute();
        await this.renumberChapters(trx, assetId);
        await this.events.audit(trx, {
          action: 'media.chapter_updated',
          resourceType: 'media_asset',
          resourceId: assetId,
          actorDisplay: p.displayName,
          before: { chapterId, startSeconds: before.start_seconds, title: before.title },
          after: { chapterId, startSeconds: input.startSeconds ?? before.start_seconds, title: input.title ?? before.title },
        });
      }),
    );
    return { items: await this.read.chapters(assetId) };
  }

  async deleteChapter(p: Principal, assetId: string, chapterId: string): Promise<{ items: media.Chapter[] }> {
    await this.db.transaction().execute(async (trx) => {
      await this.video(p, assetId, trx);
      const deleted = await trx.deleteFrom('media_chapters').where('id', '=', chapterId).where('asset_id', '=', assetId).returning(['title', 'start_seconds']).executeTakeFirst();
      if (!deleted) throw new NotFoundError('Chapter');
      await this.renumberChapters(trx, assetId);
      await this.events.audit(trx, {
        action: 'media.chapter_deleted',
        resourceType: 'media_asset',
        resourceId: assetId,
        actorDisplay: p.displayName,
        before: { chapterId, startSeconds: deleted.start_seconds, title: deleted.title },
      });
    });
    return { items: await this.read.chapters(assetId) };
  }

  // ---------------------------------------------------------------- captions

  async createCaptionUpload(p: Principal, videoId: string, input: media.CreateCaptionUploadRequest) {
    const video = await this.video(p, videoId);
    const result = await this.uploads.create(p, {
      kind: 'caption',
      title: `${video.title} — ${input.label}`.slice(0, 200),
      description: null,
      filename: input.filename,
      mimeType: 'text/vtt',
      sizeBytes: input.sizeBytes,
      caption: { videoAssetId: videoId, language: input.language, label: input.label, isDefault: input.isDefault },
    });
    return { ...result, captionId: result.captionId! };
  }

  async updateCaption(p: Principal, videoId: string, captionId: string, input: media.UpdateCaptionRequest): Promise<media.MediaAssetDetail> {
    try {
      await this.db.transaction().execute(async (trx) => {
        await this.video(p, videoId, trx);
        const before = await trx.selectFrom('media_captions').selectAll().where('id', '=', captionId).where('asset_id', '=', videoId).executeTakeFirst();
        if (!before) throw new NotFoundError('Caption');
        if (input.isDefault) {
          await trx.updateTable('media_captions').set({ is_default: false }).where('asset_id', '=', videoId).where('id', '!=', captionId).where('is_default', '=', true).execute();
        }
        await trx
          .updateTable('media_captions')
          .set({ ...(input.label !== undefined && { label: input.label }), ...(input.isDefault !== undefined && { is_default: input.isDefault }) })
          .where('id', '=', captionId)
          .execute();
        await this.events.audit(trx, {
          action: 'media.caption_updated',
          resourceType: 'media_asset',
          resourceId: videoId,
          actorDisplay: p.displayName,
          before: { captionId, label: before.label, isDefault: before.is_default },
          after: { captionId, label: input.label ?? before.label, isDefault: input.isDefault ?? before.is_default },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'media_captions_label_uq')) {
        throw new ConflictError('CAPTION_EXISTS', 'This video already has captions with that language and label.');
      }
      throw err;
    }
    return this.read.detail(p.organizationId, videoId);
  }

  /** Remove captions from a video; the caption file is archived, not destroyed. */
  async deleteCaption(p: Principal, videoId: string, captionId: string): Promise<media.MediaAssetDetail> {
    await this.db.transaction().execute(async (trx) => {
      await this.video(p, videoId, trx);
      const caption = await trx.deleteFrom('media_captions').where('id', '=', captionId).where('asset_id', '=', videoId).returningAll().executeTakeFirst();
      if (!caption) throw new NotFoundError('Caption');
      await trx
        .updateTable('media_assets')
        .set({ status: 'archived', archived_at: new Date(), updated_by: p.userId })
        .where('id', '=', caption.caption_asset_id)
        .where('status', '!=', 'archived')
        .execute();
      await this.events.audit(trx, {
        action: 'media.caption_removed',
        resourceType: 'media_asset',
        resourceId: videoId,
        actorDisplay: p.displayName,
        before: { captionId, language: caption.language, label: caption.label },
      });
    });
    return this.read.detail(p.organizationId, videoId);
  }

  // ---------------------------------------------------------------- transcripts

  async setTranscript(p: Principal, videoId: string, input: media.SetTranscriptRequest): Promise<media.MediaAssetDetail> {
    const segments = [...input.segments].sort((a, b) => a.startSeconds - b.startSeconds);
    await this.db.transaction().execute(async (trx) => {
      const asset = await this.video(p, videoId, trx);
      if (asset.duration_seconds !== null) {
        const late = segments.findIndex((s) => s.startSeconds >= asset.duration_seconds! + 1);
        if (late !== -1) {
          throw new ValidationError([{ path: `segments.${late}.startSeconds`, message: `Segments must start before the end of the video (${asset.duration_seconds} s).` }]);
        }
      }
      await trx
        .insertInto('media_transcripts')
        .values({ id: uuidv7(), asset_id: videoId, language: input.language, segments: JSON.stringify(segments) as never, updated_by: p.userId })
        .onConflict((oc) =>
          oc.columns(['asset_id', 'language']).doUpdateSet((eb) => ({ segments: eb.ref('excluded.segments'), updated_by: eb.ref('excluded.updated_by') })),
        )
        .execute();
      await this.events.audit(trx, {
        action: 'media.transcript_set',
        resourceType: 'media_asset',
        resourceId: videoId,
        actorDisplay: p.displayName,
        after: { language: input.language, segments: segments.length },
      });
    });
    return this.read.detail(p.organizationId, videoId);
  }
}
