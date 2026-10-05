import { uuidv7 } from '@a5/observability';
import {
  applyDirectoryTeam,
  applyDirectoryUnit,
  applyDirectoryUser,
  type DirectorySchema,
} from '@a5/directory';
import type { InboxSchema, Transaction } from '@a5/database';
import { directoryTeams, directoryUnits, directoryUsers, ORGANIZATION } from '@a5/seed-data';
import type { Db, Trx } from '../database/index.js';
import { RubricsService } from '../rubrics/rubrics.service.js';
import { scenarioColumns } from '../scenarios/scenarios.service.js';
import { syncPromptVersion } from '../scenarios/prompt-versions.service.js';
import { estimateCostUsd, DEFAULT_MODEL_PRICES } from '../providers/pricing.js';
import {
  DEV_SIMULATOR_MODEL,
  buildSeedSessions,
  SEED_AUTHOR_ID,
  SEED_CONTENT_CREATED_AT,
  SEED_PERSONAS,
  SEED_RUBRIC,
  SEED_SCENARIOS,
} from './dataset.js';
import type { Insertable } from '@a5/database';
import type { AiScenariosTable } from '../database/index.js';

export interface SeedOptions {
  log?: (line: string) => void;
}

type DirectoryTrx = Transaction<DirectorySchema & InboxSchema>;

/** Seed (or refresh) the people-directory projection. Revision-guarded, so always safe to repeat. */
export async function seedDirectory(db: Db): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const t = trx as unknown as DirectoryTrx;
    for (const user of directoryUsers()) await applyDirectoryUser(t, user, 1);
    for (const team of directoryTeams()) await applyDirectoryTeam(t, team, 1);
    for (const unit of directoryUnits()) await applyDirectoryUnit(t, unit, 1);
  });
}

async function insertContent(
  trx: Trx,
): Promise<Map<string, { promptVersionId: string; rubricVersionId: string }>> {
  const orgId = ORGANIZATION.id;
  await trx
    .insertInto('ai_settings')
    .values({
      organization_id: orgId,
      default_provider: 'auto',
      conversation_model: null,
      evaluation_model: null,
      max_sessions_per_learner_per_day: 20,
      transcript_retention_days: null,
      timezone: ORGANIZATION.timezone,
      updated_by: null,
    })
    .onConflict((oc) => oc.column('organization_id').doNothing())
    .execute();

  for (const p of SEED_PERSONAS) {
    await trx
      .insertInto('ai_personas')
      .values({
        id: p.id,
        organization_id: orgId,
        name: p.name,
        description: p.description,
        temperament: p.temperament,
        speaking_style: p.speakingStyle,
        background: p.background,
        traits: JSON.stringify(p.traits),
        archived_at: null,
        created_by: SEED_AUTHOR_ID,
        updated_by: SEED_AUTHOR_ID,
        created_at: SEED_CONTENT_CREATED_AT,
        updated_at: SEED_CONTENT_CREATED_AT,
      })
      .execute();
  }

  await RubricsService.insert(trx, {
    id: SEED_RUBRIC.id,
    versionId: SEED_RUBRIC.versionId,
    organizationId: orgId,
    title: SEED_RUBRIC.title,
    description: SEED_RUBRIC.description,
    categories: SEED_RUBRIC.categories,
    passingScore: SEED_RUBRIC.passingScore,
    actorId: SEED_AUTHOR_ID,
    createdAt: SEED_CONTENT_CREATED_AT,
  });

  const versions = new Map<string, { promptVersionId: string; rubricVersionId: string }>();
  for (const s of SEED_SCENARIOS) {
    await trx
      .insertInto('ai_scenarios')
      .values({
        ...(scenarioColumns(s.request) as Insertable<AiScenariosTable>),
        id: s.id,
        organization_id: orgId,
        status: 'published',
        published_at: SEED_CONTENT_CREATED_AT,
        archived_at: null,
        current_prompt_version_id: null,
        created_by: SEED_AUTHOR_ID,
        updated_by: SEED_AUTHOR_ID,
        created_at: SEED_CONTENT_CREATED_AT,
        updated_at: SEED_CONTENT_CREATED_AT,
      })
      .execute();
    const v = await syncPromptVersion(trx, s.id, SEED_AUTHOR_ID, 'Initial version', {
      createdAt: SEED_CONTENT_CREATED_AT,
    });
    versions.set(s.id, { promptVersionId: v.id, rubricVersionId: SEED_RUBRIC.versionId });
  }
  return versions;
}

/**
 * Seed the AI trainer: nine personas, the A5 rubric (14 categories), ten published scenarios with
 * immutable prompt versions, the people directory and a practice history for every learner journey
 * (multi-turn transcripts scored by the development simulator). Idempotent: does nothing for
 * content that already exists. No events are emitted; other services seed their own projections.
 */
