import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { certification } from '@a5/contracts';
import { likePattern, paginate, type Page } from '@a5/database';
import {
  EventBus,
  InjectDb,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import type { ObjectStorage } from '@a5/storage';
import { CERTIFICATION_CONFIG, type CertificationConfig } from '../config.js';
import type { Db, DbOrTrx, Trx } from '../database/index.js';
import {
  currentSignatures,
  currentStampImages,
  imageVersionDto,
  type CurrentImage,
  type ImageVersionDto,
} from '../common/artwork-repo.js';
import { InjectStorage } from '../common/storage.js';
import { personRef } from '../common/timeline.js';

type Signatory = certification.Signatory;
type Stamp = certification.Stamp;

interface SignatoryInput {
  name?: string;
  title?: string;
  department?: string | null;
  userId?: string | null;
  active?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  allowedCertificationIds?: string[];
}

interface StampInput {
  name?: string;
  kind?: 'company' | 'certification' | 'department';
  departmentName?: string | null;
  active?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  allowedCertificationIds?: string[];
}

async function assertCertificationsExist(
  db: DbOrTrx,
  organizationId: string,
  ids: readonly string[] | undefined,
): Promise<void> {
  if (!ids?.length) return;
  const found = await db
    .selectFrom('certification_definitions')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('id', 'in', [...ids])
    .execute();
  if (found.length !== new Set(ids).size) {
    throw new ValidationError([
      { path: 'allowedCertificationIds', message: 'One or more certifications do not exist.' },
    ]);
  }
}

/** Shared signed preview URLs for administrator screens. */
abstract class ArtworkService {
  constructor(
    protected readonly storage: ObjectStorage,
    protected readonly config: CertificationConfig,
  ) {}

  protected async imageDto(img: CurrentImage | undefined): Promise<ImageVersionDto | null> {
    if (!img) return null;
    const url = await this.storage.signedGetUrl(img.asset.storage_key, {
      expiresInSeconds: this.config.certification.previewUrlTtlSeconds,
    });
    return imageVersionDto(img, url);
  }
}

@Injectable()
export class SignatoriesService extends ArtworkService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    @InjectStorage() storage: ObjectStorage,
    @Inject(CERTIFICATION_CONFIG) config: CertificationConfig,
  ) {
    super(storage, config);
  }

  async list(
    p: Principal,
    f: { q?: string; active?: 'true' | 'false'; page: number; pageSize: number },
  ): Promise<Page<Signatory>> {
    let q = this.db
      .selectFrom('signatories')
      .selectAll()
      .where('organization_id', '=', p.organizationId);
    if (f.q)
      q = q.where((eb) =>
        eb.or([eb('name', 'ilike', likePattern(f.q!)), eb('title', 'ilike', likePattern(f.q!))]),
      );
    if (f.active) q = q.where('active', '=', f.active === 'true');
    const page = await paginate(q.orderBy('name').orderBy('id'), f);
    return { ...page, items: await this.toDtos(page.items) };
  }

  private async toDtos(
    rows: Array<Awaited<ReturnType<SignatoriesService['load']>>>,
  ): Promise<Signatory[]> {
    const ids = rows.map((r) => r.id);
    const [signatures, allowed] = await Promise.all([
      currentSignatures(this.db, ids),
      ids.length
        ? this.db
            .selectFrom('signatory_certifications')
            .select(['signatory_id', 'definition_id'])
            .where('signatory_id', 'in', ids)
            .execute()
        : Promise.resolve([]),
    ]);
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        name: r.name,
        title: r.title,
        department: r.department,
        userId: r.user_id,
        active: r.active,
        effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to,
        allowedCertificationIds: allowed
          .filter((a) => a.signatory_id === r.id)
          .map((a) => a.definition_id),
        currentSignature: await this.imageDto(signatures.get(r.id)),
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        createdBy: personRef(r.created_by, r.created_by_name),
        updatedBy: personRef(r.updated_by, r.updated_by_name),
      })),
    );
  }

  async load(db: DbOrTrx, p: Principal, id: string, forUpdate = false) {
    let q = db
      .selectFrom('signatories')
      .selectAll()
      .where('id', '=', id)
      .where('organization_id', '=', p.organizationId);
    if (forUpdate) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    if (!row) throw new NotFoundError('Signatory');
    return row;
  }

  async get(p: Principal, id: string): Promise<Signatory> {
    return (await this.toDtos([await this.load(this.db, p, id)]))[0]!;
  }

  async create(
    p: Principal,
    input: Required<Pick<SignatoryInput, 'name' | 'title'>> & SignatoryInput,
  ): Promise<Signatory> {
    await assertCertificationsExist(this.db, p.organizationId, input.allowedCertificationIds);
    const id = uuidv7();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('signatories')
        .values({
          id,
          organization_id: p.organizationId,
          user_id: input.userId ?? null,
          name: input.name,
          title: input.title,
          department: input.department ?? null,
          active: input.active ?? true,
          effective_from: input.effectiveFrom ?? null,
          effective_to: input.effectiveTo ?? null,
          created_by: p.userId,
          created_by_name: p.displayName,
          updated_by: p.userId,
          updated_by_name: p.displayName,
        })
        .execute();
      await this.replaceAllowed(trx, id, input.allowedCertificationIds ?? []);
      await this.events.audit(trx, {
        action: 'signatory.created',
        resourceType: 'signatory',
        resourceId: id,
        actorDisplay: p.displayName,
        after: input,
      });
    });
    return this.get(p, id);
  }

  async update(p: Principal, id: string, input: SignatoryInput): Promise<Signatory> {
    await assertCertificationsExist(this.db, p.organizationId, input.allowedCertificationIds);
    await this.db.transaction().execute(async (trx) => {
      const before = await this.load(trx, p, id, true);
      const from = input.effectiveFrom !== undefined ? input.effectiveFrom : before.effective_from;
      const to = input.effectiveTo !== undefined ? input.effectiveTo : before.effective_to;
      if (from && to && from > to)
        throw new ValidationError([
          { path: 'effectiveTo', message: 'The end date must be on or after the start date' },
        ]);
      const usedBy = await trx
        .selectFrom('certification_signatory_slots as s')
        .innerJoin('certification_definitions as d', 'd.id', 's.definition_id')
        .select(['d.id', 'd.name'])
        .where('s.signatory_id', '=', id)
        .where('d.status', '=', 'active')
        .execute();
      if (input.active === false && usedBy.length) {
        throw new PreconditionError(
          'SIGNATORY_IN_USE',
          `${before.name} signs ${usedBy.map((d) => `"${d.name}"`).join(', ')}. Assign another signatory to those certifications before deactivating.`,
        );
      }
      if (input.allowedCertificationIds?.length) {
        const excluded = usedBy.filter((d) => !input.allowedCertificationIds!.includes(d.id));
        if (excluded.length) {
          throw new PreconditionError(
            'SIGNATORY_IN_USE',
            `${before.name} signs ${excluded.map((d) => `"${d.name}"`).join(', ')}; keep those certifications in the allowed list.`,
          );
        }
      }
      await trx
        .updateTable('signatories')
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.title !== undefined && { title: input.title }),
          ...(input.department !== undefined && { department: input.department }),
          ...(input.userId !== undefined && { user_id: input.userId }),
          ...(input.active !== undefined && { active: input.active }),
          effective_from: from,
          effective_to: to,
          updated_by: p.userId,
          updated_by_name: p.displayName,
        })
        .where('id', '=', id)
        .execute();
      if (input.allowedCertificationIds)
        await this.replaceAllowed(trx, id, input.allowedCertificationIds);
      await this.events.audit(trx, {
        action: 'signatory.updated',
        resourceType: 'signatory',
        resourceId: id,
        actorDisplay: p.displayName,
        before: {
          name: before.name,
          title: before.title,
          active: before.active,
          effectiveFrom: before.effective_from,
          effectiveTo: before.effective_to,
        },
        after: input,
      });
    });
    return this.get(p, id);
  }

  async signatures(p: Principal, id: string): Promise<{ items: ImageVersionDto[] }> {
    await this.load(this.db, p, id);
    const rows = await this.db
      .selectFrom('signatory_signatures as s')
      .innerJoin('certification_assets as a', 'a.id', 's.asset_id')
      .select([
        's.id as version_id',
        's.version',
        's.created_at',
        's.created_by',
        's.created_by_name',
        'a.id',
        'a.storage_key',
        'a.content_type',
        'a.width',
        'a.height',
        'a.byte_size',
        'a.sha256',
      ])
      .where('s.signatory_id', '=', id)
      .orderBy('s.version', 'desc')
      .execute();
    return {
      items: (await Promise.all(
        rows.map((r) =>
          this.imageDto({
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
          }),
        ),
      )) as ImageVersionDto[],
    };
  }

  private async replaceAllowed(trx: Trx, id: string, definitionIds: string[]) {
    await trx.deleteFrom('signatory_certifications').where('signatory_id', '=', id).execute();
    if (definitionIds.length) {
      await trx
        .insertInto('signatory_certifications')
        .values(
          [...new Set(definitionIds)].map((definition_id) => ({ signatory_id: id, definition_id })),
        )
        .execute();
    }
  }
}

