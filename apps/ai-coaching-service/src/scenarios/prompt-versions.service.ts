import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { ai } from '@a5/contracts';
import { sql, type Selectable } from '@a5/database';
import { InjectDb, NotFoundError } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import { People, iso } from '../common/people.js';
import type { AiPromptVersionsTable, Db, Trx } from '../database/index.js';
import { compilePromptVersion, promptContentHash } from '../prompts/compiler.js';
import { personaSnapshot, scenarioSnapshot } from '../prompts/snapshots.js';

type VersionRow = Selectable<AiPromptVersionsTable>;

function stable(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * Make a scenario's current prompt version match its live configuration: compile the prompts from
 * persona + scenario + the rubric's current version and insert a new immutable version when the
 * content hash changed. Shared by the API and the seed (`createdAt` back-dates seeded versions).
 */
export async function syncPromptVersion(
  trx: Trx,
  scenarioId: string,
  actorId: string | null,
  changeNote: string | null,
  options: { createdAt?: Date } = {},
): Promise<{ id: string; version: number; created: boolean }> {
  const scenario = await trx
    .selectFrom('ai_scenarios')
    .selectAll()
    .where('id', '=', scenarioId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const persona = await trx
    .selectFrom('ai_personas')
    .selectAll()
    .where('id', '=', scenario.persona_id)
    .executeTakeFirstOrThrow();
  const rubricVersion = await trx
    .selectFrom('ai_rubrics as r')
    .innerJoin('ai_rubric_versions as v', 'v.id', 'r.current_version_id')
    .select(['v.id', 'v.categories'])
    .where('r.id', '=', scenario.rubric_id)
    .executeTakeFirstOrThrow();
  const content = compilePromptVersion({
    persona: personaSnapshot(persona),
    scenario: scenarioSnapshot(scenario),
    categories: rubricVersion.categories,
    rubricVersionId: rubricVersion.id,
    provider: scenario.provider,
    model: scenario.model,
    evaluationModel: scenario.evaluation_model,
    modelSettings: scenario.model_settings,
  });
  const hash = promptContentHash(content);
  if (scenario.current_prompt_version_id) {
    const current = await trx
      .selectFrom('ai_prompt_versions')
      .select(['id', 'version', 'content_hash'])
      .where('id', '=', scenario.current_prompt_version_id)
      .executeTakeFirst();
    if (current?.content_hash === hash)
      return { id: current.id, version: current.version, created: false };
  }
  const { v } = await trx
    .selectFrom('ai_prompt_versions')
    .select(sql<number>`coalesce(max(version), 0)::int`.as('v'))
    .where('scenario_id', '=', scenarioId)
    .executeTakeFirstOrThrow();
  const id = uuidv7();
  const version = Number(v) + 1;
  await trx
    .insertInto('ai_prompt_versions')
    .values({
      id,
      organization_id: scenario.organization_id,
      scenario_id: scenarioId,
      version,
      homeowner_system_prompt: content.homeownerSystemPrompt,
      evaluator_system_prompt: content.evaluatorSystemPrompt,
      persona_snapshot: JSON.stringify(content.personaSnapshot),
      scenario_snapshot: JSON.stringify(content.scenarioSnapshot),
      provider: content.provider,
      model: content.model,
      model_settings: JSON.stringify(content.modelSettings),
      evaluation_model: content.evaluationModel,
      rubric_version_id: content.rubricVersionId,
      content_hash: hash,
      change_note: changeNote ?? (version === 1 ? 'Initial version' : null),
      created_by: actorId,
      ...(options.createdAt && { created_at: options.createdAt }),
    })
    .execute();
  await trx
    .updateTable('ai_scenarios')
    .set({ current_prompt_version_id: id })
    .where('id', '=', scenarioId)
    .execute();
  return { id, version, created: true };
}

/**
 * Immutable prompt versions. Any change to a scenario's prompt-relevant fields, its persona or its
 * rubric produces a new version; sessions and evaluations keep pointing at the version they ran under.
 */
@Injectable()
export class PromptVersionService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly people: People,
  ) {}

  /** Make the scenario's current version match its live configuration. */
  sync(trx: Trx, scenarioId: string, actorId: string | null, changeNote: string | null) {
    return syncPromptVersion(trx, scenarioId, actorId, changeNote);
  }

  /** New versions for every live scenario that uses a persona (after a persona edit). */
  async syncForPersona(
    trx: Trx,
    personaId: string,
    actorId: string | null,
    note: string,
  ): Promise<number> {
    const rows = await trx
      .selectFrom('ai_scenarios')
      .select('id')
      .where('persona_id', '=', personaId)
      .where('status', '<>', 'archived')
      .execute();
    let created = 0;
    for (const r of rows) if ((await this.sync(trx, r.id, actorId, note)).created) created++;
    return created;
  }

  /** New versions for every live scenario that uses a rubric (after a new rubric version). */
  async syncForRubric(
    trx: Trx,
    rubricId: string,
    actorId: string | null,
    note: string,
  ): Promise<number> {
    const rows = await trx
      .selectFrom('ai_scenarios')
      .select('id')
      .where('rubric_id', '=', rubricId)
      .where('status', '<>', 'archived')
      .execute();
    let created = 0;
    for (const r of rows) if ((await this.sync(trx, r.id, actorId, note)).created) created++;
    return created;
  }

  private async scenarioOf(p: Principal, scenarioId: string) {
    const scenario = await this.db
      .selectFrom('ai_scenarios')
      .select(['id', 'current_prompt_version_id'])
      .where('id', '=', scenarioId)
      .where('organization_id', '=', p.organizationId)
      .executeTakeFirst();
    if (!scenario) throw new NotFoundError('Scenario');
    return scenario;
  }

  private async summaries(
    rows: VersionRow[],
    currentId: string | null,
  ): Promise<ai.PromptVersionDetail[]> {
    const counts = rows.length
      ? await this.db
          .selectFrom('ai_sessions')
          .select(['prompt_version_id', sql<number>`count(*)::int`.as('n')])
          .where(
            'prompt_version_id',
            'in',
            rows.map((r) => r.id),
          )
          .groupBy('prompt_version_id')
          .execute()
      : [];
    const people = await this.people.refs(rows.map((r) => r.created_by));
    return rows.map((r) => ({
      id: r.id,
      scenarioId: r.scenario_id,
      version: r.version,
      changeNote: r.change_note,
      provider: r.provider,
      model: r.model,
      evaluationModel: r.evaluation_model,
      rubricVersionId: r.rubric_version_id,
      current: r.id === currentId,
      sessionCount: Number(counts.find((c) => c.prompt_version_id === r.id)?.n ?? 0),
      createdBy: r.created_by ? (people.get(r.created_by) ?? null) : null,
      createdAt: iso(r.created_at),
      homeownerSystemPrompt: r.homeowner_system_prompt,
      evaluatorSystemPrompt: r.evaluator_system_prompt,
      personaSnapshot: r.persona_snapshot,
      scenarioSnapshot: r.scenario_snapshot,
      modelSettings: r.model_settings,
    }));
  }

  async list(p: Principal, scenarioId: string): Promise<{ items: ai.PromptVersionDetail[] }> {
    const scenario = await this.scenarioOf(p, scenarioId);
    const rows = await this.db
      .selectFrom('ai_prompt_versions')
      .selectAll()
      .where('scenario_id', '=', scenarioId)
      .orderBy('version', 'desc')
      .execute();
    return { items: await this.summaries(rows, scenario.current_prompt_version_id) };
  }

  async get(p: Principal, scenarioId: string, versionId: string): Promise<ai.PromptVersionDetail> {
    const scenario = await this.scenarioOf(p, scenarioId);
    const row = await this.db
      .selectFrom('ai_prompt_versions')
      .selectAll()
      .where('id', '=', versionId)
      .where('scenario_id', '=', scenarioId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Prompt version');
    return (await this.summaries([row], scenario.current_prompt_version_id))[0]!;
  }

  /** Field-level differences between two versions of the same scenario. */
  async diff(
    p: Principal,
    scenarioId: string,
    fromId: string,
    toId: string,
  ): Promise<ai.PromptVersionDiff> {
    const [from, to] = await Promise.all([
      this.get(p, scenarioId, fromId),
      this.get(p, scenarioId, toId),
    ]);
    const flatten = (v: ai.PromptVersionDetail): Record<string, unknown> => ({
      homeownerSystemPrompt: v.homeownerSystemPrompt,
      evaluatorSystemPrompt: v.evaluatorSystemPrompt,
      provider: v.provider,
      model: v.model,
      evaluationModel: v.evaluationModel,
      modelSettings: v.modelSettings,
      rubricVersionId: v.rubricVersionId,
      ...Object.fromEntries(
        Object.entries(v.personaSnapshot).map(([k, val]) => [`persona.${k}`, val]),
      ),
      ...Object.fromEntries(
        Object.entries(v.scenarioSnapshot).map(([k, val]) => [`scenario.${k}`, val]),
      ),
    });
    const a = flatten(from);
    const b = flatten(to);
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    const changes = fields
      .filter((f) => stable(a[f]) !== stable(b[f]))
      .map((field) => ({ field, before: a[field] ?? null, after: b[field] ?? null }));
    return { from, to, changes };
  }
}
