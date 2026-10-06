import type { z } from 'zod';
import type { certification } from '@a5/contracts';
import { ValidationError } from '@a5/nest-kit';
import type { CertificationAssetsTable, DbOrTrx } from '../database/index.js';
import { personRef } from './timeline.js';

export interface AssetRow {
  id: string;
  storage_key: string;
  content_type: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  byte_size: number;
  sha256: string;
}

export interface CurrentImage {
  versionId: string;
  version: number;
  asset: AssetRow;
  createdAt: Date;
  createdBy: string | null;
  createdByName: string | null;
}

const assetColumns = [
  'a.id',
  'a.storage_key',
  'a.content_type',
  'a.width',
  'a.height',
  'a.byte_size',
  'a.sha256',
] as const;

/** Latest signature image of each signatory. */
export async function currentSignatures(
  db: DbOrTrx,
  signatoryIds: readonly string[],
): Promise<Map<string, CurrentImage>> {
  if (signatoryIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('signatory_signatures as s')
    .innerJoin('certification_assets as a', 'a.id', 's.asset_id')
    .select([
      's.id as version_id',
      's.version',
      's.signatory_id as owner_id',
      's.created_at',
      's.created_by',
      's.created_by_name',
      ...assetColumns,
    ])
    .where('s.signatory_id', 'in', [...signatoryIds])
    .where(({ eb, selectFrom }) =>
      eb(
        's.version',
        '=',
        selectFrom('signatory_signatures as s2')
          .select((e) => e.fn.max('s2.version').as('v'))
          .whereRef('s2.signatory_id', '=', 's.signatory_id'),
      ),
    )
    .execute();
  return new Map(rows.map((r) => [r.owner_id, toCurrent(r)]));
}

/** Latest image of each stamp. */
export async function currentStampImages(
  db: DbOrTrx,
  stampIds: readonly string[],
): Promise<Map<string, CurrentImage>> {
  if (stampIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('stamp_images as s')
    .innerJoin('certification_assets as a', 'a.id', 's.asset_id')
    .select([
      's.id as version_id',
      's.version',
      's.stamp_id as owner_id',
      's.created_at',
      's.created_by',
      's.created_by_name',
      ...assetColumns,
    ])
    .where('s.stamp_id', 'in', [...stampIds])
    .where(({ eb, selectFrom }) =>
      eb(
        's.version',
        '=',
        selectFrom('stamp_images as s2')
          .select((e) => e.fn.max('s2.version').as('v'))
          .whereRef('s2.stamp_id', '=', 's.stamp_id'),
      ),
    )
    .execute();
  return new Map(rows.map((r) => [r.owner_id, toCurrent(r)]));
}

function toCurrent(
  r: AssetRow & {
    version_id: string;
    version: number;
    created_at: Date;
    created_by: string | null;
    created_by_name: string | null;
  },
): CurrentImage {
  return {
    versionId: r.version_id,
    version: r.version,
    createdAt: r.created_at,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    asset: {
      id: r.id,
      storage_key: r.storage_key,
      content_type: r.content_type,
      width: r.width,
      height: r.height,
      byte_size: r.byte_size,
      sha256: r.sha256,
    },
  };
}

export async function assetsByIds(
  db: DbOrTrx,
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, AssetRow & { purpose: CertificationAssetsTable['purpose'] }>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom('certification_assets as a')
    .select([...assetColumns, 'a.purpose'])
    .where('a.organization_id', '=', organizationId)
    .where('a.id', 'in', [...ids])
    .execute();
  return new Map(rows.map((r) => [r.id, r]));
}

/** Template images must be uploaded background/logo/badge images of the same organization. */
export async function assertDesignAssets(
  db: DbOrTrx,
  organizationId: string,
  design: certification.TemplateDesign,
  path = 'design',
): Promise<void> {
  const problems: Array<{ path: string; message: string }> = [];
  const ids = [
    ...(design.theme.backgroundImageAssetId
      ? [{ id: design.theme.backgroundImageAssetId, path: `${path}.theme.backgroundImageAssetId` }]
      : []),
    ...design.elements.flatMap((el, i) =>
      el.assetId && (el.type === 'image' || el.type === 'logo')
        ? [{ id: el.assetId, path: `${path}.elements.${i}.assetId` }]
        : [],
    ),
  ];
  const assets = await assetsByIds(
    db,
    organizationId,
    ids.map((i) => i.id),
  );
  for (const ref of ids) {
    const asset = assets.get(ref.id);
    if (!asset || !['background', 'logo', 'badge'].includes(asset.purpose)) {
      problems.push({
        path: ref.path,
        message: 'Choose an uploaded background, logo or badge image.',
      });
    }
  }
  if (problems.length) throw new ValidationError(problems);
}

export type ImageVersionDto = z.infer<typeof certification.imageVersionSchema>;

export function imageVersionDto(img: CurrentImage, previewUrl: string | null): ImageVersionDto {
  return {
    id: img.versionId,
    version: img.version,
    assetId: img.asset.id,
    contentType: img.asset.content_type,
    width: img.asset.width,
    height: img.asset.height,
    byteSize: img.asset.byte_size,
    sha256: img.asset.sha256,
    uploadedAt: img.createdAt.toISOString(),
    uploadedBy: personRef(img.createdBy, img.createdByName),
    previewUrl,
  };
}

/** True when a signatory/stamp may be used for a certification today (active, in effect, allowed). */
export function inEffect(
  row: { active: boolean; effective_from: string | null; effective_to: string | null },
  today: string,
): boolean {
  if (!row.active) return false;
  if (row.effective_from && row.effective_from > today) return false;
  if (row.effective_to && row.effective_to < today) return false;
  return true;
}
