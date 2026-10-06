import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { assessment } from '@a5/contracts';
import { likePattern, paginate, sql, type Page } from '@a5/database';
import {
  ConflictError,
  EventBus,
  InjectDb,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import type { z } from 'zod';
import { People, refOrNull } from '../common/people.js';
import type { AssessmentItemRow, AssessmentRow, Db, DbOrTrx, Trx } from '../database/index.js';
import {
  DrawError,
  drawQuestions,
  planItems,
  poolCandidateIds,
  validateItems,
} from '../engine/draw.js';
import { correctAnswer, learnerQuestion, round2 } from '../engine/question-types.js';
import { randomRng } from '../engine/random.js';

type ItemInput = z.infer<typeof assessment.assessmentItemInputSchema>;
type CreateInput = z.infer<typeof assessment.createAssessmentRequestSchema>;
type UpdateInput = z.infer<typeof assessment.updateAssessmentRequestSchema>;

/** Item as stored, before ids/positions are assigned. */
type ItemDraft = Omit<AssessmentItemRow, 'assessment_id' | 'created_at' | 'updated_at'>;

const SORTS = {
  title: sql`lower(a.title)`,
  updatedAt: sql`a.updated_at`,
  createdAt: sql`a.created_at`,
  status: sql`a.status`,
  kind: sql`a.kind`,
} as const;

function itemDraft(input: ItemInput, id: string, position: number): ItemDraft {
  return input.kind === 'question'
    ? {
        id,
        position,
        kind: 'question',
        question_id: input.questionId,
        pool_bank_id: null,
        pool_category_id: null,
        pool_difficulty: null,
        pool_tags: [],
        pool_count: null,
        points: input.points,
      }
    : {
        id,
        position,
        kind: 'pool',
        question_id: null,
        pool_bank_id: input.bankId,
        pool_category_id: input.categoryId,
        pool_difficulty: input.difficulty,
        pool_tags: input.tags,
        pool_count: input.count,
        points: input.points,
      };
}

function describeItem(
  i: Pick<
    AssessmentItemRow,
    | 'position'
    | 'kind'
    | 'question_id'
    | 'pool_bank_id'
    | 'pool_category_id'
    | 'pool_difficulty'
    | 'pool_tags'
    | 'pool_count'
    | 'points'
  >,
) {
  return i.kind === 'question'
    ? { position: i.position, kind: i.kind, questionId: i.question_id, points: i.points }
    : {
        position: i.position,
        kind: i.kind,
        bankId: i.pool_bank_id,
        categoryId: i.pool_category_id,
        difficulty: i.pool_difficulty,
        tags: i.pool_tags,
        count: i.pool_count,
        points: i.points,
      };
}

@Injectable()
export class AssessmentsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    private readonly people: People,
  ) {}

  // ---------------------------------------------------------------- reads

  private summaryQuery(db: DbOrTrx, organizationId: string) {
    return db
      .selectFrom('assessments as a')
      .selectAll('a')
      .select((eb) => [
        eb
          .selectFrom('assessment_items as i')
          .select(eb.fn.countAll<number>().as('n'))
          .whereRef('i.assessment_id', '=', 'a.id')
          .as('item_count'),
        eb
          .selectFrom('assessment_items as i')
          .select(
            sql<number>`coalesce(sum(case when i.kind = 'question' then 1 else i.pool_count end), 0)`.as(
              'n',
            ),
          )
          .whereRef('i.assessment_id', '=', 'a.id')
          .as('question_count'),
        eb
          .selectFrom('attempts as t')
          .select(eb.fn.countAll<number>().as('n'))
          .whereRef('t.assessment_id', '=', 'a.id')
          .as('attempt_count'),
      ])
      .where('a.organization_id', '=', organizationId);
  }

  private toSummary(
    r: Awaited<ReturnType<ReturnType<AssessmentsService['summaryQuery']>['execute']>>[number],
  ): assessment.AssessmentSummary {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      kind: r.kind,
      status: r.status,
      passingPercent: r.config.passingPercent,
      itemCount: Number(r.item_count ?? 0),
      questionCount: Number(r.question_count ?? 0),
      attemptCount: Number(r.attempt_count ?? 0),
      publishedAt: r.published_at?.toISOString() ?? null,
      archivedAt: r.archived_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  async list(
    p: Principal,
    f: {
      q?: string;
      status?: assessment.AssessmentStatus[];
      kind?: assessment.AssessmentKind[];
      sort?: string;
      page: number;
      pageSize: number;
    },
  ): Promise<Page<assessment.AssessmentSummary>> {
    let query = this.summaryQuery(this.db, p.organizationId);
    if (f.status?.length) query = query.where('a.status', 'in', f.status);
    if (f.kind?.length) query = query.where('a.kind', 'in', f.kind);
    if (f.q) {
      const pattern = likePattern(f.q);
      query = query.where((eb) =>
        eb.or([eb('a.title', 'ilike', pattern), eb('a.description', 'ilike', pattern)]),
      );
    }
    const desc = f.sort?.startsWith('-') ?? false;
    const key = (f.sort?.replace(/^-/, '') ?? 'title') as keyof typeof SORTS;
    query = query.orderBy(SORTS[key] ?? SORTS.title, desc ? 'desc' : 'asc').orderBy('a.id');
    const page = await paginate(query, { page: f.page, pageSize: f.pageSize });
    return { ...page, items: page.items.map((r) => this.toSummary(r)) };
  }

  async row(db: DbOrTrx, organizationId: string, id: string, lock = false): Promise<AssessmentRow> {
    let query = db
      .selectFrom('assessments')
      .selectAll()
      .where('id', '=', id)
      .where('organization_id', '=', organizationId);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw new NotFoundError('Assessment');
    return row;
  }

  private items(db: DbOrTrx, assessmentId: string): Promise<AssessmentItemRow[]> {
    return db
      .selectFrom('assessment_items')
      .selectAll()
      .where('assessment_id', '=', assessmentId)
      .orderBy('position')
      .execute();
  }

  private async itemDtos(
    db: DbOrTrx,
    organizationId: string,
    items: readonly AssessmentItemRow[],
  ): Promise<assessment.AssessmentItem[]> {
    const questionIds = items.filter((i) => i.kind === 'question').map((i) => i.question_id!);
    const bankIds = [
      ...new Set(items.map((i) => i.pool_bank_id).filter((b): b is string => b !== null)),
    ];
    const [questions, banks] = await Promise.all([
      questionIds.length
        ? db
            .selectFrom('questions as q')
            .innerJoin('question_versions as v', 'v.id', 'q.current_version_id')
            .leftJoin('question_categories as c', 'c.id', 'v.category_id')
            .select([
              'q.id',
              'q.status',
              'v.version',
              'v.type',
              'v.prompt',
              'v.difficulty',
              'v.points',
              'c.id as category_id',
              'c.name as category_name',
            ])
            .where('q.id', 'in', questionIds)
            .execute()
        : [],
      bankIds.length
        ? db
            .selectFrom('question_banks')
            .select(['id', 'title'])
            .where('id', 'in', bankIds)
            .execute()
        : [],
    ]);
    const categoryIds = [
      ...new Set(items.map((i) => i.pool_category_id).filter((c): c is string => c !== null)),
    ];
    const categories = categoryIds.length
      ? await db
          .selectFrom('question_categories')
          .select(['id', 'name'])
          .where('id', 'in', categoryIds)
          .execute()
      : [];
    const question = new Map(questions.map((q) => [q.id, q]));
    const bank = new Map(banks.map((b) => [b.id, b.title]));
    const category = new Map(categories.map((c) => [c.id, c.name]));
    const out: assessment.AssessmentItem[] = [];
    for (const i of items) {
      if (i.kind === 'question') {
        const q = question.get(i.question_id!)!;
        out.push({
          id: i.id,
          position: i.position,
          kind: 'question',
          points: i.points,
          question: {
            id: q.id,
            status: q.status,
            version: q.version,
            type: q.type,
            prompt: q.prompt,
            difficulty: q.difficulty,
            points: q.points,
            category: q.category_id ? { id: q.category_id, name: q.category_name! } : null,
          },
        });
      } else {
        const available = await poolCandidateIds(db, organizationId, {
          bankId: i.pool_bank_id!,
          categoryId: i.pool_category_id,
          difficulty: i.pool_difficulty,
          tags: i.pool_tags,
        });
        out.push({
          id: i.id,
          position: i.position,
          kind: 'pool',
          points: i.points,
          bank: { id: i.pool_bank_id!, title: bank.get(i.pool_bank_id!) ?? 'Removed bank' },
          category: i.pool_category_id
            ? {
                id: i.pool_category_id,
                name: category.get(i.pool_category_id) ?? 'Removed category',
              }
            : null,
          difficulty: i.pool_difficulty,
          tags: i.pool_tags,
          count: i.pool_count!,
          available: available.length,
        });
      }
    }
    return out;
  }

  async get(p: Principal, id: string): Promise<assessment.AssessmentDetail> {
    const row = await this.summaryQuery(this.db, p.organizationId)
      .where('a.id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Assessment');
    const [items, people] = await Promise.all([
      this.items(this.db, id),
      this.people.refs([row.created_by, row.updated_by]),
    ]);
    return {
      ...this.toSummary(row),
      config: row.config,
      revision: row.revision,
      items: await this.itemDtos(this.db, p.organizationId, items),
      createdBy: refOrNull(people, row.created_by),
      updatedBy: refOrNull(people, row.updated_by),
    };
  }

  async validation(p: Principal, id: string): Promise<assessment.AssessmentValidation> {
    await this.row(this.db, p.organizationId, id);
    return validateItems(this.db, p.organizationId, await this.items(this.db, id));
  }

  /** Draw a sample attempt (nothing is stored); includes the answer key for authors. */
  async preview(p: Principal, id: string): Promise<assessment.AssessmentPreview> {
    const a = await this.row(this.db, p.organizationId, id);
    const items = await this.items(this.db, id);
    let drawn;
    try {
      drawn = await drawQuestions(this.db, p.organizationId, items, a.config, randomRng());
    } catch (err) {
      if (err instanceof DrawError) {
        throw new PreconditionError(
          'ASSESSMENT_INCOMPLETE',
          `This assessment cannot be previewed yet. ${err.issues[0]!.message}`,
          { issues: err.issues },
        );
      }
      throw err;
    }
    const categoryIds = [
      ...new Set(drawn.map((d) => d.question.categoryId).filter((c): c is string => c !== null)),
    ];
    const categories = categoryIds.length
      ? await this.db
          .selectFrom('question_categories')
          .select(['id', 'name'])
          .where('id', 'in', categoryIds)
          .execute()
      : [];
    const category = new Map(categories.map((c) => [c.id, c.name]));
    return {
      questionCount: drawn.length,
      totalPoints: round2(drawn.reduce((s, d) => s + d.points, 0)),
      questions: drawn.map((d, index) => ({
        position: index + 1,
        itemId: d.itemId,
        source: d.source,
        questionId: d.question.questionId,
        questionVersionId: d.question.versionId,
        version: d.question.version,
        difficulty: d.question.difficulty,
        category: d.question.categoryId
          ? {
              id: d.question.categoryId,
              name: category.get(d.question.categoryId) ?? 'Removed category',
            }
          : null,
        question: learnerQuestion(d.question.def, d.optionOrder, {
          id: uuidv7(),
          position: index + 1,
          prompt: d.question.prompt,
          points: d.points,
          response: null,
          savedAt: null,
        }),
        correctAnswer: correctAnswer(d.question.def),
        explanation: d.question.explanation,
      })),
    };
  }

  // ---------------------------------------------------------------- lifecycle

  async create(p: Principal, input: CreateInput): Promise<assessment.AssessmentDetail> {
    const id = uuidv7();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('assessments')
        .values({
          id,
          organization_id: p.organizationId,
          title: input.title,
          description: input.description ?? null,
          kind: input.kind,
          status: 'draft',
          config: input.config,
          published_at: null,
          archived_at: null,
          created_by: p.userId,
          updated_by: p.userId,
        })
        .execute();
      await this.events.audit(trx, {
        action: 'assessment.created',
        resourceType: 'assessment',
        resourceId: id,
        actorDisplay: p.displayName,
        after: { title: input.title, kind: input.kind, config: input.config },
      });
    });
    return this.get(p, id);
  }

  private assertEditable(a: AssessmentRow): void {
    if (a.status === 'archived') {
      throw new ConflictError(
        'ASSESSMENT_ARCHIVED',
        'This assessment is archived. Publish it again or duplicate it before making changes.',
      );
    }
  }

  async update(p: Principal, id: string, input: UpdateInput): Promise<assessment.AssessmentDetail> {
    await this.db.transaction().execute(async (trx) => {
      const before = await this.row(trx, p.organizationId, id, true);
      this.assertEditable(before);
      const merged = assessment.assessmentConfigSchema.safeParse({
        ...before.config,
        ...(input.config ?? {}),
      });
      if (!merged.success) {
        throw new ValidationError(
          merged.error.issues.map((i) => ({
            path: ['config', ...i.path].join('.'),
            message: i.message,
          })),
        );
      }
      const after = await trx
        .updateTable('assessments')
        .set({
          ...(input.title !== undefined && { title: input.title }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.kind !== undefined && { kind: input.kind }),
          config: merged.data,
          revision: sql<number>`revision + 1`,
          updated_by: p.userId,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.events.audit(trx, {
        action: 'assessment.updated',
        resourceType: 'assessment',
        resourceId: id,
        actorDisplay: p.displayName,
        before: {
          title: before.title,
          description: before.description,
          kind: before.kind,
          config: before.config,
        },
        after: {
          title: after.title,
          description: after.description,
          kind: after.kind,
          config: after.config,
        },
      });
    });
    return this.get(p, id);
  }

  async delete(p: Principal, id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const a = await this.row(trx, p.organizationId, id, true);
      if (a.status !== 'draft') {
        throw new ConflictError(
          'ASSESSMENT_NOT_DRAFT',
          'Only draft assessments can be deleted. Archive a published assessment instead.',
        );
      }
      const attempts = await trx
        .selectFrom('attempts')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('assessment_id', '=', id)
        .executeTakeFirstOrThrow();
      if (Number(attempts.n) > 0)
        throw new ConflictError(
          'ASSESSMENT_HAS_ATTEMPTS',
          'Learners have attempts on this assessment. Archive it instead.',
        );
      await trx.deleteFrom('assessments').where('id', '=', id).execute();
      await this.events.audit(trx, {
        action: 'assessment.deleted',
        resourceType: 'assessment',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { title: a.title, kind: a.kind },
      });
    });
  }

  async duplicate(p: Principal, id: string, title?: string): Promise<assessment.AssessmentDetail> {
    const newId = uuidv7();
    await this.db.transaction().execute(async (trx) => {
      const source = await this.row(trx, p.organizationId, id);
      const items = await this.items(trx, id);
      const newTitle = title ?? `Copy of ${source.title}`.slice(0, 200);
      await trx
        .insertInto('assessments')
        .values({
          id: newId,
          organization_id: p.organizationId,
          title: newTitle,
          description: source.description,
          kind: source.kind,
          status: 'draft',
          config: source.config,
          published_at: null,
          archived_at: null,
          created_by: p.userId,
          updated_by: p.userId,
        })
        .execute();
      if (items.length) {
        await trx
          .insertInto('assessment_items')
          .values(
            items.map((i) => ({
              ...i,
              id: uuidv7(),
              assessment_id: newId,
              created_at: undefined,
              updated_at: undefined,
            })),
          )
          .execute();
      }
      await this.events.audit(trx, {
        action: 'assessment.duplicated',
        resourceType: 'assessment',
        resourceId: newId,
        actorDisplay: p.displayName,
        after: { title: newTitle, sourceAssessmentId: id, itemCount: items.length },
      });
    });
    return this.get(p, newId);
  }

  async publish(p: Principal, id: string): Promise<assessment.AssessmentDetail> {
    await this.db.transaction().execute(async (trx) => {
      const a = await this.row(trx, p.organizationId, id, true);
      if (a.status === 'published') return;
      const validation = await validateItems(trx, p.organizationId, await this.items(trx, id));
      if (!validation.valid) {
        throw new PreconditionError(
          'ASSESSMENT_INCOMPLETE',
          `This assessment cannot be published yet. ${validation.issues[0]!.message}`,
          {
            issues: validation.issues,
          },
        );
      }
      await trx
        .updateTable('assessments')
        .set({
          status: 'published',
          published_at: new Date(),
          archived_at: null,
          updated_by: p.userId,
        })
        .where('id', '=', id)
        .execute();
      await this.events.audit(trx, {
        action: 'assessment.published',
        resourceType: 'assessment',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { status: a.status },
        after: { status: 'published', questionCount: validation.questionCount },
      });
    });
    return this.get(p, id);
  }

  async archive(p: Principal, id: string): Promise<assessment.AssessmentDetail> {
    await this.db.transaction().execute(async (trx) => {
      const a = await this.row(trx, p.organizationId, id, true);
      if (a.status === 'archived') return;
      await trx
        .updateTable('assessments')
        .set({ status: 'archived', archived_at: new Date(), updated_by: p.userId })
        .where('id', '=', id)
        .execute();
      await this.events.audit(trx, {
        action: 'assessment.archived',
        resourceType: 'assessment',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { status: a.status },
        after: { status: 'archived' },
      });
    });
    return this.get(p, id);
  }

  // ---------------------------------------------------------------- items

  async addItem(
    p: Principal,
    id: string,
    input: ItemInput & { position?: number },
  ): Promise<assessment.AssessmentDetail> {
    return this.mutateItems(p, id, (current) => {
      const position = input.position ?? current.length + 1;
      if (position > current.length + 1) {
        throw new ValidationError([
          { path: 'position', message: `Choose a position between 1 and ${current.length + 1}` },
        ]);
      }
      const next = [...current];
      next.splice(position - 1, 0, itemDraft(input, uuidv7(), position));
      return next;
    });
  }

  async updateItem(
    p: Principal,
    id: string,
    itemId: string,
    input: ItemInput & { position: number },
  ): Promise<assessment.AssessmentDetail> {
    return this.mutateItems(p, id, (current) => {
      const index = current.findIndex((i) => i.id === itemId);
      if (index === -1) throw new NotFoundError('Assessment item');
      if (input.position > current.length) {
        throw new ValidationError([
          { path: 'position', message: `Choose a position between 1 and ${current.length}` },
        ]);
      }
      const next = current.filter((i) => i.id !== itemId);
      next.splice(input.position - 1, 0, itemDraft(input, itemId, input.position));
      return next;
    });
  }

  async deleteItem(p: Principal, id: string, itemId: string): Promise<assessment.AssessmentDetail> {
    return this.mutateItems(p, id, (current) => {
      if (!current.some((i) => i.id === itemId)) throw new NotFoundError('Assessment item');
      return current.filter((i) => i.id !== itemId);
    });
  }

  async replaceItems(
    p: Principal,
    id: string,
    items: Array<ItemInput & { id?: string; position: number }>,
  ): Promise<assessment.AssessmentDetail> {
    const positions = items.map((i) => i.position).sort((a, b) => a - b);
    if (positions.some((pos, index) => pos !== index + 1)) {
      throw new ValidationError([
        {
          path: 'items',
          message: `Positions must run from 1 to ${items.length} without gaps or duplicates`,
        },
      ]);
    }
    return this.mutateItems(p, id, (current) => {
      const known = new Set(current.map((i) => i.id));
      const unknown = items.find((i) => i.id && !known.has(i.id));
      if (unknown)
        throw new ValidationError([
          {
            path: 'items',
            message: 'An item id does not belong to this assessment. Reload and try again.',
          },
        ]);
      return [...items]
        .sort((a, b) => a.position - b.position)
        .map((i) => itemDraft(i, i.id ?? uuidv7(), i.position));
    });
  }

  /**
   * Apply an item-list change: validate references, renumber positions 1..n, persist (deferred
   * unique positions allow reordering in place) and keep published assessments valid.
   */
  private async mutateItems(
    p: Principal,
    id: string,
    change: (current: ItemDraft[]) => ItemDraft[],
  ): Promise<assessment.AssessmentDetail> {
    await this.db.transaction().execute(async (trx) => {
      const a = await this.row(trx, p.organizationId, id, true);
      this.assertEditable(a);
      const currentRows = await this.items(trx, id);
      const next = change(
        currentRows.map(({ assessment_id: _a, created_at: _c, updated_at: _u, ...rest }) => rest),
      ).map((item, index) => ({
        ...item,
        position: index + 1,
      }));
      await this.assertItemReferences(trx, p.organizationId, next);

      const keep = new Set(next.map((i) => i.id));
      const removed = currentRows.filter((i) => !keep.has(i.id)).map((i) => i.id);
      if (removed.length)
        await trx.deleteFrom('assessment_items').where('id', 'in', removed).execute();
      const existing = new Set(currentRows.map((i) => i.id));
      for (const item of next) {
        if (existing.has(item.id)) {
          const { id: itemId, ...values } = item;
          await trx.updateTable('assessment_items').set(values).where('id', '=', itemId).execute();
        } else {
          await trx
            .insertInto('assessment_items')
            .values({ ...item, assessment_id: id })
            .execute();
        }
      }
      if (a.status === 'published') {
        const plan = await planItems(trx, p.organizationId, await this.items(trx, id));
        if (plan.issues.length) {
          throw new PreconditionError(
            'ASSESSMENT_INCOMPLETE',
            `A published assessment must stay ready to take. ${plan.issues[0]!.message}`,
            {
              issues: plan.issues,
            },
          );
        }
      }
      await trx
        .updateTable('assessments')
        .set({ revision: sql<number>`revision + 1`, updated_by: p.userId })
        .where('id', '=', id)
        .execute();
      await this.events.audit(trx, {
        action: 'assessment.items_updated',
        resourceType: 'assessment',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { items: currentRows.map(describeItem) },
        after: { items: next.map(describeItem) },
      });
    });
    return this.get(p, id);
  }

  private async assertItemReferences(
    trx: Trx,
    organizationId: string,
    items: readonly ItemDraft[],
  ): Promise<void> {
    const fields: Array<{ path: string; message: string }> = [];
    const fixed = items.filter((i) => i.kind === 'question');
    const seen = new Set<string>();
    for (const item of fixed) {
      if (seen.has(item.question_id!))
        fields.push({
          path: `items.${item.position}`,
          message: 'This question is already in the assessment',
        });
      seen.add(item.question_id!);
    }
    if (fixed.length) {
      const questions = await trx
        .selectFrom('questions')
        .select(['id', 'status'])
        .where('organization_id', '=', organizationId)
        .where('id', 'in', [...seen])
        .execute();
      const status = new Map(questions.map((q) => [q.id, q.status]));
      for (const item of fixed) {
        const s = status.get(item.question_id!);
        if (!s)
          fields.push({
            path: `items.${item.position}.questionId`,
            message: 'Choose an existing question',
          });
        else if (s === 'archived')
          fields.push({
            path: `items.${item.position}.questionId`,
            message: 'This question is archived; restore it or choose another',
          });
      }
    }
    for (const item of items.filter((i) => i.kind === 'pool')) {
      const bank = await trx
        .selectFrom('question_banks')
        .select('id')
        .where('id', '=', item.pool_bank_id!)
        .where('organization_id', '=', organizationId)
        .executeTakeFirst();
      if (!bank) {
        fields.push({
          path: `items.${item.position}.bankId`,
          message: 'Choose an existing question bank',
        });
        continue;
      }
      if (item.pool_category_id) {
        const category = await trx
          .selectFrom('question_categories')
          .select('id')
          .where('id', '=', item.pool_category_id)
          .where('bank_id', '=', item.pool_bank_id!)
          .executeTakeFirst();
        if (!category)
          fields.push({
            path: `items.${item.position}.categoryId`,
            message: 'Choose a category from the selected bank',
          });
      }
    }
    if (fields.length) throw new ValidationError(fields);
  }
}
