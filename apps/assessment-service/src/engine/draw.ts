import type { assessment } from '@a5/contracts';
import { sql } from '@a5/database';
import type { AssessmentItemRow, DbOrTrx } from '../database/index.js';
import { allocatePools } from './allocation.js';
import { initialOrder, toDefinition } from './question-types.js';
import { shuffle, type Rng } from './random.js';

export interface CandidateQuestion {
  questionId: string;
  status: assessment.QuestionStatus;
  versionId: string;
  version: number;
  def: assessment.QuestionDefinition;
  prompt: string;
  explanation: string | null;
  difficulty: assessment.Difficulty;
  categoryId: string | null;
  points: number;
}

function candidateQuery(db: DbOrTrx, organizationId: string) {
  return db
    .selectFrom('questions as q')
    .innerJoin('question_versions as v', 'v.id', 'q.current_version_id')
    .select([
      'q.id as question_id',
      'q.status',
      'v.id as version_id',
      'v.version',
      'v.type',
      'v.config',
      'v.prompt',
      'v.explanation',
      'v.difficulty',
      'v.category_id',
      'v.points',
    ])
    .where('q.organization_id', '=', organizationId);
}

type CandidateRow = Awaited<ReturnType<ReturnType<typeof candidateQuery>['execute']>>[number];

function toCandidate(r: CandidateRow): CandidateQuestion {
  return {
    questionId: r.question_id,
    status: r.status,
    versionId: r.version_id,
    version: r.version,
    def: toDefinition(r),
    prompt: r.prompt,
    explanation: r.explanation,
    difficulty: r.difficulty,
    categoryId: r.category_id,
    points: r.points,
  };
}

/** Current versions of the given questions (any status). */
export async function currentVersions(db: DbOrTrx, organizationId: string, questionIds: readonly string[]): Promise<Map<string, CandidateQuestion>> {
  if (questionIds.length === 0) return new Map();
  const rows = await candidateQuery(db, organizationId).where('q.id', 'in', [...new Set(questionIds)]).execute();
  return new Map(rows.map((r) => [r.question_id, toCandidate(r)]));
}

export interface PoolRule {
  bankId: string;
  categoryId: string | null;
  difficulty: assessment.Difficulty | null;
  tags: readonly string[];
}

/**
 * Ids of active questions whose current version matches a pool rule, in a stable order. Only ids are
 * loaded: banks can hold thousands of questions and counting candidates must not read their content.
 */
export async function poolCandidateIds(db: DbOrTrx, organizationId: string, rule: PoolRule): Promise<string[]> {
  let query = db
    .selectFrom('questions as q')
    .innerJoin('question_versions as v', 'v.id', 'q.current_version_id')
    .select('q.id')
    .where('q.organization_id', '=', organizationId)
    .where('q.bank_id', '=', rule.bankId)
    .where('q.status', '=', 'active');
  if (rule.categoryId) query = query.where('v.category_id', '=', rule.categoryId);
  if (rule.difficulty) query = query.where('v.difficulty', '=', rule.difficulty);
  if (rule.tags.length) query = query.where(sql<boolean>`v.tags @> ${sql.val([...rule.tags])}::text[]`);
  return (await query.orderBy('q.id').execute()).map((r) => r.id);
}

export function poolRuleOf(item: AssessmentItemRow): PoolRule {
  return {
    bankId: item.pool_bank_id!,
    categoryId: item.pool_category_id,
    difficulty: item.pool_difficulty,
    tags: item.pool_tags,
  };
}

export type ValidationIssue = assessment.AssessmentValidation['issues'][number];

export interface ItemPlan {
  issues: ValidationIssue[];
  fixed: Array<{ item: AssessmentItemRow; question: CandidateQuestion }>;
  pools: Array<{ item: AssessmentItemRow; candidates: string[] }>;
}

async function describePools(db: DbOrTrx, items: readonly AssessmentItemRow[]): Promise<Map<string, string>> {
  const bankIds = [...new Set(items.map((i) => i.pool_bank_id!))];
  const categoryIds = [...new Set(items.map((i) => i.pool_category_id).filter((c): c is string => c !== null))];
  const [banks, categories] = await Promise.all([
    bankIds.length ? db.selectFrom('question_banks').select(['id', 'title']).where('id', 'in', bankIds).execute() : [],
    categoryIds.length ? db.selectFrom('question_categories').select(['id', 'name']).where('id', 'in', categoryIds).execute() : [],
  ]);
  const bank = new Map(banks.map((b) => [b.id, b.title]));
  const category = new Map(categories.map((c) => [c.id, c.name]));
  return new Map(
    items.map((i) => {
      const parts = [i.pool_category_id ? (category.get(i.pool_category_id) ?? 'removed category') : bank.get(i.pool_bank_id!) ?? 'removed bank'];
      if (i.pool_difficulty) parts.push(i.pool_difficulty);
      if (i.pool_tags.length) parts.push(`tags: ${i.pool_tags.join(', ')}`);
      return [i.id, parts.join(' · ')];
    }),
  );
}

