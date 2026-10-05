import { Get } from '@nestjs/common';
import { z } from 'zod';
import { media } from '@a5/contracts';
import { InjectDb, InternalController, NotFoundError, ZParam, ZQuery, ZResponse } from '@a5/nest-kit';
import type { Db } from '../database/index.js';

type Row = { id: string; organization_id: string; title: string; kind: media.MediaKind; status: media.MediaStatus; duration_seconds: number | null };

const toDto = (r: Row): media.InternalMediaAsset => ({
  id: r.id,
  organizationId: r.organization_id,
  title: r.title,
  kind: r.kind,
  status: r.status,
  durationSeconds: r.duration_seconds,
});

const idsQuery = z.object({
  ids: z
    .string()
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.uuid()).min(1).max(500)),
});

/** Service-to-service reads (e.g. learning-service validating lesson media). Never routed by the gateway. */
@InternalController('media')
export class MediaInternalController {
  constructor(@InjectDb() private readonly db: Db) {}

  @Get()
  @ZResponse(z.object({ items: z.array(media.internalMediaAssetSchema) }))
  async many(@ZQuery(idsQuery) q: { ids: string[] }) {
    const rows = await this.db
      .selectFrom('media_assets')
      .select(['id', 'organization_id', 'title', 'kind', 'status', 'duration_seconds'])
      .where('id', 'in', q.ids)
      .execute();
    return { items: rows.map(toDto) };
  }

  @Get(':id')
  @ZResponse(media.internalMediaAssetSchema)
  async one(@ZParam('id') id: string) {
    const row = await this.db
      .selectFrom('media_assets')
      .select(['id', 'organization_id', 'title', 'kind', 'status', 'duration_seconds'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Media');
    return toDto(row);
  }
}
