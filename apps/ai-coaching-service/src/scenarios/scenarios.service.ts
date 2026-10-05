import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { ai } from '@a5/contracts';
import { isUniqueViolation, likePattern, paginate, sql, type Insertable, type Page, type Selectable } from '@a5/database';
import { ConflictError, EventBus, InjectDb, NotFoundError, ValidationError } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import { iso, isoOrNull } from '../common/people.js';
import type { AiScenariosTable, Db, DbOrTrx, Trx } from '../database/index.js';
import { PromptVersionService } from './prompt-versions.service.js';

type ScenarioRow = Selectable<AiScenariosTable>;

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  category: 'category',
  difficulty: 'difficulty',
  personaId: 'persona',
  objection: 'objection',
  repBrief: 'rep brief',
  background: 'background',
  propertyContext: 'property context',
  trigger: 'trigger',
  hiddenConcern: 'hidden concern',
  expectedBehaviors: 'expected behaviours',
  requiredTalkingPoints: 'talking points',
  forbiddenClaims: 'forbidden claims',
  aiInstructions: 'AI instructions',
  openingLine: 'opening line',
  passingScore: 'passing score',
  rubricId: 'rubric',
  maxTurns: 'max turns',
  provider: 'provider',
  model: 'model',
  evaluationModel: 'evaluation model',
  modelSettings: 'model settings',
};

/** Column values for a scenario from the API shape. */
export function scenarioColumns(input: Partial<ai.CreateScenarioRequest>): Partial<Insertable<AiScenariosTable>> {
  const out: Partial<Insertable<AiScenariosTable>> = {};
  if (input.title !== undefined) out.title = input.title;
  if (input.category !== undefined) out.category = input.category;
  if (input.difficulty !== undefined) out.difficulty = input.difficulty;
  if (input.personaId !== undefined) out.persona_id = input.personaId;
  if (input.objection !== undefined) out.objection = input.objection;
  if (input.repBrief !== undefined) out.rep_brief = input.repBrief;
  if (input.background !== undefined) out.background = input.background;
  if (input.propertyContext !== undefined) out.property_context = input.propertyContext;
  if (input.trigger !== undefined) out.trigger = input.trigger;
  if (input.hiddenConcern !== undefined) out.hidden_concern = input.hiddenConcern;
  if (input.expectedBehaviors !== undefined) out.expected_behaviors = input.expectedBehaviors;
  if (input.requiredTalkingPoints !== undefined) out.required_talking_points = input.requiredTalkingPoints;
  if (input.forbiddenClaims !== undefined) out.forbidden_claims = input.forbiddenClaims;
  if (input.aiInstructions !== undefined) out.ai_instructions = input.aiInstructions;
  if (input.openingLine !== undefined) out.opening_line = input.openingLine;
  if (input.passingScore !== undefined) out.passing_score = input.passingScore;
  if (input.rubricId !== undefined) out.rubric_id = input.rubricId;
  if (input.maxTurns !== undefined) out.max_turns = input.maxTurns;
  if (input.provider !== undefined) out.provider = input.provider;
  if (input.model !== undefined) out.model = input.model;
  if (input.evaluationModel !== undefined) out.evaluation_model = input.evaluationModel;
  if (input.modelSettings !== undefined) out.model_settings = JSON.stringify(input.modelSettings);
  return out;
}

function scenarioQuery(executor: DbOrTrx, organizationId: string) {
  return executor
    .selectFrom('ai_scenarios as s')
    .innerJoin('ai_personas as p', 'p.id', 's.persona_id')
    .innerJoin('ai_rubrics as r', 'r.id', 's.rubric_id')
    .innerJoin('ai_rubric_versions as rv', 'rv.id', 'r.current_version_id')
    .leftJoin('ai_prompt_versions as pv', 'pv.id', 's.current_prompt_version_id')
    .selectAll('s')
    .select([
      'p.name as persona_name',
      'r.title as rubric_title',
      'rv.version as rubric_version',
      'pv.version as prompt_version',
      'pv.created_at as prompt_version_created_at',
      sql<number>`(select count(*)::int from ai_sessions x where x.scenario_id = s.id and not x.is_test)`.as('session_count'),
    ])
    .where('s.organization_id', '=', organizationId);
}

type ScenarioDetailRow = Awaited<ReturnType<ReturnType<typeof scenarioQuery>['executeTakeFirstOrThrow']>>;

