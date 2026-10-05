import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { assessment } from '@a5/contracts';
import { isUniqueViolation, likePattern, paginate, sql, type Page } from '@a5/database';
import { ConflictError, EventBus, InjectDb, NotFoundError, PreconditionError } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import { People, refOrNull } from '../common/people.js';
import type { Db, DbOrTrx, Trx } from '../database/index.js';

interface BankInput {
  title?: string;
  description?: string | null;
}
interface CategoryInput {
  name?: string;
  description?: string | null;
  position?: number;
}
interface CompetencyInput {
  name?: string;
  description?: string | null;
}

@Injectable()
export class BanksService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    private readonly people: People,
  ) {}

  private summaryQuery(db: DbOrTrx, organizationId: string) {
    return db
      .selectFrom('question_banks as b')
      .select((eb) => [
        'b.id',
        'b.title',
        'b.description',
        'b.archived_at',
        'b.created_at',
        'b.updated_at',
        'b.created_by',
        'b.updated_by',
        eb.selectFrom('questions as q').select(eb.fn.countAll<number>().as('n')).whereRef('q.bank_id', '=', 'b.id').as('question_count'),
        eb
          .selectFrom('questions as q')
          .select(eb.fn.countAll<number>().as('n'))
          .whereRef('q.bank_id', '=', 'b.id')
          .where('q.status', '=', 'active')
          .as('active_question_count'),
        eb.selectFrom('question_categories as c').select(eb.fn.countAll<number>().as('n')).whereRef('c.bank_id', '=', 'b.id').as('category_count'),
      ])
      .where('b.organization_id', '=', organizationId);
  }

  private toSummary(r: Awaited<ReturnType<ReturnType<BanksService['summaryQuery']>['execute']>>[number]): assessment.QuestionBankSummary {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      archived: r.archived_at !== null,
      questionCount: Number(r.question_count ?? 0),
      activeQuestionCount: Number(r.active_question_count ?? 0),
      categoryCount: Number(r.category_count ?? 0),
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  async list(p: Principal, f: { q?: string; includeArchived?: boolean; sort?: string; page: number; pageSize: number }): Promise<Page<assessment.QuestionBankSummary>> {
    let query = this.summaryQuery(this.db, p.organizationId);
    if (!f.includeArchived) query = query.where('b.archived_at', 'is', null);
    if (f.q) {
      const pattern = likePattern(f.q);
      query = query.where((eb) => eb.or([eb('b.title', 'ilike', pattern), eb('b.description', 'ilike', pattern)]));
    }
    const desc = f.sort?.startsWith('-') ?? false;
    const key = f.sort?.replace(/^-/, '') ?? 'title';
    query = key === 'updatedAt' ? query.orderBy('b.updated_at', desc ? 'desc' : 'asc') : query.orderBy(sql`lower(b.title)`, desc ? 'desc' : 'asc');
    const page = await paginate(query.orderBy('b.id'), { page: f.page, pageSize: f.pageSize });
    return { ...page, items: page.items.map((r) => this.toSummary(r)) };
  }

  async get(p: Principal, id: string): Promise<assessment.QuestionBankDetail> {
    const row = await this.summaryQuery(this.db, p.organizationId).where('b.id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundError('Question bank');
    const [categories, competencies, people] = await Promise.all([
      this.categories(this.db, id),
      this.competencies(this.db, id),
      this.people.refs([row.created_by, row.updated_by]),
    ]);
    return {
      ...this.toSummary(row),
      categories,
      competencies,
      createdBy: refOrNull(people, row.created_by),
      updatedBy: refOrNull(people, row.updated_by),
    };
  }

  async categories(db: DbOrTrx, bankId: string): Promise<assessment.QuestionCategory[]> {
    const rows = await db
      .selectFrom('question_categories as c')
      .select((eb) => [
        'c.id',
        'c.bank_id',
        'c.name',
        'c.description',
        'c.position',
        eb
          .selectFrom('questions as q')
          .innerJoin('question_versions as v', 'v.id', 'q.current_version_id')
          .select(eb.fn.countAll<number>().as('n'))
          .whereRef('v.category_id', '=', 'c.id')
          .where('q.status', '=', 'active')
          .as('question_count'),
      ])
      .where('c.bank_id', '=', bankId)
      .orderBy('c.position')
      .orderBy(sql`lower(c.name)`)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      bankId: r.bank_id,
      name: r.name,
      description: r.description,
      position: r.position,
      questionCount: Number(r.question_count ?? 0),
    }));
  }

  async competencies(db: DbOrTrx, bankId: string): Promise<assessment.Competency[]> {
    const rows = await db
      .selectFrom('competencies as c')
      .select((eb) => [
        'c.id',
        'c.bank_id',
        'c.name',
        'c.description',
        eb
          .selectFrom('questions as q')
          .innerJoin('question_versions as v', 'v.id', 'q.current_version_id')
          .select(eb.fn.countAll<number>().as('n'))
          .where(sql<boolean>`c.id = any(v.competency_ids)`)
          .where('q.status', '=', 'active')
          .as('question_count'),
      ])
      .where('c.bank_id', '=', bankId)
      .orderBy(sql`lower(c.name)`)
      .execute();
    return rows.map((r) => ({ id: r.id, bankId: r.bank_id, name: r.name, description: r.description, questionCount: Number(r.question_count ?? 0) }));
  }

  private async bankRow(db: DbOrTrx, organizationId: string, id: string) {
    const bank = await db.selectFrom('question_banks').selectAll().where('id', '=', id).where('organization_id', '=', organizationId).executeTakeFirst();
    if (!bank) throw new NotFoundError('Question bank');
    return bank;
  }

  async create(p: Principal, input: Required<Pick<BankInput, 'title'>> & BankInput): Promise<assessment.QuestionBankDetail> {
    const id = uuidv7();
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('question_banks')
          .values({
            id,
            organization_id: p.organizationId,
            title: input.title,
            description: input.description ?? null,
            archived_at: null,
            created_by: p.userId,
            updated_by: p.userId,
          })
          .execute();
        await this.events.audit(trx, {
          action: 'question_bank.created',
          resourceType: 'question_bank',
          resourceId: id,
          actorDisplay: p.displayName,
          after: { title: input.title, description: input.description ?? null },
        });
      });
    } catch (err) {
      throw this.bankConflict(err);
    }
    return this.get(p, id);
  }

  private bankConflict(err: unknown): unknown {
    return isUniqueViolation(err, 'question_banks_org_title_uq')
      ? new ConflictError('BANK_TITLE_TAKEN', 'A question bank with this title already exists. Choose a different title.')
      : err;
  }

  async update(p: Principal, id: string, input: BankInput): Promise<assessment.QuestionBankDetail> {
    try {
      await this.db.transaction().execute(async (trx) => {
        const before = await this.bankRow(trx, p.organizationId, id);
        const after = await trx
          .updateTable('question_banks')
          .set({
            ...(input.title !== undefined && { title: input.title }),
            ...(input.description !== undefined && { description: input.description }),
            updated_by: p.userId,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.events.audit(trx, {
          action: 'question_bank.updated',
          resourceType: 'question_bank',
          resourceId: id,
          actorDisplay: p.displayName,
          before: { title: before.title, description: before.description },
          after: { title: after.title, description: after.description },
        });
      });
    } catch (err) {
      throw this.bankConflict(err);
    }
    return this.get(p, id);
  }

  async setArchived(p: Principal, id: string, archived: boolean): Promise<assessment.QuestionBankDetail> {
    await this.db.transaction().execute(async (trx) => {
      const bank = await this.bankRow(trx, p.organizationId, id);
      if ((bank.archived_at !== null) === archived) return;
      if (archived) {
        const inUse = await trx
          .selectFrom('assessment_items as i')
          .innerJoin('assessments as a', 'a.id', 'i.assessment_id')
          .leftJoin('questions as q', 'q.id', 'i.question_id')
          .select('a.title')
          .distinct()
          .where('a.status', '=', 'published')
          .where((eb) => eb.or([eb('i.pool_bank_id', '=', id), eb('q.bank_id', '=', id)]))
          .execute();
        if (inUse.length) {
          throw new ConflictError(
            'BANK_IN_USE',
            `Published assessments still draw questions from this bank: ${inUse.map((a) => a.title).join(', ')}. Archive or change those assessments first.`,
          );
        }
      }
      await trx
        .updateTable('question_banks')
        .set({ archived_at: archived ? new Date() : null, updated_by: p.userId })
        .where('id', '=', id)
        .execute();
      await this.events.audit(trx, {
        action: archived ? 'question_bank.archived' : 'question_bank.restored',
        resourceType: 'question_bank',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { archived: !archived },
        after: { archived },
      });
    });
    return this.get(p, id);
  }

  async delete(p: Principal, id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const bank = await this.bankRow(trx, p.organizationId, id);
      const [questions, pools] = await Promise.all([
        trx.selectFrom('questions').select((eb) => eb.fn.countAll<number>().as('n')).where('bank_id', '=', id).executeTakeFirstOrThrow(),
        trx.selectFrom('assessment_items').select((eb) => eb.fn.countAll<number>().as('n')).where('pool_bank_id', '=', id).executeTakeFirstOrThrow(),
      ]);
      if (Number(questions.n) > 0) {
        throw new ConflictError('BANK_NOT_EMPTY', `This bank still contains ${questions.n} questions. Archive the bank instead of deleting it.`);
      }
      if (Number(pools.n) > 0) {
        throw new ConflictError('BANK_IN_USE', 'Assessment pools draw from this bank. Remove those pools before deleting it.');
      }
      await trx.deleteFrom('question_banks').where('id', '=', id).execute();
      await this.events.audit(trx, {
        action: 'question_bank.deleted',
        resourceType: 'question_bank',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { title: bank.title },
      });
    });
  }

  // ---------------------------------------------------------------- categories

  async createCategory(p: Principal, bankId: string, input: Required<Pick<CategoryInput, 'name'>> & CategoryInput): Promise<assessment.QuestionCategory> {
    const id = uuidv7();
    await this.mutateChild(p, bankId, async (trx) => {
      const last = await trx
        .selectFrom('question_categories')
        .select((eb) => eb.fn.max('position').as('max'))
        .where('bank_id', '=', bankId)
        .executeTakeFirst();
      await trx
        .insertInto('question_categories')
        .values({
          id,
          organization_id: p.organizationId,
          bank_id: bankId,
          name: input.name,
          description: input.description ?? null,
          position: input.position ?? Number(last?.max ?? -1) + 1,
        })
        .execute();
      await this.events.audit(trx, {
        action: 'question_category.created',
        resourceType: 'question_category',
        resourceId: id,
        actorDisplay: p.displayName,
        after: { bankId, name: input.name, description: input.description ?? null },
      });
    });
    return this.categoryById(bankId, id);
  }

  async updateCategory(p: Principal, bankId: string, categoryId: string, input: CategoryInput): Promise<assessment.QuestionCategory> {
    await this.mutateChild(p, bankId, async (trx) => {
      const before = await trx.selectFrom('question_categories').selectAll().where('id', '=', categoryId).where('bank_id', '=', bankId).executeTakeFirst();
      if (!before) throw new NotFoundError('Category');
      await trx
        .updateTable('question_categories')
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.position !== undefined && { position: input.position }),
        })
        .where('id', '=', categoryId)
        .execute();
      await this.events.audit(trx, {
        action: 'question_category.updated',
        resourceType: 'question_category',
        resourceId: categoryId,
        actorDisplay: p.displayName,
        before: { name: before.name, description: before.description, position: before.position },
        after: input,
      });
    });
    return this.categoryById(bankId, categoryId);
  }

  async deleteCategory(p: Principal, bankId: string, categoryId: string): Promise<void> {
    await this.mutateChild(p, bankId, async (trx) => {
      const category = await trx.selectFrom('question_categories').selectAll().where('id', '=', categoryId).where('bank_id', '=', bankId).executeTakeFirst();
      if (!category) throw new NotFoundError('Category');
      const [versions, pools] = await Promise.all([
        trx.selectFrom('question_versions').select((eb) => eb.fn.countAll<number>().as('n')).where('category_id', '=', categoryId).executeTakeFirstOrThrow(),
        trx.selectFrom('assessment_items').select((eb) => eb.fn.countAll<number>().as('n')).where('pool_category_id', '=', categoryId).executeTakeFirstOrThrow(),
      ]);
      if (Number(versions.n) > 0) {
        throw new ConflictError(
          'CATEGORY_IN_USE',
          'Questions (including earlier versions kept for attempt history) use this category. Rename it instead, or move the questions to another category.',
        );
      }
      if (Number(pools.n) > 0) throw new ConflictError('CATEGORY_IN_USE', 'Assessment pools draw from this category. Change those pools first.');
      await trx.deleteFrom('question_categories').where('id', '=', categoryId).execute();
      await this.events.audit(trx, {
        action: 'question_category.deleted',
        resourceType: 'question_category',
        resourceId: categoryId,
        actorDisplay: p.displayName,
        before: { bankId, name: category.name },
      });
    });
  }

  private async categoryById(bankId: string, id: string): Promise<assessment.QuestionCategory> {
    const found = (await this.categories(this.db, bankId)).find((c) => c.id === id);
    if (!found) throw new NotFoundError('Category');
    return found;
  }

  // ---------------------------------------------------------------- competencies

  async createCompetency(p: Principal, bankId: string, input: Required<Pick<CompetencyInput, 'name'>> & CompetencyInput): Promise<assessment.Competency> {
    const id = uuidv7();
    await this.mutateChild(p, bankId, async (trx) => {
      await trx
        .insertInto('competencies')
        .values({ id, organization_id: p.organizationId, bank_id: bankId, name: input.name, description: input.description ?? null })
        .execute();
      await this.events.audit(trx, {
        action: 'competency.created',
        resourceType: 'competency',
        resourceId: id,
        actorDisplay: p.displayName,
        after: { bankId, name: input.name, description: input.description ?? null },
      });
    });
    return this.competencyById(bankId, id);
  }

  async updateCompetency(p: Principal, bankId: string, competencyId: string, input: CompetencyInput): Promise<assessment.Competency> {
    await this.mutateChild(p, bankId, async (trx) => {
      const before = await trx.selectFrom('competencies').selectAll().where('id', '=', competencyId).where('bank_id', '=', bankId).executeTakeFirst();
      if (!before) throw new NotFoundError('Competency');
      await trx
        .updateTable('competencies')
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
        })
        .where('id', '=', competencyId)
        .execute();
      await this.events.audit(trx, {
        action: 'competency.updated',
        resourceType: 'competency',
        resourceId: competencyId,
        actorDisplay: p.displayName,
        before: { name: before.name, description: before.description },
        after: input,
      });
    });
    return this.competencyById(bankId, competencyId);
  }

  async deleteCompetency(p: Principal, bankId: string, competencyId: string): Promise<void> {
    await this.mutateChild(p, bankId, async (trx) => {
      const competency = await trx.selectFrom('competencies').selectAll().where('id', '=', competencyId).where('bank_id', '=', bankId).executeTakeFirst();
      if (!competency) throw new NotFoundError('Competency');
      const used = await trx
        .selectFrom('question_versions')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where(sql<boolean>`${competencyId}::uuid = any(competency_ids)`)
        .executeTakeFirstOrThrow();
      if (Number(used.n) > 0) {
        throw new ConflictError(
          'COMPETENCY_IN_USE',
          'Questions (including earlier versions kept for attempt history) are tagged with this competency. Rename it instead.',
        );
      }
      await trx.deleteFrom('competencies').where('id', '=', competencyId).execute();
      await this.events.audit(trx, {
        action: 'competency.deleted',
        resourceType: 'competency',
        resourceId: competencyId,
        actorDisplay: p.displayName,
        before: { bankId, name: competency.name },
      });
    });
  }

  private async competencyById(bankId: string, id: string): Promise<assessment.Competency> {
    const found = (await this.competencies(this.db, bankId)).find((c) => c.id === id);
    if (!found) throw new NotFoundError('Competency');
    return found;
  }

  /** Category/competency changes: bank must exist in the caller's organization and not be archived. */
  private async mutateChild(p: Principal, bankId: string, fn: (trx: Trx) => Promise<void>): Promise<void> {
    try {
      await this.db.transaction().execute(async (trx) => {
        const bank = await this.bankRow(trx, p.organizationId, bankId);
        if (bank.archived_at) throw new PreconditionError('BANK_ARCHIVED', 'This question bank is archived. Restore it before changing its categories or competencies.');
        await fn(trx);
      });
    } catch (err) {
      if (isUniqueViolation(err, 'question_categories_bank_name_uq')) {
        throw new ConflictError('CATEGORY_NAME_TAKEN', 'This bank already has a category with that name.');
      }
      if (isUniqueViolation(err, 'competencies_bank_name_uq')) {
        throw new ConflictError('COMPETENCY_NAME_TAKEN', 'This bank already has a competency with that name.');
      }
      throw err;
    }
  }
}
