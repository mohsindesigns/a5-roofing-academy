import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { assessment } from '@a5/contracts';
import { likePattern, paginate, sql, type Page } from '@a5/database';
import { ConflictError, EventBus, InjectDb, NotFoundError, PreconditionError, ValidationError } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import type { z } from 'zod';
import { People, refOrNull } from '../common/people.js';
import type { Db, DbOrTrx, QuestionVersionRow, Trx } from '../database/index.js';
import { planItems } from '../engine/draw.js';
import { correctAnswer, gradeResponse, initialOrder, isAnswered, learnerQuestion, toDefinition } from '../engine/question-types.js';
import { randomRng } from '../engine/random.js';

type CreateInput = z.infer<typeof assessment.createQuestionRequestSchema>;
type UpdateInput = z.infer<typeof assessment.updateQuestionRequestSchema>;
type VersionData = assessment.QuestionVersionData;

export interface QuestionListFilters {
  q?: string;
  bankId?: string;
  type?: assessment.QuestionType[];
  categoryId?: string;
  competencyId?: string;
  difficulty?: assessment.Difficulty[];
  tags?: string[];
  status: 'active' | 'archived' | 'all';
  sort?: string;
  page: number;
  pageSize: number;
}

const SORTS = {
  updatedAt: 'q.updated_at',
  createdAt: 'q.created_at',
  prompt: 'v.prompt',
  difficulty: 'v.difficulty',
  type: 'v.type',
  version: 'v.version',
} as const;

/** Deterministic JSON for content comparison (object keys sorted). */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function contentKey(v: { type: string; config: unknown; prompt: string; explanation: string | null; points: number; difficulty: string; categoryId: string | null; competencyIds: readonly string[]; tags: readonly string[] }): string {
  return stable({
    type: v.type,
    config: v.config,
    prompt: v.prompt,
    explanation: v.explanation,
    points: v.points,
    difficulty: v.difficulty,
    categoryId: v.categoryId,
    competencyIds: [...v.competencyIds].sort(),
    tags: [...v.tags].sort(),
  });
}

