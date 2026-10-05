import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { ai } from '@a5/contracts';
import { isUniqueViolation, likePattern, paginate, sql, type Selectable } from '@a5/database';
import { ConflictError, EventBus, InjectDb, NotFoundError } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import { People, iso } from '../common/people.js';
import type { AiRubricVersionsTable, Db, RubricCategoryRecord, Trx } from '../database/index.js';
import { PromptVersionService } from '../scenarios/prompt-versions.service.js';
import { DEFAULT_PASSING_SCORE, DEFAULT_RUBRIC_CATEGORIES } from './default-categories.js';

type VersionRow = Selectable<AiRubricVersionsTable>;

@Injectable()
export class RubricsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    private readonly people: People,
    private readonly versions: PromptVersionService,
  ) {}

  private async versionSummaries(rows: VersionRow[]) {
    const people = await this.people.refs(rows.map((r) => r.created_by));
    return rows.map((r) => ({
      id: r.id,
      version: r.version,
      passingScore: r.passing_score,
      categoryCount: r.categories.length,
      changeNote: r.change_note,
      createdBy: r.created_by ? (people.get(r.created_by) ?? null) : null,
      createdAt: iso(r.created_at),
    }));
  }

  private base(organizationId: string) {
    return this.db
      .selectFrom('ai_rubrics as r')
      .innerJoin('ai_rubric_versions as v', 'v.id', 'r.current_version_id')
      .select([
        'r.id',
        'r.title',
        'r.description',
        'r.archived_at',
        'r.updated_at',
        'v.id as version_id',
        sql<number>`(select count(*)::int from ai_scenarios s where s.rubric_id = r.id and s.status <> 'archived')`.as(
          'scenario_count',
        ),
      ])
      .where('r.organization_id', '=', organizationId);
  }

  async list(
    p: Principal,
    q: { q?: string; includeArchived?: boolean; page: number; pageSize: number },
  ) {
    let query = this.base(p.organizationId);
    if (!q.includeArchived) query = query.where('r.archived_at', 'is', null);
    if (q.q) query = query.where('r.title', 'ilike', likePattern(q.q));
    const page = await paginate(query.orderBy('r.title'), q);
    const versions = page.items.length
      ? await this.db
          .selectFrom('ai_rubric_versions')
          .selectAll()
          .where(
            'id',
            'in',
            page.items.map((i) => i.version_id),
          )
          .execute()
      : [];
    const summaries = await this.versionSummaries(versions);
    return {
      ...page,
      items: page.items.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        archived: r.archived_at !== null,
        scenarioCount: Number(r.scenario_count),
        currentVersion: summaries.find((s) => s.id === r.version_id)!,
        updatedAt: iso(r.updated_at),
      })),
    };
  }

  async get(p: Principal, id: string): Promise<ai.RubricDetail> {
    const r = await this.base(p.organizationId).where('r.id', '=', id).executeTakeFirst();
    if (!r) throw new NotFoundError('Rubric');
    const rows = await this.db
      .selectFrom('ai_rubric_versions')
      .selectAll()
      .where('rubric_id', '=', id)
      .orderBy('version', 'desc')
      .execute();
    const summaries = await this.versionSummaries(rows);
    const current = rows.find((v) => v.id === r.version_id)!;
    const currentSummary = summaries.find((s) => s.id === r.version_id)!;
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      archived: r.archived_at !== null,
      scenarioCount: Number(r.scenario_count),
      currentVersion: { ...currentSummary, rubricId: r.id, categories: current.categories },
      versions: summaries,
      updatedAt: iso(r.updated_at),
    };
  }

  async getVersion(p: Principal, rubricId: string, versionId: string): Promise<ai.RubricVersion> {
    await this.get(p, rubricId);
    const row = await this.db
      .selectFrom('ai_rubric_versions')
      .selectAll()
      .where('id', '=', versionId)
      .where('rubric_id', '=', rubricId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Rubric version');
    const [summary] = await this.versionSummaries([row]);
    return { ...summary!, rubricId, categories: row.categories };
  }

  /** Insert a rubric and its first version (used by the API and the seed). */
  static async insert(
    trx: Trx,
    input: {
      id?: string;
      organizationId: string;
      title: string;
      description: string | null;
      categories: RubricCategoryRecord[];
      passingScore: number;
      actorId: string | null;
      versionId?: string;
      /** Back-dates seeded rubrics. */
      createdAt?: Date;
    },
  ): Promise<{ id: string; versionId: string }> {
    const id = input.id ?? uuidv7();
    const versionId = input.versionId ?? uuidv7();
    await trx
      .insertInto('ai_rubrics')
      .values({
        id,
        organization_id: input.organizationId,
        title: input.title,
        description: input.description,
        current_version_id: versionId,
        archived_at: null,
        created_by: input.actorId,
        updated_by: input.actorId,
        ...(input.createdAt && { created_at: input.createdAt, updated_at: input.createdAt }),
      })
      .execute();
    await trx
      .insertInto('ai_rubric_versions')
      .values({
        id: versionId,
        rubric_id: id,
        version: 1,
        categories: JSON.stringify(input.categories),
        passing_score: input.passingScore,
        change_note: 'Initial version',
        created_by: input.actorId,
        ...(input.createdAt && { created_at: input.createdAt }),
      })
      .execute();
    return { id, versionId };
  }

  async create(p: Principal, input: ai.CreateRubricRequest): Promise<ai.RubricDetail> {
    let id: string;
    try {
      id = await this.db.transaction().execute(async (trx) => {
        const created = await RubricsService.insert(trx, {
          organizationId: p.organizationId,
          title: input.title,
          description: input.description ?? null,
          categories: input.categories ?? DEFAULT_RUBRIC_CATEGORIES,
          passingScore: input.passingScore ?? DEFAULT_PASSING_SCORE,
          actorId: p.userId,
        });
        await this.events.audit(
          trx,
          {
            action: 'ai.rubric.created',
            resourceType: 'ai_rubric',
            resourceId: created.id,
            actorDisplay: p.displayName,
            after: input,
          },
          { organizationId: p.organizationId },
        );
        return created.id;
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictError(
          'RUBRIC_TITLE_TAKEN',
          `A rubric titled "${input.title}" already exists. Choose another title.`,
        );
      throw err;
    }
    return this.get(p, id);
  }

  async update(
    p: Principal,
    id: string,
    input: { title?: string; description?: string | null },
  ): Promise<ai.RubricDetail> {
    const before = await this.get(p, id);
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('ai_rubrics')
          .set({
            ...(input.title !== undefined && { title: input.title }),
            ...(input.description !== undefined && { description: input.description }),
            updated_by: p.userId,
          })
          .where('id', '=', id)
          .execute();
        await this.events.audit(
          trx,
          {
            action: 'ai.rubric.updated',
            resourceType: 'ai_rubric',
            resourceId: id,
            actorDisplay: p.displayName,
            before: { title: before.title, description: before.description },
            after: input,
          },
          { organizationId: p.organizationId },
        );
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictError(
          'RUBRIC_TITLE_TAKEN',
          `A rubric titled "${input.title}" already exists. Choose another title.`,
        );
      throw err;
    }
    return this.get(p, id);
  }

  /** Publish a new immutable rubric version; every live scenario using it gets a new prompt version. */
  async createVersion(
    p: Principal,
    id: string,
    input: ai.CreateRubricVersionRequest,
  ): Promise<ai.RubricDetail> {
    const rubric = await this.get(p, id);
    if (rubric.archived)
      throw new ConflictError(
        'RUBRIC_ARCHIVED',
        'This rubric is archived. Create a new rubric instead.',
      );
    await this.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('ai_rubrics')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const { v } = await trx
        .selectFrom('ai_rubric_versions')
        .select(sql<number>`coalesce(max(version), 0)::int`.as('v'))
        .where('rubric_id', '=', id)
        .executeTakeFirstOrThrow();
      const versionId = uuidv7();
      const version = Number(v) + 1;
      await trx
        .insertInto('ai_rubric_versions')
        .values({
          id: versionId,
          rubric_id: id,
          version,
          categories: JSON.stringify(input.categories),
          passing_score: input.passingScore,
          change_note: input.changeNote ?? null,
          created_by: p.userId,
        })
        .execute();
      await trx
        .updateTable('ai_rubrics')
        .set({ current_version_id: versionId, updated_by: p.userId })
        .where('id', '=', id)
        .execute();
      await this.versions.syncForRubric(
        trx,
        id,
        p.userId,
        input.changeNote ?? `Rubric "${rubric.title}" version ${version}`,
      );
      await this.events.audit(
        trx,
        {
          action: 'ai.rubric.version_created',
          resourceType: 'ai_rubric',
          resourceId: id,
          actorDisplay: p.displayName,
          after: {
            version,
            passingScore: input.passingScore,
            categories: input.categories.map((c) => c.key),
          },
        },
        { organizationId: p.organizationId },
      );
    });
    return this.get(p, id);
  }

  async archive(p: Principal, id: string): Promise<ai.RubricDetail> {
    const rubric = await this.get(p, id);
    if (rubric.scenarioCount > 0) {
      throw new ConflictError(
        'RUBRIC_IN_USE',
        `${rubric.scenarioCount} scenario(s) still use this rubric. Move or archive them first.`,
      );
    }
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('ai_rubrics')
        .set({ archived_at: new Date(), updated_by: p.userId })
        .where('id', '=', id)
        .execute();
      await this.events.audit(
        trx,
        {
          action: 'ai.rubric.archived',
          resourceType: 'ai_rubric',
          resourceId: id,
          actorDisplay: p.displayName,
        },
        { organizationId: p.organizationId },
      );
    });
    return this.get(p, id);
  }
}
