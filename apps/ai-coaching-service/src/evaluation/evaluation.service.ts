import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { sql } from '@a5/database';
import { aiEvents } from '@a5/events';
import { QueueFactory, type Job, type JobData } from '@a5/messaging';
import { AppError, EventBus, InjectDb, LOGGER, runsWorkers } from '@a5/nest-kit';
import { uuidv7, type Logger } from '@a5/observability';
import { AI_CONFIG, type AiConfig } from '../config.js';
import type { Db, SessionStatus } from '../database/index.js';
import { formatTranscriptForEvaluation } from '../prompts/compiler.js';
import { readPersonaSnapshot, readScenarioSnapshot } from '../prompts/snapshots.js';
import { ProviderRegistry } from '../providers/registry.js';
import { ProviderError } from '../providers/types.js';
import { SettingsService } from '../settings/settings.service.js';
import { UsageService } from '../usage/usage.service.js';
import { normalizeEvaluation } from './normalize.js';
import { EVALUATION_SCHEMA_DESCRIPTION, EVALUATION_SCHEMA_NAME, evaluationOutputSchema } from './output-schema.js';

export const EVALUATION_QUEUE = 'ai.evaluate';

interface EvaluateJob {
  sessionId: string;
}

const EVALUABLE: SessionStatus[] = ['ended', 'evaluating', 'evaluation_failed'];

function failureMessage(err: unknown): string {
  if (err instanceof ProviderError) {
    switch (err.kind) {
      case 'auth':
        return 'Scoring failed because the AI provider rejected its credentials. An administrator needs to check the AI settings.';
      case 'refusal':
        return 'The scoring model declined to evaluate this conversation. Retry the evaluation or ask a trainer to review it.';
      case 'invalid_output':
        return 'The scoring model returned an incomplete scorecard. Retry the evaluation.';
      default:
        return 'The scoring service was unavailable. Retry the evaluation in a few minutes.';
    }
  }
  if (err instanceof AppError) return err.message;
  return 'Scoring failed unexpectedly. Retry the evaluation.';
}

/**
 * Asynchronous scoring (`ai.evaluate`, job id = session id). The worker calls the provider's
 * structured output with the rubric and transcript, verifies every quote, computes the overall
 * score from the rubric weights and stores the scorecard once (unique per session), emitting
 * `ai.score.generated` in the same transaction.
 */
@Injectable()
export class EvaluationService implements OnModuleInit {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly queues: QueueFactory,
    private readonly registry: ProviderRegistry,
    private readonly settings: SettingsService,
    private readonly usage: UsageService,
    private readonly events: EventBus,
    @Inject(AI_CONFIG) private readonly config: AiConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit() {
    if (runsWorkers(this.config)) {
      this.queues.worker<EvaluateJob>(EVALUATION_QUEUE, (job) => this.processJob(job), { concurrency: 4 });
    }
  }

  /** Queue scoring. `replace` clears a finished job with the same id (retry after a failure). */
  async enqueue(sessionId: string, { replace = false }: { replace?: boolean } = {}): Promise<void> {
    if (replace) {
      const existing = await this.queues.queue<EvaluateJob>(EVALUATION_QUEUE).getJob(sessionId);
      if (existing && ((await existing.isFailed()) || (await existing.isCompleted()))) await existing.remove();
    }
    await this.queues.add<EvaluateJob>(EVALUATION_QUEUE, 'evaluate', { sessionId }, {
      jobId: sessionId,
      attempts: this.config.ai.evaluationAttempts,
      backoff: { type: 'exponential', delay: this.config.ai.evaluationBackoffMs },
    });
  }

  async processJob(job: Job<JobData<EvaluateJob>>): Promise<void> {
    const { sessionId } = job.data;
    try {
      await this.evaluate(sessionId);
    } catch (err) {
      const retryable = err instanceof ProviderError ? err.retryable : !(err instanceof AppError && err.status < 500);
      const exhausted = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (!retryable || exhausted) {
        await this.markFailed(sessionId, failureMessage(err));
        this.logger.error({ err, sessionId, attempt: job.attemptsMade + 1 }, 'AI evaluation failed permanently');
        if (!retryable) return;
      }
      throw err;
    }
  }

  async markFailed(sessionId: string, message: string): Promise<void> {
    await this.db
      .updateTable('ai_sessions')
      .set({ status: 'evaluation_failed', evaluation_error: message })
      .where('id', '=', sessionId)
      .where('status', 'in', ['ended', 'evaluating'])
      .execute();
  }