@Injectable()
export class ScenariosService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    private readonly versions: PromptVersionService,
  ) {}

  private summary(r: ScenarioDetailRow): ai.ScenarioDetail {
    return {
      id: r.id,
      title: r.title,
      category: r.category,
      difficulty: r.difficulty,
      status: r.status,
      objection: r.objection,
      persona: { id: r.persona_id, name: r.persona_name },
      passingScore: r.passing_score,
      maxTurns: r.max_turns,
      provider: r.provider,
      model: r.model,
      currentPromptVersion:
        r.current_prompt_version_id && r.prompt_version !== null && r.prompt_version_created_at
          ? { id: r.current_prompt_version_id, version: r.prompt_version, createdAt: iso(r.prompt_version_created_at) }
          : null,
      sessionCount: Number(r.session_count),
      publishedAt: isoOrNull(r.published_at),
      updatedAt: iso(r.updated_at),
      repBrief: r.rep_brief,
      background: r.background,
      propertyContext: r.property_context,
      trigger: r.trigger,
      hiddenConcern: r.hidden_concern,
      expectedBehaviors: r.expected_behaviors,
      requiredTalkingPoints: r.required_talking_points,
      forbiddenClaims: r.forbidden_claims,
      aiInstructions: r.ai_instructions,
      openingLine: r.opening_line,
      rubric: { id: r.rubric_id, title: r.rubric_title, currentVersion: r.rubric_version },
      evaluationModel: r.evaluation_model,
      modelSettings: r.model_settings,
      archivedAt: isoOrNull(r.archived_at),
      createdAt: iso(r.created_at),
    };
  }

  async list(
    p: Principal,
    q: { q?: string; status?: string; category?: string; difficulty?: string; personaId?: string; page: number; pageSize: number },
  ): Promise<Page<ai.ScenarioDetail>> {
    let query = scenarioQuery(this.db, p.organizationId);
    if (q.status) query = query.where('s.status', '=', q.status as ScenarioRow['status']);
    else query = query.where('s.status', '<>', 'archived');
    if (q.category) query = query.where('s.category', '=', q.category);
    if (q.difficulty) query = query.where('s.difficulty', '=', q.difficulty as ScenarioRow['difficulty']);
    if (q.personaId) query = query.where('s.persona_id', '=', q.personaId);
    if (q.q) {
      const pattern = likePattern(q.q);
      query = query.where((eb) => eb.or([eb('s.title', 'ilike', pattern), eb('s.objection', 'ilike', pattern), eb('s.category', 'ilike', pattern)]));
    }
    const page = await paginate(query.orderBy('s.category').orderBy('s.title'), q);
    return { ...page, items: page.items.map((r) => this.summary(r)) };
  }

  async get(p: Principal, id: string, executor: DbOrTrx = this.db): Promise<ai.ScenarioDetail> {
    const row = await scenarioQuery(executor, p.organizationId).where('s.id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundError('Scenario');
    return this.summary(row);
  }

  private async assertReferences(executor: DbOrTrx, organizationId: string, personaId: string | undefined, rubricId: string | undefined) {
    const fields: Array<{ path: string; message: string }> = [];
    if (personaId) {
      const persona = await executor
        .selectFrom('ai_personas')
        .select('id')
        .where('id', '=', personaId)
        .where('organization_id', '=', organizationId)
        .where('archived_at', 'is', null)
        .executeTakeFirst();
      if (!persona) fields.push({ path: 'personaId', message: 'Choose an active persona' });
    }
    if (rubricId) {
      const rubric = await executor
        .selectFrom('ai_rubrics')
        .select('id')
        .where('id', '=', rubricId)
        .where('organization_id', '=', organizationId)
        .where('archived_at', 'is', null)
        .executeTakeFirst();
      if (!rubric) fields.push({ path: 'rubricId', message: 'Choose an active rubric' });
    }
    if (fields.length) throw new ValidationError(fields);
  }

  /** Insert a scenario and its first prompt version inside a transaction (API and seed). */
  async insert(trx: Trx, organizationId: string, actorId: string | null, input: ai.CreateScenarioRequest, options: { id?: string; status?: ScenarioRow['status'] } = {}) {
    const id = options.id ?? uuidv7();
    const status = options.status ?? 'draft';
    await trx
      .insertInto('ai_scenarios')
      .values({
        ...(scenarioColumns(input) as Insertable<AiScenariosTable>),
        id,
        organization_id: organizationId,
        status,
        published_at: status === 'published' ? new Date() : null,
        archived_at: null,
        current_prompt_version_id: null,
        created_by: actorId,
        updated_by: actorId,
      })
      .execute();
    const version = await this.versions.sync(trx, id, actorId, input.changeNote ?? 'Initial version');
    return { id, version };
  }

  async create(p: Principal, input: ai.CreateScenarioRequest): Promise<ai.ScenarioDetail> {
    await this.assertReferences(this.db, p.organizationId, input.personaId, input.rubricId);
    let id: string;
    try {
      id = await this.db.transaction().execute(async (trx) => {
        const created = await this.insert(trx, p.organizationId, p.userId, input);
        await this.events.audit(
          trx,
          { action: 'ai.scenario.created', resourceType: 'ai_scenario', resourceId: created.id, actorDisplay: p.displayName, after: { title: input.title, promptVersion: created.version.version } },
          { organizationId: p.organizationId },
        );
        return created.id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('SCENARIO_TITLE_TAKEN', `A scenario titled "${input.title}" already exists. Choose another title.`);
      throw err;
    }
    return this.get(p, id);
  }

  /** Edits are live; prompt-relevant changes create a new immutable prompt version. */
  async update(p: Principal, id: string, input: ai.UpdateScenarioRequest): Promise<ai.ScenarioDetail> {
    const before = await this.get(p, id);
    if (before.status === 'archived') throw new ConflictError('SCENARIO_ARCHIVED', 'This scenario is archived. Duplicate it to make changes.');
    await this.assertReferences(this.db, p.organizationId, input.personaId, input.rubricId);
    const { changeNote, ...fields } = input;
    const changed = Object.keys(fields).filter((k) => FIELD_LABELS[k]);
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('ai_scenarios')
          .set({ ...scenarioColumns(fields), revision: sql<number>`revision + 1`, updated_by: p.userId })
          .where('id', '=', id)
          .execute();
        const version = await this.versions.sync(trx, id, p.userId, changeNote ?? `Edited ${changed.map((k) => FIELD_LABELS[k]).join(', ')}`);
        await this.events.audit(
          trx,
          {
            action: 'ai.scenario.updated',
            resourceType: 'ai_scenario',
            resourceId: id,
            actorDisplay: p.displayName,
            before: Object.fromEntries(changed.map((k) => [k, (before as Record<string, unknown>)[k]])),
            after: fields,
            metadata: { promptVersion: version.version, newPromptVersion: version.created },
          },
          { organizationId: p.organizationId },
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('SCENARIO_TITLE_TAKEN', `A scenario titled "${input.title}" already exists. Choose another title.`);
      throw err;
    }
    return this.get(p, id);
  }

  async publish(p: Principal, id: string): Promise<ai.ScenarioDetail> {
    const scenario = await this.get(p, id);
    if (scenario.status === 'published') return scenario;
    if (scenario.status === 'archived') throw new ConflictError('SCENARIO_ARCHIVED', 'Archived scenarios cannot be published. Duplicate it instead.');
    await this.assertReferences(this.db, p.organizationId, scenario.persona.id, scenario.rubric.id);
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('ai_scenarios').set({ status: 'published', published_at: new Date(), updated_by: p.userId }).where('id', '=', id).execute();
      await this.events.audit(trx, { action: 'ai.scenario.published', resourceType: 'ai_scenario', resourceId: id, actorDisplay: p.displayName }, { organizationId: p.organizationId });
    });
    return this.get(p, id);
  }

  async archive(p: Principal, id: string): Promise<ai.ScenarioDetail> {
    const scenario = await this.get(p, id);
    if (scenario.status === 'archived') return scenario;
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('ai_scenarios').set({ status: 'archived', archived_at: new Date(), updated_by: p.userId }).where('id', '=', id).execute();
      await this.events.audit(trx, { action: 'ai.scenario.archived', resourceType: 'ai_scenario', resourceId: id, actorDisplay: p.displayName }, { organizationId: p.organizationId });
    });
    return this.get(p, id);
  }

  async duplicate(p: Principal, id: string, input: { title?: string }): Promise<ai.ScenarioDetail> {
    const source = await this.get(p, id);
    let title = input.title ?? `${source.title} (copy)`;
    if (!input.title) {
      for (let n = 2; n < 50; n++) {
        const taken = await this.db
          .selectFrom('ai_scenarios')
          .select('id')
          .where('organization_id', '=', p.organizationId)
          .where(sql<boolean>`lower(title) = lower(${title})`)
          .where('status', '<>', 'archived')
          .executeTakeFirst();
        if (!taken) break;
        title = `${source.title} (copy ${n})`;
      }
    }
    const body: ai.CreateScenarioRequest = {
      title,
      category: source.category,
      difficulty: source.difficulty,
      personaId: source.persona.id,
      objection: source.objection,
      repBrief: source.repBrief,
      background: source.background,
      propertyContext: source.propertyContext,
      trigger: source.trigger,
      hiddenConcern: source.hiddenConcern,
      expectedBehaviors: source.expectedBehaviors,
      requiredTalkingPoints: source.requiredTalkingPoints,
      forbiddenClaims: source.forbiddenClaims,
      aiInstructions: source.aiInstructions,
      openingLine: source.openingLine,
      passingScore: source.passingScore,
      rubricId: source.rubric.id,
      maxTurns: source.maxTurns,
      provider: source.provider,
      model: source.model,
      evaluationModel: source.evaluationModel,
      modelSettings: source.modelSettings,
      changeNote: `Duplicated from "${source.title}" v${source.currentPromptVersion?.version ?? 1}`,
    };
    return this.create(p, body);
  }
}
