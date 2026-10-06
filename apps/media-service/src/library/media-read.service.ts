import { Inject, Injectable } from '@nestjs/common';
import type { media } from '@a5/contracts';
import { likePattern, paginate, type Page, type Selectable } from '@a5/database';
import { InjectDb, NotFoundError } from '@a5/nest-kit';
import { MEDIA_CONFIG, type MediaConfig } from '../config.js';
import type { Db, DbOrTrx, MediaAssetsTable } from '../database/index.js';
import { URL_SIGNER } from '../common/tokens.js';
import type { UrlSigner } from '../storage/url-signer.js';

export type AssetRow = Selectable<MediaAssetsTable>;

const SORTS = {
  title: 'a.title',
  createdAt: 'a.created_at',
  updatedAt: 'a.updated_at',
  sizeBytes: 'a.size_bytes',
  durationSeconds: 'a.duration_seconds',
} as const;

export interface MediaListFilters {
  q?: string;
  kind?: media.MediaKind[];
  status?: media.MediaStatus[];
  includeArchived?: boolean;
  sort?: string;
  page: number;
  pageSize: number;
}

/** Ready assets stay playable after archiving, so lessons that still reference them keep working. */
export function isPlayable(row: Pick<AssetRow, 'status' | 'ready_at'>): boolean {
  return row.status === 'ready' || (row.status === 'archived' && row.ready_at !== null);
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Queries and DTO mapping for media assets. Every query is scoped to one organization. */
@Injectable()
export class MediaReadService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(URL_SIGNER) private readonly signer: UrlSigner,
    @Inject(MEDIA_CONFIG) private readonly config: MediaConfig,
  ) {}

  async find(
    organizationId: string,
    id: string,
    executor: DbOrTrx = this.db,
  ): Promise<AssetRow | undefined> {
    return executor
      .selectFrom('media_assets')
      .selectAll()
      .where('id', '=', id)
      .where('organization_id', '=', organizationId)
      .executeTakeFirst();
  }

  async get(organizationId: string, id: string, executor: DbOrTrx = this.db): Promise<AssetRow> {
    const row = await this.find(organizationId, id, executor);
    if (!row) throw new NotFoundError('Media');
    return row;
  }

  sign(
    key: string,
    options: { downloadName?: string; contentType?: string; expiresInSeconds?: number } = {},
  ): Promise<string> {
    return this.signer.sign(key, {
      expiresInSeconds: options.expiresInSeconds ?? this.config.media.signedUrlTtlSeconds,
      ...options,
    });
  }

  async summary(row: AssetRow): Promise<media.MediaAssetSummary> {
    const thumbnailKey = isPlayable(row) ? row.thumbnail_key : null;
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      description: row.description,
      originalFilename: row.original_filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      status: row.status,
      scanStatus: row.scan_status,
      durationSeconds: row.duration_seconds,
      width: row.width,
      height: row.height,
      thumbnailUrl: thumbnailKey ? await this.sign(thumbnailKey) : null,
      error: row.error,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      readyAt: iso(row.ready_at),
      archivedAt: iso(row.archived_at),
    };
  }

  async list(organizationId: string, f: MediaListFilters): Promise<Page<media.MediaAssetSummary>> {
    let query = this.db
      .selectFrom('media_assets as a')
      .selectAll('a')
      .where('a.organization_id', '=', organizationId);
    // Caption files are managed from their video; they only appear when asked for explicitly.
    query = f.kind?.length
      ? query.where('a.kind', 'in', f.kind)
      : query.where('a.kind', '!=', 'caption');
    if (f.status?.length) query = query.where('a.status', 'in', f.status);
    else if (!f.includeArchived) query = query.where('a.status', '!=', 'archived');
    if (f.q) {
      const pattern = likePattern(f.q);
      query = query.where((eb) =>
        eb.or([
          eb('a.title', 'ilike', pattern),
          eb('a.original_filename', 'ilike', pattern),
          eb('a.description', 'ilike', pattern),
        ]),
      );
    }
    const desc = f.sort ? f.sort.startsWith('-') : true;
    const column =
      SORTS[(f.sort?.replace(/^-/, '') ?? 'createdAt') as keyof typeof SORTS] ?? SORTS.createdAt;
    query = query.orderBy(column, desc ? 'desc' : 'asc').orderBy('a.id', desc ? 'desc' : 'asc');
    const page = await paginate(query, { page: f.page, pageSize: f.pageSize });
    return {
      ...page,
      items: await Promise.all(page.items.map((r) => this.summary(r as AssetRow))),
    };
  }

  async detail(organizationId: string, id: string): Promise<media.MediaAssetDetail> {
    const row = await this.get(organizationId, id);
    const [renditions, captions, chapters, transcripts] = await Promise.all([
      this.db
        .selectFrom('media_renditions')
        .selectAll()
        .where('asset_id', '=', id)
        .orderBy('height')
        .execute(),
      this.captions(id),
      this.chapters(id),
      this.db
        .selectFrom('media_transcripts')
        .selectAll()
        .where('asset_id', '=', id)
        .orderBy('language')
        .execute(),
    ]);
    const playable = isPlayable(row);
    return {
      ...(await this.summary(row)),
      checksum: row.checksum,
      parentAssetId: row.parent_asset_id,
      downloadUrl: playable
        ? await this.sign(row.storage_key, { downloadName: row.original_filename })
        : null,
      renditions: renditions.map((r) => ({
        name: r.name,
        width: r.width,
        height: r.height,
        bandwidth: r.bandwidth,
        codecs: r.codecs,
      })),
      captions: await Promise.all(
        captions.map(async (c) => ({
          id: c.id,
          captionAssetId: c.caption_asset_id,
          language: c.language,
          label: c.label,
          isDefault: c.is_default,
          status: c.status,
          url:
            c.status === 'ready'
              ? await this.sign(c.storage_key, { contentType: 'text/vtt' })
              : null,
        })),
      ),
      chapters,
      transcripts: transcripts.map((t) => ({
        language: t.language,
        segments: t.segments,
        updatedAt: t.updated_at.toISOString(),
      })),
    };
  }

  /** Captions of a video with the processing status of their WebVTT file. */
  captions(assetId: string) {
    return this.db
      .selectFrom('media_captions as c')
      .innerJoin('media_assets as f', 'f.id', 'c.caption_asset_id')
      .select([
        'c.id',
        'c.caption_asset_id',
        'c.language',
        'c.label',
        'c.is_default',
        'c.storage_key',
        'f.status',
      ])
      .where('c.asset_id', '=', assetId)
      .where('f.status', '!=', 'archived')
      .orderBy('c.is_default', 'desc')
      .orderBy('c.language')
      .orderBy('c.label')
      .execute();
  }

  async chapters(assetId: string, executor: DbOrTrx = this.db): Promise<media.Chapter[]> {
    const rows = await executor
      .selectFrom('media_chapters')
      .select(['id', 'start_seconds', 'title', 'position'])
      .where('asset_id', '=', assetId)
      .orderBy('position')
      .execute();
    return rows.map((c) => ({
      id: c.id,
      startSeconds: c.start_seconds,
      title: c.title,
      position: c.position,
    }));
  }
}