@Injectable()
export class StampsService extends ArtworkService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    @InjectStorage() storage: ObjectStorage,
    @Inject(CERTIFICATION_CONFIG) config: CertificationConfig,
  ) {
    super(storage, config);
  }

  async list(
    p: Principal,
    f: { q?: string; active?: 'true' | 'false'; page: number; pageSize: number },
  ): Promise<Page<Stamp>> {
    let q = this.db
      .selectFrom('stamps')
      .selectAll()
      .where('organization_id', '=', p.organizationId);
    if (f.q) q = q.where('name', 'ilike', likePattern(f.q));
    if (f.active) q = q.where('active', '=', f.active === 'true');
    const page = await paginate(q.orderBy('name').orderBy('id'), f);
    return { ...page, items: await this.toDtos(page.items) };
  }

  async load(db: DbOrTrx, p: Principal, id: string, forUpdate = false) {
    let q = db
      .selectFrom('stamps')
      .selectAll()
      .where('id', '=', id)
      .where('organization_id', '=', p.organizationId);
    if (forUpdate) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    if (!row) throw new NotFoundError('Stamp');
    return row;
  }

  private async toDtos(rows: Array<Awaited<ReturnType<StampsService['load']>>>): Promise<Stamp[]> {
    const ids = rows.map((r) => r.id);
    const [images, allowed] = await Promise.all([
      currentStampImages(this.db, ids),
      ids.length
        ? this.db
            .selectFrom('stamp_certifications')
            .select(['stamp_id', 'definition_id'])
            .where('stamp_id', 'in', ids)
            .execute()
        : Promise.resolve([]),
    ]);
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        departmentName: r.department_name,
        active: r.active,
        effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to,
        allowedCertificationIds: allowed
          .filter((a) => a.stamp_id === r.id)
          .map((a) => a.definition_id),
        currentImage: await this.imageDto(images.get(r.id)),
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        createdBy: personRef(r.created_by, r.created_by_name),
        updatedBy: personRef(r.updated_by, r.updated_by_name),
      })),
    );
  }

  async get(p: Principal, id: string): Promise<Stamp> {
    return (await this.toDtos([await this.load(this.db, p, id)]))[0]!;
  }

  async create(
    p: Principal,
    input: Required<Pick<StampInput, 'name' | 'kind'>> & StampInput,
  ): Promise<Stamp> {
    await assertCertificationsExist(this.db, p.organizationId, input.allowedCertificationIds);
    const id = uuidv7();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('stamps')
        .values({
          id,
          organization_id: p.organizationId,
          name: input.name,
          kind: input.kind,
          department_name: input.departmentName ?? null,
          active: input.active ?? true,
          effective_from: input.effectiveFrom ?? null,
          effective_to: input.effectiveTo ?? null,
          created_by: p.userId,
          created_by_name: p.displayName,
          updated_by: p.userId,
          updated_by_name: p.displayName,
        })
        .execute();
      await this.replaceAllowed(trx, id, input.allowedCertificationIds ?? []);
      await this.events.audit(trx, {
        action: 'stamp.created',
        resourceType: 'stamp',
        resourceId: id,
        actorDisplay: p.displayName,
        after: input,
      });
    });
    return this.get(p, id);
  }

  async update(p: Principal, id: string, input: StampInput): Promise<Stamp> {
    await assertCertificationsExist(this.db, p.organizationId, input.allowedCertificationIds);
    await this.db.transaction().execute(async (trx) => {
      const before = await this.load(trx, p, id, true);
      const from = input.effectiveFrom !== undefined ? input.effectiveFrom : before.effective_from;
      const to = input.effectiveTo !== undefined ? input.effectiveTo : before.effective_to;
      if (from && to && from > to)
        throw new ValidationError([
          { path: 'effectiveTo', message: 'The end date must be on or after the start date' },
        ]);
      const usedBy = await trx
        .selectFrom('certification_definitions')
        .select(['id', 'name'])
        .where('stamp_id', '=', id)
        .where('status', '=', 'active')
        .execute();
      if (input.active === false && usedBy.length) {
        throw new PreconditionError(
          'STAMP_IN_USE',
          `This stamp is used by ${usedBy.map((d) => `"${d.name}"`).join(', ')}. Choose another stamp for those certifications before deactivating.`,
        );
      }
      if (
        input.allowedCertificationIds?.length &&
        usedBy.some((d) => !input.allowedCertificationIds!.includes(d.id))
      ) {
        throw new PreconditionError(
          'STAMP_IN_USE',
          'Keep every certification that uses this stamp in the allowed list.',
        );
      }
      await trx
        .updateTable('stamps')
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.kind !== undefined && { kind: input.kind }),
          ...(input.departmentName !== undefined && { department_name: input.departmentName }),
          ...(input.active !== undefined && { active: input.active }),
          effective_from: from,
          effective_to: to,
          updated_by: p.userId,
          updated_by_name: p.displayName,
        })
        .where('id', '=', id)
        .execute();
      if (input.allowedCertificationIds)
        await this.replaceAllowed(trx, id, input.allowedCertificationIds);
      await this.events.audit(trx, {
        action: 'stamp.updated',
        resourceType: 'stamp',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { name: before.name, kind: before.kind, active: before.active },
        after: input,
      });
    });
    return this.get(p, id);
  }

  private async replaceAllowed(trx: Trx, id: string, definitionIds: string[]) {
    await trx.deleteFrom('stamp_certifications').where('stamp_id', '=', id).execute();
    if (definitionIds.length) {
      await trx
        .insertInto('stamp_certifications')
        .values(
          [...new Set(definitionIds)].map((definition_id) => ({ stamp_id: id, definition_id })),
        )
        .execute();
    }
  }
}