/** Resolve fixed questions and pool candidates and report everything that would prevent a draw. */
export async function planItems(db: DbOrTrx, organizationId: string, items: readonly AssessmentItemRow[]): Promise<ItemPlan> {
  const issues: ValidationIssue[] = [];
  const sorted = [...items].sort((a, b) => a.position - b.position);
  if (sorted.length === 0) {
    issues.push({ code: 'NO_ITEMS', message: 'Add at least one question or question pool.', itemId: null, position: null });
  }

  const fixedItems = sorted.filter((i) => i.kind === 'question');
  const versions = await currentVersions(db, organizationId, fixedItems.map((i) => i.question_id!));
  const fixed: ItemPlan['fixed'] = [];
  for (const item of fixedItems) {
    const question = versions.get(item.question_id!);
    if (!question) {
      issues.push({ code: 'QUESTION_MISSING', message: `The question at position ${item.position} no longer exists. Remove it.`, itemId: item.id, position: item.position });
    } else if (question.status !== 'active') {
      issues.push({
        code: 'QUESTION_ARCHIVED',
        message: `The question at position ${item.position} is archived. Restore it or replace it with an active question.`,
        itemId: item.id,
        position: item.position,
      });
    } else {
      fixed.push({ item, question });
    }
  }

  const fixedIds = new Set(fixedItems.map((i) => i.question_id!));
  const poolItems = sorted.filter((i) => i.kind === 'pool');
  const names = poolItems.length ? await describePools(db, poolItems) : new Map<string, string>();
  const pools: ItemPlan['pools'] = [];
  for (const item of poolItems) {
    const candidates = (await poolCandidateIds(db, organizationId, poolRuleOf(item))).filter((id) => !fixedIds.has(id));
    pools.push({ item, candidates });
    if (candidates.length < item.pool_count!) {
      issues.push({
        code: 'POOL_TOO_SMALL',
        message: `The pool at position ${item.position} (${names.get(item.id)}) needs ${item.pool_count} questions but only ${candidates.length} active ${candidates.length === 1 ? 'question matches' : 'questions match'} that are not already fixed items.`,
        itemId: item.id,
        position: item.position,
      });
    }
  }

  if (pools.length > 1 && !issues.some((i) => i.code === 'POOL_TOO_SMALL')) {
    const allocation = allocatePools(pools.map((p) => ({ key: p.item.id, count: p.item.pool_count!, candidates: p.candidates })));
    for (const shortfall of allocation.shortfalls) {
      const item = poolItems.find((i) => i.id === shortfall.key)!;
      issues.push({
        code: 'POOLS_OVERLAP',
        message: `The pool at position ${item.position} (${names.get(item.id)}) shares its questions with other pools; together they need more distinct questions than are available. Lower a count or widen a rule.`,
        itemId: item.id,
        position: item.position,
      });
    }
  }
  return { issues, fixed, pools };
}

export async function validateItems(db: DbOrTrx, organizationId: string, items: readonly AssessmentItemRow[]): Promise<assessment.AssessmentValidation> {
  const plan = await planItems(db, organizationId, items);
  return {
    valid: plan.issues.length === 0,
    questionCount: items.reduce((n, i) => n + (i.kind === 'question' ? 1 : i.pool_count!), 0),
    issues: plan.issues,
    pools: plan.pools.map((p) => ({ itemId: p.item.id, position: p.item.position, required: p.item.pool_count!, available: p.candidates.length })),
  };
}

export interface DrawnQuestion {
  itemId: string;
  source: 'question' | 'pool';
  question: CandidateQuestion;
  points: number;
  optionOrder: assessment.OptionOrder;
}

export class DrawError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(issues.map((i) => i.message).join(' '));
    this.name = 'DrawError';
  }
}

/**
 * Draw the questions of one attempt: fixed items, then pool rules (distinct questions across pools),
 * in item order unless questions are randomized; option order per question. The result is
 * snapshotted on the attempt, so resuming never redraws.
 */
export async function drawQuestions(
  db: DbOrTrx,
  organizationId: string,
  items: readonly AssessmentItemRow[],
  config: { randomizeQuestions: boolean; randomizeOptions: boolean },
  rng: Rng,
): Promise<DrawnQuestion[]> {
  const plan = await planItems(db, organizationId, items);
  if (plan.issues.length) throw new DrawError(plan.issues);

  const allocation = allocatePools(
    plan.pools.map((p) => ({ key: p.item.id, count: p.item.pool_count!, candidates: p.candidates })),
    rng,
  );
  if (!allocation.ok) {
    throw new DrawError([{ code: 'POOLS_OVERLAP', message: 'The question pools cannot be filled with distinct questions.', itemId: null, position: null }]);
  }
  // Only the drawn questions are loaded in full.
  const drawnVersions = await currentVersions(db, organizationId, [...allocation.assigned.values()].flat());

  const sequence: Array<Omit<DrawnQuestion, 'optionOrder'>> = [];
  for (const item of [...items].sort((a, b) => a.position - b.position)) {
    if (item.kind === 'question') {
      const entry = plan.fixed.find((f) => f.item.id === item.id)!;
      sequence.push({ itemId: item.id, source: 'question', question: entry.question, points: item.points ?? entry.question.points });
    } else {
      for (const questionId of allocation.assigned.get(item.id) ?? []) {
        const question = drawnVersions.get(questionId);
        if (!question) {
          throw new DrawError([{ code: 'QUESTION_MISSING', message: 'A drawn question was removed while the attempt was being prepared. Try again.', itemId: item.id, position: item.position }]);
        }
        sequence.push({ itemId: item.id, source: 'pool', question, points: item.points ?? question.points });
      }
    }
  }
  const ordered = config.randomizeQuestions ? shuffle(sequence, rng) : sequence;
  return ordered.map((q) => ({ ...q, optionOrder: initialOrder(q.question.def, config.randomizeOptions, rng) }));
}