@Injectable()
export class QuestionsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    private readonly people: People,
  ) {}

  // ---------------------------------------------------------------- reads

  async list(p: Principal, f: QuestionListFilters): Promise<Page<assessment.QuestionSummary>> {
    let query = this.db
      .selectFrom('questions as q')
      .innerJoin('question_versions as v', 'v.id', 'q.current_version_id')
      .innerJoin('question_banks as b', 'b.id', 'q.bank_id')
      .leftJoin('question_categories as c', 'c.id', 'v.category_id')
      .select((eb) => [
        'q.id',
        'q.status',
        'q.updated_at',
        'b.id as bank_id',
        'b.title as bank_title',
        'v.id as version_id',
        'v.version',
        'v.type',
        'v.config',
        'v.prompt',
        'v.difficulty',
        'v.points',
        'v.tags',
        'v.competency_ids',
        'c.id as category_id',
        'c.name as category_name',
        eb
          .selectFrom('assessment_items as i')
          .select(sql<number>`count(distinct i.assessment_id)`.as('n'))
          .whereRef('i.question_id', '=', 'q.id')
          .as('used_in'),
      ])
      .where('q.organization_id', '=', p.organizationId);

    if (f.status !== 'all') query = query.where('q.status', '=', f.status);
    if (f.bankId) query = query.where('q.bank_id', '=', f.bankId);
    if (f.type?.length) query = query.where('v.type', 'in', f.type);
    if (f.categoryId) query = query.where('v.category_id', '=', f.categoryId);
    if (f.competencyId) query = query.where(sql<boolean>`${f.competencyId}::uuid = any(v.competency_ids)`);
    if (f.difficulty?.length) query = query.where('v.difficulty', 'in', f.difficulty);
    if (f.tags?.length) query = query.where(sql<boolean>`v.tags @> ${sql.val(f.tags)}::text[]`);
    if (f.q) {
      const pattern = likePattern(f.q);
      query = query.where((eb) =>
        eb.or([
          eb('v.prompt', 'ilike', pattern),
          eb('v.explanation', 'ilike', pattern),
          eb(sql<string>`array_to_string(v.tags, ' ')`, 'ilike', pattern),
          eb(sql<string>`v.config::text`, 'ilike', pattern),
        ]),
      );
    }
    const desc = f.sort ? f.sort.startsWith('-') : true;
    const key = (f.sort?.replace(/^-/, '') ?? 'updatedAt') as keyof typeof SORTS;
    query = query.orderBy(SORTS[key] ?? SORTS.updatedAt, desc ? 'desc' : 'asc').orderBy('q.id');

    const page = await paginate(query, { page: f.page, pageSize: f.pageSize });
    return {
      ...page,
      items: page.items.map((r) => ({
        id: r.id,
        bank: { id: r.bank_id, title: r.bank_title },
        status: r.status,
        versionId: r.version_id,
        version: r.version,
        type: r.type,
        prompt: r.prompt,
        difficulty: r.difficulty,
        points: r.points,
        category: r.category_id ? { id: r.category_id, name: r.category_name! } : null,
        tags: r.tags,
        competencyIds: r.competency_ids,
        manualReview: assessment.requiresManualReview(toDefinition(r)),
        usedInAssessments: Number(r.used_in ?? 0),
        updatedAt: r.updated_at.toISOString(),
      })),
    };
  }

  private async questionRow(db: DbOrTrx, organizationId: string, id: string, lock = false) {
    let query = db.selectFrom('questions').selectAll().where('id', '=', id).where('organization_id', '=', organizationId);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw new NotFoundError('Question');
    return row;
  }

  /** Map stored versions to API DTOs (category/competency names, author). */
  async versionDtos(db: DbOrTrx, rows: readonly QuestionVersionRow[]): Promise<assessment.QuestionVersion[]> {
    const categoryIds = [...new Set(rows.map((r) => r.category_id).filter((c): c is string => c !== null))];
    const competencyIds = [...new Set(rows.flatMap((r) => r.competency_ids))];
    const [categories, competencies, people] = await Promise.all([
      categoryIds.length ? db.selectFrom('question_categories').select(['id', 'name']).where('id', 'in', categoryIds).execute() : [],
      competencyIds.length ? db.selectFrom('competencies').select(['id', 'name']).where('id', 'in', competencyIds).execute() : [],
      this.people.refs(rows.map((r) => r.created_by)),
    ]);
    const categoryName = new Map(categories.map((c) => [c.id, c.name]));
    const competencyName = new Map(competencies.map((c) => [c.id, c.name]));
    return rows.map(
      (r) =>
        ({
          id: r.id,
          questionId: r.question_id,
          version: r.version,
          type: r.type,
          config: r.config,
          prompt: r.prompt,
          explanation: r.explanation,
          points: r.points,
          difficulty: r.difficulty,
          category: r.category_id ? { id: r.category_id, name: categoryName.get(r.category_id) ?? 'Removed category' } : null,
          // Competencies deleted later are dropped from the view; the version keeps their ids.
          competencies: r.competency_ids.filter((id) => competencyName.has(id)).map((id) => ({ id, name: competencyName.get(id)! })),
          tags: r.tags,
          changeNote: r.change_note,
          createdAt: r.created_at.toISOString(),
          createdBy: refOrNull(people, r.created_by),
        }) as assessment.QuestionVersion,
    );
  }

  async get(p: Principal, id: string): Promise<assessment.QuestionDetail> {
    const q = await this.questionRow(this.db, p.organizationId, id);
    const [bank, current, versionCount, usage, attempts] = await Promise.all([
      this.db.selectFrom('question_banks').select(['id', 'title']).where('id', '=', q.bank_id).executeTakeFirstOrThrow(),
      this.db.selectFrom('question_versions').selectAll().where('id', '=', q.current_version_id).executeTakeFirstOrThrow(),
      this.db.selectFrom('question_versions').select((eb) => eb.fn.countAll<number>().as('n')).where('question_id', '=', id).executeTakeFirstOrThrow(),
      this.db
        .selectFrom('assessment_items as i')
        .innerJoin('assessments as a', 'a.id', 'i.assessment_id')
        .select(['a.id', 'a.title', 'a.status', 'a.kind'])
        .where('i.question_id', '=', id)
        .orderBy('a.title')
        .execute(),
      this.db.selectFrom('attempt_questions').select((eb) => eb.fn.countAll<number>().as('n')).where('question_id', '=', id).executeTakeFirstOrThrow(),
    ]);
    const [currentVersion] = await this.versionDtos(this.db, [current]);
    return {
      id: q.id,
      bank: { id: bank.id, title: bank.title },
      status: q.status,
      archivedAt: q.archived_at?.toISOString() ?? null,
      versionCount: Number(versionCount.n),
      currentVersion: currentVersion!,
      usage: usage.map((u) => ({ assessmentId: u.id, title: u.title, status: u.status, kind: u.kind })),
      attemptCount: Number(attempts.n),
      createdAt: q.created_at.toISOString(),
      updatedAt: q.updated_at.toISOString(),
    };
  }

  async versions(p: Principal, id: string): Promise<assessment.QuestionVersion[]> {
    await this.questionRow(this.db, p.organizationId, id);
    const rows = await this.db.selectFrom('question_versions').selectAll().where('question_id', '=', id).orderBy('version', 'desc').execute();
    return this.versionDtos(this.db, rows);
  }

  private async versionFor(organizationId: string, questionId: string, versionId?: string): Promise<QuestionVersionRow> {
    const q = await this.questionRow(this.db, organizationId, questionId);
    const version = await this.db
      .selectFrom('question_versions')
      .selectAll()
      .where('question_id', '=', questionId)
      .where('id', '=', versionId ?? q.current_version_id)
      .executeTakeFirst();
    if (!version) throw new NotFoundError('Question version');
    return version;
  }

  /** Learner rendering of a version, with options shuffled as an attempt would show them. */
  async preview(p: Principal, id: string, versionId?: string): Promise<assessment.QuestionPreview> {
    const v = await this.versionFor(p.organizationId, id, versionId);
    const def = toDefinition(v);
    return {
      versionId: v.id,
      version: v.version,
      question: learnerQuestion(def, initialOrder(def, true, randomRng()), {
        id: uuidv7(),
        position: 1,
        prompt: v.prompt,
        points: v.points,
        response: null,
        savedAt: null,
      }),
      correctAnswer: correctAnswer(def),
      explanation: v.explanation,
      manualReview: assessment.requiresManualReview(def),
    };
  }

  /** Grade a sample response against a version (editor "try it"). Nothing is stored. */
  async check(p: Principal, id: string, input: { response: assessment.AnswerResponse; versionId?: string }) {
    const v = await this.versionFor(p.organizationId, id, input.versionId);
    const def = toDefinition(v);
    const grade = gradeResponse(def, input.response, v.points);
    const outcome: assessment.QuestionOutcome =
      grade.kind === 'review'
        ? 'pending_review'
        : !isAnswered(input.response)
          ? 'unanswered'
          : grade.correct
            ? 'correct'
            : grade.awarded > 0
              ? 'partial'
              : 'incorrect';
    return {
      outcome,
      awardedPoints: grade.kind === 'review' ? null : grade.awarded,
      points: v.points,
      correctAnswer: correctAnswer(def),
      explanation: v.explanation,
    };
  }

  // ---------------------------------------------------------------- writes

  private async assertReferences(trx: Trx, bankId: string, data: VersionData): Promise<void> {
    const fields: Array<{ path: string; message: string }> = [];
    if (data.categoryId) {
      const category = await trx.selectFrom('question_categories').select('id').where('id', '=', data.categoryId).where('bank_id', '=', bankId).executeTakeFirst();
      if (!category) fields.push({ path: 'categoryId', message: 'Choose a category from this question bank' });
    }
    if (data.competencyIds.length) {
      const found = await trx.selectFrom('competencies').select('id').where('id', 'in', data.competencyIds).where('bank_id', '=', bankId).execute();
      if (found.length !== data.competencyIds.length) fields.push({ path: 'competencyIds', message: 'Choose competencies from this question bank' });
    }
    if (fields.length) throw new ValidationError(fields);
  }

  private versionValues(id: string, questionId: string, organizationId: string, version: number, data: VersionData, actorId: string, changeNote: string | null) {
    return {
      id,
      question_id: questionId,
      organization_id: organizationId,
      version,
      type: data.type,
      prompt: data.prompt,
      config: data.config,
      explanation: data.explanation ?? null,
      points: data.points,
      difficulty: data.difficulty,
      category_id: data.categoryId,
      competency_ids: data.competencyIds,
      tags: data.tags,
      change_note: changeNote,
      created_by: actorId,
    };
  }

  async create(p: Principal, input: CreateInput): Promise<assessment.QuestionDetail> {
    const { bankId, ...data } = input;
    const id = uuidv7();
    const versionId = uuidv7();
    await this.db.transaction().execute(async (trx) => {
      const bank = await trx.selectFrom('question_banks').selectAll().where('id', '=', bankId).where('organization_id', '=', p.organizationId).executeTakeFirst();
      if (!bank) throw new ValidationError([{ path: 'bankId', message: 'Choose an existing question bank' }]);
      if (bank.archived_at) throw new PreconditionError('BANK_ARCHIVED', 'This question bank is archived. Restore it before adding questions.');
      await this.assertReferences(trx, bankId, data as VersionData);
      await trx
        .insertInto('questions')
        .values({
          id,
          organization_id: p.organizationId,
          bank_id: bankId,
          status: 'active',
          current_version_id: versionId,
          archived_at: null,
          created_by: p.userId,
          updated_by: p.userId,
        })
        .execute();
      await trx.insertInto('question_versions').values(this.versionValues(versionId, id, p.organizationId, 1, data as VersionData, p.userId, null)).execute();
      await this.events.audit(trx, {
        action: 'question.created',
        resourceType: 'question',
        resourceId: id,
        actorDisplay: p.displayName,
        after: { bankId, version: 1, versionId, type: data.type, prompt: data.prompt, difficulty: data.difficulty, points: data.points },
      });
    });
    return this.get(p, id);
  }

  /** Editing creates a new immutable version; attempts keep referencing the version they drew. */
  async update(p: Principal, id: string, input: UpdateInput): Promise<assessment.QuestionDetail> {
    const { changeNote, expectedVersion, ...data } = input;
    await this.db.transaction().execute(async (trx) => {
      const q = await this.questionRow(trx, p.organizationId, id, true);
      if (q.status === 'archived') throw new ConflictError('QUESTION_ARCHIVED', 'This question is archived. Restore it before editing.');
      const current = await trx.selectFrom('question_versions').selectAll().where('id', '=', q.current_version_id).executeTakeFirstOrThrow();
      if (expectedVersion !== undefined && expectedVersion !== current.version) {
        throw new ConflictError(
          'QUESTION_CHANGED',
          `Someone saved version ${current.version} of this question while you were editing version ${expectedVersion}. Reload it and apply your changes again.`,
          { currentVersion: current.version },
        );
      }
      const next = data as VersionData;
      await this.assertReferences(trx, q.bank_id, next);
      const unchanged =
        contentKey({ ...next, explanation: next.explanation ?? null }) ===
        contentKey({
          type: current.type,
          config: current.config,
          prompt: current.prompt,
          explanation: current.explanation,
          points: current.points,
          difficulty: current.difficulty,
          categoryId: current.category_id,
          competencyIds: current.competency_ids,
          tags: current.tags,
        });
      if (unchanged) return;
      const versionId = uuidv7();
      await trx
        .insertInto('question_versions')
        .values(this.versionValues(versionId, id, p.organizationId, current.version + 1, next, p.userId, changeNote ?? null))
        .execute();
      await trx.updateTable('questions').set({ current_version_id: versionId, updated_by: p.userId }).where('id', '=', id).execute();
      await this.events.audit(trx, {
        action: 'question.version_created',
        resourceType: 'question',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { version: current.version, versionId: current.id, type: current.type, prompt: current.prompt, points: current.points },
        after: { version: current.version + 1, versionId, type: next.type, prompt: next.prompt, points: next.points },
        reason: changeNote ?? null,
      });
    });
    return this.get(p, id);
  }

  async setArchived(p: Principal, id: string, archived: boolean): Promise<assessment.QuestionDetail> {
    await this.db.transaction().execute(async (trx) => {
      const q = await this.questionRow(trx, p.organizationId, id, true);
      if ((q.status === 'archived') === archived) return;
      if (archived) {
        const fixedIn = await trx
          .selectFrom('assessment_items as i')
          .innerJoin('assessments as a', 'a.id', 'i.assessment_id')
          .select('a.title')
          .where('i.question_id', '=', id)
          .where('a.status', '=', 'published')
          .orderBy('a.title')
          .execute();
        if (fixedIn.length) {
          throw new ConflictError(
            'QUESTION_IN_USE',
            `Published assessments include this question: ${fixedIn.map((a) => a.title).join(', ')}. Remove it from them before archiving.`,
          );
        }
      } else {
        const bank = await trx.selectFrom('question_banks').select('archived_at').where('id', '=', q.bank_id).executeTakeFirstOrThrow();
        if (bank.archived_at) throw new PreconditionError('BANK_ARCHIVED', 'This question belongs to an archived bank. Restore the bank first.');
      }
      await trx
        .updateTable('questions')
        .set({ status: archived ? 'archived' : 'active', archived_at: archived ? new Date() : null, updated_by: p.userId })
        .where('id', '=', id)
        .execute();
      if (archived) await this.assertPublishedPoolsStillSatisfied(trx, p.organizationId, q.bank_id);
      await this.events.audit(trx, {
        action: archived ? 'question.archived' : 'question.restored',
        resourceType: 'question',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { status: q.status },
        after: { status: archived ? 'archived' : 'active' },
      });
    });
    return this.get(p, id);
  }

  /** Published assessments must stay startable: their pools still need enough active questions. */
  private async assertPublishedPoolsStillSatisfied(trx: Trx, organizationId: string, bankId: string): Promise<void> {
    const affected = await trx
      .selectFrom('assessments as a')
      .select(['a.id', 'a.title'])
      .where('a.organization_id', '=', organizationId)
      .where('a.status', '=', 'published')
      .where((eb) => eb.exists(eb.selectFrom('assessment_items as i').select('i.id').whereRef('i.assessment_id', '=', 'a.id').where('i.pool_bank_id', '=', bankId)))
      .execute();
    const broken: string[] = [];
    for (const a of affected) {
      const items = await trx.selectFrom('assessment_items').selectAll().where('assessment_id', '=', a.id).execute();
      const plan = await planItems(trx, organizationId, items);
      if (plan.issues.length) broken.push(a.title);
    }
    if (broken.length) {
      throw new ConflictError(
        'QUESTION_NEEDED_BY_POOL',
        `Archiving this question would leave too few questions for the pools of: ${broken.join(', ')}. Add questions to those pools first.`,
      );
    }
  }
}
