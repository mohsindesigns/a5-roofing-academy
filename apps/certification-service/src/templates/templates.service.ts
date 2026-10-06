import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { certification } from '@a5/contracts';
import { isUniqueViolation, likePattern, paginate, type Page } from '@a5/database';
import {
  ConflictError,
  EventBus,
  ForbiddenError,
  InjectDb,
  NotFoundError,
  PreconditionError,
} from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import type { Db, DbOrTrx, Trx } from '../database/index.js';
import { assertDesignAssets } from '../common/artwork-repo.js';
import { canonicalJson } from '../common/json.js';
import { personRef } from '../common/timeline.js';
import { artworkProblems } from './artwork-check.js';
import { STARTER_DESIGNS } from './starters.js';

type TemplateDesign = certification.TemplateDesign;
type TemplateSummary = ReturnType<typeof certification.templateSummarySchema.parse>;
type TemplateDetail = ReturnType<typeof certification.templateDetailSchema.parse>;

interface ListFilters {
  q?: string;
  status?: Array<'active' | 'archived'>;
  page: number;
  pageSize: number;
}

/** Custom placeholders a design uses that a certification does not define. */
export function missingCustomVariables(
  design: TemplateDesign,
  customVariables: ReadonlyArray<{ key: string }>,
): string[] {
  const defined = new Set(customVariables.map((v) => v.key));
  return certification.customPlaceholdersOf(design).filter((k) => !defined.has(k));
}