export async function seedAi(
  db: Db,
  options: SeedOptions = {},
): Promise<{ created: boolean; sessions: number }> {
  const log = options.log ?? (() => undefined);
  await seedDirectory(db);
  const existing = await db
    .selectFrom('ai_rubrics')
    .select('id')
    .where('id', '=', SEED_RUBRIC.id)
    .executeTakeFirst();
  if (existing) {
    log('ai: content already seeded');
    return { created: false, sessions: 0 };
  }

  const sessions = buildSeedSessions();
  await db.transaction().execute(async (trx) => {
    const versions = await insertContent(trx);
    log(`ai: ${SEED_PERSONAS.length} personas, 1 rubric, ${SEED_SCENARIOS.length} scenarios`);

    for (const s of sessions) {
      const v = versions.get(s.scenarioId)!;
      await trx
        .insertInto('ai_sessions')
        .values({
          id: s.id,
          organization_id: ORGANIZATION.id,
          user_id: s.userId,
          scenario_id: s.scenarioId,
          prompt_version_id: v.promptVersionId,
          rubric_version_id: v.rubricVersionId,
          mode: s.mode,
          is_test: false,
          context: JSON.stringify(s.context),
          modality: 'text',
          status: 'evaluated',
          end_reason: s.endReason,
          provider: 'dev_simulator',
          model: DEV_SIMULATOR_MODEL,
          max_turns: SEED_SCENARIOS.find((x) => x.id === s.scenarioId)!.request.maxTurns,
          turn_count: s.turnCount,
          started_at: s.startedAt,
          ended_at: s.endedAt,
          last_activity_at: s.endedAt,
          evaluation_attempts: 1,
          evaluation_error: null,
          transcript_purged_at: null,
          updated_at: s.evaluatedAt,
        })
        .execute();
      await trx
        .insertInto('ai_messages')
        .values(
          s.messages.map((m) => ({
            id: m.id,
            session_id: s.id,
            organization_id: ORGANIZATION.id,
            seq: m.seq,
            role: m.role,
            content: m.content,
            modality: 'text' as const,
            audio_ref: null,
            client_message_id: null,
            provider: m.role === 'homeowner' && m.seq > 1 ? ('dev_simulator' as const) : null,
            model: m.role === 'homeowner' && m.seq > 1 ? DEV_SIMULATOR_MODEL : null,
            input_tokens: m.inputTokens,
            output_tokens: m.outputTokens,
            latency_ms: m.latencyMs,
            created_at: m.createdAt,
          })),
        )
        .execute();

      const evaluationId = uuidv7(s.evaluatedAt.getTime());
      const card = s.card;
      await trx
        .insertInto('ai_evaluations')
        .values({
          id: evaluationId,
          session_id: s.id,
          organization_id: ORGANIZATION.id,
          user_id: s.userId,
          scenario_id: s.scenarioId,
          is_test: false,
          overall_score: card.overallScore,
          passed: card.passed,
          passing_score: card.passingScore,
          category_scores: JSON.stringify(card.categoryScores),
          strengths: JSON.stringify(card.strengths),
          missed_opportunities: JSON.stringify(card.missedOpportunities),
          questions_to_ask: JSON.stringify(card.questionsToAsk),
          risky_statements: JSON.stringify(card.riskyStatements),
          recommended_responses: JSON.stringify(card.recommendedResponses),
          next_goal: card.nextGoal,
          summary: card.summary,
          provider: 'dev_simulator',
          model: DEV_SIMULATOR_MODEL,
          prompt_version_id: v.promptVersionId,
          rubric_version_id: v.rubricVersionId,
          raw: JSON.stringify({
            simulated: true,
            provider: 'Development simulator',
            output: s.evaluationOutput,
          }),
          created_at: s.evaluatedAt,
        })
        .execute();
      await trx
        .insertInto('ai_evaluation_scores')
        .values(
          card.categoryScores.map((c) => ({
            evaluation_id: evaluationId,
            session_id: s.id,
            organization_id: ORGANIZATION.id,
            user_id: s.userId,
            scenario_id: s.scenarioId,
            category_key: c.key,
            category_label: c.label,
            score: c.score,
            weight: c.weight,
            is_test: false,
            evaluated_at: s.evaluatedAt,
          })),
        )
        .execute();

      const price = (input: number, output: number) =>
        estimateCostUsd(
          DEV_SIMULATOR_MODEL,
          { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 },
          DEFAULT_MODEL_PRICES,
        );
      const usage = (
        purpose: 'conversation' | 'evaluation',
        u: { at: Date; input: number; output: number; latencyMs: number },
      ) => {
        const { costUsd, priced } = price(u.input, u.output);
        return {
          id: uuidv7(u.at.getTime()),
          organization_id: ORGANIZATION.id,
          user_id: s.userId,
          session_id: s.id,
          scenario_id: s.scenarioId,
          purpose,
          is_test: false,
          provider: 'dev_simulator' as const,
          model: DEV_SIMULATOR_MODEL,
          input_tokens: u.input,
          output_tokens: u.output,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          estimated_cost_usd: costUsd,
          priced,
          latency_ms: u.latencyMs,
          success: true,
          error_code: null,
          created_at: u.at,
        };
      };
      await trx
        .insertInto('ai_usage')
        .values([
          ...s.usage.conversation.map((u) => usage('conversation', u)),
          usage('evaluation', s.usage.evaluation),
        ])
        .execute();
    }
    log(`ai: ${sessions.length} practice sessions with transcripts and scorecards`);
  });
  return { created: true, sessions: sessions.length };
}