  /** One scoring attempt. Idempotent: a second run for an evaluated session does nothing. */
  async evaluate(sessionId: string): Promise<'evaluated' | 'skipped'> {
    const session = await this.db.selectFrom('ai_sessions').selectAll().where('id', '=', sessionId).executeTakeFirst();
    if (!session || !EVALUABLE.includes(session.status)) return 'skipped';
    const existing = await this.db.selectFrom('ai_evaluations').select('id').where('session_id', '=', sessionId).executeTakeFirst();
    if (existing) {
      await this.db.updateTable('ai_sessions').set({ status: 'evaluated', evaluation_error: null }).where('id', '=', sessionId).execute();
      return 'skipped';
    }
    await this.db
      .updateTable('ai_sessions')
      .set({ status: 'evaluating', evaluation_attempts: sql<number>`evaluation_attempts + 1` })
      .where('id', '=', sessionId)
      .where('status', 'in', EVALUABLE)
      .execute();

    const [pv, rubric, transcript] = await Promise.all([
      this.db.selectFrom('ai_prompt_versions').selectAll().where('id', '=', session.prompt_version_id).executeTakeFirstOrThrow(),
      this.db.selectFrom('ai_rubric_versions').selectAll().where('id', '=', session.rubric_version_id).executeTakeFirstOrThrow(),
      this.db.selectFrom('ai_messages').select(['seq', 'role', 'content']).where('session_id', '=', sessionId).orderBy('seq').execute(),
    ]);
    const persona = readPersonaSnapshot(pv.persona_snapshot);
    const scenario = readScenarioSnapshot(pv.scenario_snapshot);
    const settings = await this.settings.get(session.organization_id);
    const { provider, model } = this.registry.resolve('evaluation', { provider: pv.provider, model: pv.evaluation_model, settings });
    const usageBase = {
      organizationId: session.organization_id,
      userId: session.user_id,
      sessionId,
      scenarioId: session.scenario_id,
      purpose: 'evaluation' as const,
      isTest: session.is_test,
      provider: provider.name,
    };

    const started = Date.now();
    let result;
    try {
      result = await provider.structured(evaluationOutputSchema, [{ role: 'user', content: formatTranscriptForEvaluation(transcript, session.end_reason) }], {
        model,
        system: pv.evaluator_system_prompt,
        maxOutputTokens: this.config.ai.providers.evaluationMaxTokens,
        timeoutMs: this.config.ai.providers.evaluationTimeoutMs,
        effort: pv.model_settings.evaluationEffort ?? this.config.ai.providers.evaluationEffort,
        schemaName: EVALUATION_SCHEMA_NAME,
        schemaDescription: EVALUATION_SCHEMA_DESCRIPTION,
        simulation: { kind: 'evaluation', persona, scenario, categories: rubric.categories, transcript, endReason: session.end_reason },
      });
    } catch (err) {
      const perr = err instanceof ProviderError ? err : null;
      await this.usage.record(null, { ...usageBase, model, usage: perr?.usage, latencyMs: Date.now() - started, success: false, errorCode: perr?.code ?? 'AI_EVALUATION_ERROR' });
      throw err;
    }
    let card;
    try {
      card = normalizeEvaluation(provider.name, result.value, rubric.categories, transcript, scenario.passingScore);
    } catch (err) {
      await this.usage.record(null, { ...usageBase, model: result.model, usage: result.usage, latencyMs: Date.now() - started, success: false, errorCode: (err as ProviderError).code });
      throw err;
    }

    const evaluationId = uuidv7();
    const evaluatedAt = new Date();
    const inserted = await this.db.transaction().execute(async (trx) => {
      await this.usage.record(trx, { ...usageBase, model: result.model, usage: result.usage, latencyMs: Date.now() - started, success: true });
      const row = await trx
        .insertInto('ai_evaluations')
        .values({
          id: evaluationId,
          session_id: sessionId,
          organization_id: session.organization_id,
          user_id: session.user_id,
          scenario_id: session.scenario_id,
          is_test: session.is_test,
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
          provider: provider.name,
          model: result.model,
          prompt_version_id: session.prompt_version_id,
          rubric_version_id: session.rubric_version_id,
          raw: JSON.stringify(result.value),
          created_at: evaluatedAt,
        })
        .onConflict((oc) => oc.column('session_id').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!row) return false;
      await trx
        .insertInto('ai_evaluation_scores')
        .values(
          card.categoryScores.map((c) => ({
            evaluation_id: evaluationId,
            session_id: sessionId,
            organization_id: session.organization_id,
            user_id: session.user_id,
            scenario_id: session.scenario_id,
            category_key: c.key,
            category_label: c.label,
            score: c.score,
            weight: c.weight,
            is_test: session.is_test,
            evaluated_at: evaluatedAt,
          })),
        )
        .execute();
      await trx.updateTable('ai_sessions').set({ status: 'evaluated', evaluation_error: null }).where('id', '=', sessionId).execute();
      if (!session.is_test) {
        await this.events.emit(
          trx,
          aiEvents.scoreGenerated,
          {
            sessionId,
            scenarioId: session.scenario_id,
            scenarioTitle: scenario.title,
            scenarioCategory: scenario.category,
            difficulty: scenario.difficulty,
            userId: session.user_id,
            overallScore: card.overallScore,
            passed: card.passed,
            passingScore: card.passingScore,
            categoryScores: card.categoryScores.map((c) => ({ key: c.key, label: c.label, score: c.score })),
            context: session.context,
            evaluatedAt: evaluatedAt.toISOString(),
            promptVersionId: session.prompt_version_id,
            rubricVersionId: session.rubric_version_id,
          },
          { subject: { type: 'ai_session', id: sessionId }, organizationId: session.organization_id, actor: { type: 'service', id: 'ai-coaching-service' } },
        );
      }
      return true;
    });
    return inserted ? 'evaluated' : 'skipped';
  }
}