@Injectable()
export class TemplatesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  starters() {
    return (Object.keys(STARTER_DESIGNS) as Array<keyof typeof STARTER_DESIGNS>).map((key) => ({
      key,
      ...STARTER_DESIGNS[key],
    }));
  }

  async list(p: Principal, f: ListFilters): Promise<Page<TemplateSummary>> {
    let q = this.db
      .selectFrom('certificate_templates as t')
      .innerJoin('certificate_template_versions as v', (j) =>
        j.onRef('v.template_id', '=', 't.id').onRef('v.version', '=', 't.current_version'),
      )
      .select([
        't.id',
        't.name',
        't.description',
        't.status',
        't.is_default',
        't.current_version',
        't.cloned_from_id',
        't.updated_at',
        'v.design',
      ])
      .where('t.organization_id', '=', p.organizationId)
      .where('t.status', 'in', f.status?.length ? f.status : ['active']);
    if (f.q) q = q.where('t.name', 'ilike', likePattern(f.q));
    const page = await paginate(
      q.orderBy('t.is_default', 'desc').orderBy('t.name').orderBy('t.id'),
      f,
    );
    const usage = await this.usage(
      this.db,
      page.items.map((t) => t.id),
    );
    return {
      ...page,
      items: page.items.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        status: t.status,
        isDefault: t.is_default,
        currentVersion: t.current_version,
        page: t.design.page,
        usedBy: usage.get(t.id) ?? [],
        clonedFromId: t.cloned_from_id,
        updatedAt: t.updated_at.toISOString(),
      })),
    };
  }

  private async usage(db: DbOrTrx, templateIds: string[]) {
    const map = new Map<string, Array<{ id: string; name: string; code: string }>>();
    if (templateIds.length === 0) return map;
    const rows = await db
      .selectFrom('certification_definitions')
      .select(['id', 'name', 'code', 'template_id'])
      .where('template_id', 'in', templateIds)
      .where('status', '<>', 'archived')
      .orderBy('name')
      .execute();
    for (const r of rows) {
      const list = map.get(r.template_id!) ?? [];
      list.push({ id: r.id, name: r.name, code: r.code });
      map.set(r.template_id!, list);
    }
    return map;
  }

  private async load(db: DbOrTrx, p: Principal, id: string, forUpdate = false) {
    let q = db
      .selectFrom('certificate_templates')
      .selectAll()
      .where('id', '=', id)
      .where('organization_id', '=', p.organizationId);
    if (forUpdate) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    if (!row) throw new NotFoundError('Certificate template');
    return row;
  }

  async currentVersion(db: DbOrTrx, templateId: string) {
    return db
      .selectFrom('certificate_template_versions as v')
      .innerJoin('certificate_templates as t', 't.id', 'v.template_id')
      .select([
        'v.id',
        'v.version',
        'v.design',
        'v.change_note',
        'v.created_at',
        'v.created_by',
        'v.created_by_name',
      ])
      .whereRef('v.version', '=', 't.current_version')
      .where('v.template_id', '=', templateId)
      .executeTakeFirstOrThrow();
  }

  async get(p: Principal, id: string): Promise<TemplateDetail> {
    const t = await this.load(this.db, p, id);
    const v = await this.currentVersion(this.db, id);
    const usage = await this.usage(this.db, [id]);
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      status: t.status,
      isDefault: t.is_default,
      currentVersion: t.current_version,
      page: v.design.page,
      usedBy: usage.get(id) ?? [],
      clonedFromId: t.cloned_from_id,
      updatedAt: t.updated_at.toISOString(),
      versionId: v.id,
      design: v.design,
      customPlaceholders: certification.customPlaceholdersOf(v.design),
      createdAt: t.created_at.toISOString(),
      createdBy: personRef(t.created_by, t.created_by_name),
      updatedBy: personRef(t.updated_by, t.updated_by_name),
    };
  }

  async versions(p: Principal, id: string) {
    await this.load(this.db, p, id);
    const rows = await this.db
      .selectFrom('certificate_template_versions')
      .select(['id', 'version', 'change_note', 'created_at', 'created_by', 'created_by_name'])
      .where('template_id', '=', id)
      .orderBy('version', 'desc')
      .execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        version: r.version,
        changeNote: r.change_note,
        createdAt: r.created_at.toISOString(),
        createdBy: personRef(r.created_by, r.created_by_name),
      })),
    };
  }

  async version(p: Principal, id: string, versionId: string) {
    await this.load(this.db, p, id);
    const r = await this.db
      .selectFrom('certificate_template_versions')
      .selectAll()
      .where('template_id', '=', id)
      .where('id', '=', versionId)
      .executeTakeFirst();
    if (!r) throw new NotFoundError('Template version');
    return {
      id: r.id,
      version: r.version,
      changeNote: r.change_note,
      createdAt: r.created_at.toISOString(),
      createdBy: personRef(r.created_by, r.created_by_name),
      design: r.design,
    };
  }

  private async insertTemplate(
    trx: Trx,
    p: Principal,
    input: {
      name: string;
      description: string | null;
      design: TemplateDesign;
      clonedFromId: string | null;
      changeNote: string | null;
    },
  ): Promise<string> {
    const id = uuidv7();
    const existing = await trx
      .selectFrom('certificate_templates')
      .select('id')
      .where('organization_id', '=', p.organizationId)
      .where('is_default', '=', true)
      .executeTakeFirst();
    await trx
      .insertInto('certificate_templates')
      .values({
        id,
        organization_id: p.organizationId,
        name: input.name,
        description: input.description,
        status: 'active',
        // The first template of an organization becomes its default.
        is_default: !existing,
        current_version: 1,
        cloned_from_id: input.clonedFromId,
        archived_at: null,
        created_by: p.userId,
        created_by_name: p.displayName,
        updated_by: p.userId,
        updated_by_name: p.displayName,
      })
      .execute();
    await trx
      .insertInto('certificate_template_versions')
      .values({
        id: uuidv7(),
        template_id: id,
        version: 1,
        design: input.design,
        change_note: input.changeNote,
        created_by: p.userId,
        created_by_name: p.displayName,
      })
      .execute();
    return id;
  }

  async create(
    p: Principal,
    input: {
      name: string;
      description?: string | null;
      starter?: 'classic' | 'modern';
      design?: TemplateDesign;
    },
  ): Promise<TemplateDetail> {
    const design = input.design ?? STARTER_DESIGNS[input.starter ?? 'classic'].design;
    await assertDesignAssets(this.db, p.organizationId, design);
    const id = await this.withNameGuard(() =>
      this.db.transaction().execute(async (trx) => {
        const created = await this.insertTemplate(trx, p, {
          name: input.name,
          description: input.description ?? null,
          design,
          clonedFromId: null,
          changeNote:
            input.starter || !input.design
              ? `Created from the ${STARTER_DESIGNS[input.starter ?? 'classic'].name} starter design`
              : null,
        });
        await this.events.audit(trx, {
          action: 'certificate_template.created',
          resourceType: 'certificate_template',
          resourceId: created,
          actorDisplay: p.displayName,
          after: { name: input.name, starter: input.starter ?? null },
        });
        return created;
      }),
    );
    return this.get(p, id);
  }

  async clone(p: Principal, sourceId: string, name: string): Promise<TemplateDetail> {
    const source = await this.load(this.db, p, sourceId);
    const version = await this.currentVersion(this.db, sourceId);
    const id = await this.withNameGuard(() =>
      this.db.transaction().execute(async (trx) => {
        const created = await this.insertTemplate(trx, p, {
          name,
          description: source.description,
          design: version.design,
          clonedFromId: source.id,
          changeNote: `Cloned from "${source.name}" version ${version.version}`,
        });
        await this.events.audit(trx, {
          action: 'certificate_template.cloned',
          resourceType: 'certificate_template',
          resourceId: created,
          actorDisplay: p.displayName,
          after: { name, sourceTemplateId: source.id, sourceVersion: version.version },
        });
        return created;
      }),
    );
    return this.get(p, id);
  }

  /** Every design change creates a new immutable version; issued certificates keep theirs. */
  async updateDesign(
    p: Principal,
    id: string,
    design: TemplateDesign,
    changeNote: string | null,
  ): Promise<TemplateDetail> {
    await assertDesignAssets(this.db, p.organizationId, design);
    await this.db.transaction().execute(async (trx) => {
      const t = await this.load(trx, p, id, true);
      if (t.status === 'archived')
        throw new PreconditionError(
          'TEMPLATE_ARCHIVED',
          'Archived templates cannot be edited. Clone it to start a new design.',
        );
      const current = await this.currentVersion(trx, id);
      if (canonicalJson(current.design) === canonicalJson(design)) return;
      const definitions = await trx
        .selectFrom('certification_definitions')
        .select(['id', 'name', 'status', 'stamp_id', 'custom_variables'])
        .where('template_id', '=', id)
        .where('status', '<>', 'archived')
        .execute();
      for (const d of definitions) {
        const missing = missingCustomVariables(design, d.custom_variables);
        if (missing.length) {
          throw new PreconditionError(
            'UNDEFINED_PLACEHOLDERS',
            `"${d.name}" uses this template but does not define ${missing.map((m) => `{{${m}}}`).join(', ')}. Add the custom variables to the certification first.`,
            { placeholders: missing },
          );
        }
        if (d.status === 'active') await this.assertIssuable(trx, d, design);
      }
      const version = t.current_version + 1;
      await trx
        .insertInto('certificate_template_versions')
        .values({
          id: uuidv7(),
          template_id: id,
          version,
          design,
          change_note: changeNote,
          created_by: p.userId,
          created_by_name: p.displayName,
        })
        .execute();
      await trx
        .updateTable('certificate_templates')
        .set({ current_version: version, updated_by: p.userId, updated_by_name: p.displayName })
        .where('id', '=', id)
        .execute();
      await this.events.audit(trx, {
        action: 'certificate_template.version_created',
        resourceType: 'certificate_template',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { version: t.current_version },
        after: { version, changeNote },
      });
    });
    return this.get(p, id);
  }

  async update(
    p: Principal,
    id: string,
    input: { name?: string; description?: string | null },
  ): Promise<TemplateDetail> {
    await this.withNameGuard(() =>
      this.db.transaction().execute(async (trx) => {
        const t = await this.load(trx, p, id, true);
        await trx
          .updateTable('certificate_templates')
          .set({
            ...(input.name !== undefined && { name: input.name }),
            ...(input.description !== undefined && { description: input.description }),
            updated_by: p.userId,
            updated_by_name: p.displayName,
          })
          .where('id', '=', id)
          .execute();
        await this.events.audit(trx, {
          action: 'certificate_template.updated',
          resourceType: 'certificate_template',
          resourceId: id,
          actorDisplay: p.displayName,
          before: { name: t.name, description: t.description },
          after: input,
        });
      }),
    );
    return this.get(p, id);
  }

  async archive(p: Principal, id: string): Promise<TemplateDetail> {
    await this.db.transaction().execute(async (trx) => {
      const t = await this.load(trx, p, id, true);
      if (t.status === 'archived') return;
      if (t.is_default)
        throw new PreconditionError(
          'TEMPLATE_IS_DEFAULT',
          'Choose another default template before archiving this one.',
        );
      const used = (await this.usage(trx, [id])).get(id) ?? [];
      if (used.length) {
        throw new PreconditionError(
          'TEMPLATE_IN_USE',
          `This template is assigned to ${used.map((u) => `"${u.name}"`).join(', ')}. Assign another template to those certifications first.`,
        );
      }
      await trx
        .updateTable('certificate_templates')
        .set({
          status: 'archived',
          archived_at: new Date(),
          updated_by: p.userId,
          updated_by_name: p.displayName,
        })
        .where('id', '=', id)
        .execute();
      await this.events.audit(trx, {
        action: 'certificate_template.archived',
        resourceType: 'certificate_template',
        resourceId: id,
        actorDisplay: p.displayName,
      });
    });
    return this.get(p, id);
  }

  async setDefault(p: Principal, id: string): Promise<TemplateDetail> {
    await this.db.transaction().execute(async (trx) => {
      const t = await this.load(trx, p, id, true);
      if (t.status !== 'active')
        throw new PreconditionError(
          'TEMPLATE_ARCHIVED',
          'Only active templates can be the default.',
        );
      if (t.is_default) return;
      await trx
        .updateTable('certificate_templates')
        .set({ is_default: false })
        .where('organization_id', '=', p.organizationId)
        .where('is_default', '=', true)
        .execute();
      await trx
        .updateTable('certificate_templates')
        .set({ is_default: true, updated_by: p.userId, updated_by_name: p.displayName })
        .where('id', '=', id)
        .execute();
      await this.events.audit(trx, {
        action: 'certificate_template.default_set',
        resourceType: 'certificate_template',
        resourceId: id,
        actorDisplay: p.displayName,
      });
    });
    return this.get(p, id);
  }

  /** Assign this template to certifications (requires certifications.update as well). */
  async assign(p: Principal, id: string, certificationIds: string[]): Promise<TemplateDetail> {
    if (!p.can('certifications.update'))
      throw new ForbiddenError(
        'Assigning templates also requires permission to update certifications.',
      );
    await this.db.transaction().execute(async (trx) => {
      const t = await this.load(trx, p, id, true);
      if (t.status !== 'active')
        throw new PreconditionError('TEMPLATE_ARCHIVED', 'Archived templates cannot be assigned.');
      const version = await this.currentVersion(trx, id);
      const definitions = await trx
        .selectFrom('certification_definitions')
        .select(['id', 'name', 'template_id', 'custom_variables', 'status', 'stamp_id'])
        .where('organization_id', '=', p.organizationId)
        .where('id', 'in', certificationIds)
        .forUpdate()
        .execute();
      if (definitions.length !== new Set(certificationIds).size)
        throw new NotFoundError('Certification');
      for (const d of definitions) {
        if (d.status === 'archived')
          throw new PreconditionError('CERTIFICATION_ARCHIVED', `"${d.name}" is archived.`);
        const missing = missingCustomVariables(version.design, d.custom_variables);
        if (missing.length) {
          throw new PreconditionError(
            'UNDEFINED_PLACEHOLDERS',
            `"${d.name}" does not define ${missing.map((m) => `{{${m}}}`).join(', ')} used by this template. Add the custom variables first.`,
            { placeholders: missing },
          );
        }
        if (d.status === 'active') await this.assertIssuable(trx, d, version.design);
      }
      await trx
        .updateTable('certification_definitions')
        .set((eb) => ({
          template_id: id,
          revision: eb('revision', '+', 1),
          updated_by: p.userId,
          updated_by_name: p.displayName,
        }))
        .where('id', 'in', certificationIds)
        .execute();
      for (const d of definitions) {
        await this.events.audit(trx, {
          action: 'certification.template_assigned',
          resourceType: 'certification',
          resourceId: d.id,
          actorDisplay: p.displayName,
          before: { templateId: d.template_id },
          after: { templateId: id },
        });
      }
    });
    return this.get(p, id);
  }

  /** An active certification must stay issuable with the design (signatories, signatures, stamp). */
  private async assertIssuable(
    db: DbOrTrx,
    def: { id: string; name: string; stamp_id: string | null },
    design: TemplateDesign,
  ): Promise<void> {
    const problems = await artworkProblems(db, def, design);
    if (problems.length) {
      throw new PreconditionError(
        'TEMPLATE_BREAKS_CERTIFICATION',
        `${problems[0]} Fix this on the certification first, then use the design.`,
        { problems },
      );
    }
  }

  private async withNameGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isUniqueViolation(err, 'certificate_templates_org_name_uq')) {
        throw new ConflictError(
          'TEMPLATE_NAME_TAKEN',
          'Another active template already uses this name. Choose a different name.',
        );
      }
      throw err;
    }
  }
}
