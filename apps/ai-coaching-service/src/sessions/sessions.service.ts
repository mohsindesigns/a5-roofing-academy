import { Inject, Injectable } from '@nestjs/common';
import { TokenError, verifyLessonGrant, type Principal } from '@a5/auth';
import type { ai } from '@a5/contracts';
import { paginate, sql, type Page } from '@a5/database';
import { aiEvents } from '@a5/events';
import { DistributedLock } from '@a5/messaging';
import {
  AppError,
  ConflictError,
  EventBus,
  InjectDb,
  NotFoundError,
  PreconditionError,
} from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import { AI_CONFIG, type AiConfig } from '../config.js';
import { iso, isoOrNull } from '../common/people.js';
import type { Db, Modality, SessionContextRecord, SessionStatus } from '../database/index.js';
import { EvaluationService } from '../evaluation/evaluation.service.js';
import { readScenarioSnapshot } from '../prompts/snapshots.js';
import { ProviderRegistry, providerInfo } from '../providers/registry.js';
import { SettingsService } from '../settings/settings.service.js';
import { ConversationEngine } from './conversation.engine.js';
import { SessionLifecycle } from './lifecycle.js';
import { SessionView, type SessionRow } from './session-view.js';

export interface StartInput {
  scenarioId: string;
  lessonGrant?: string;
  modality: Modality;
}

/** Seconds until the next local midnight in a time zone. */
function secondsUntilMidnight(timezone: string, now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0) % 24;
  const elapsed =
    get('hour') * 3600 +
    Number(parts.find((p) => p.type === 'minute')?.value ?? 0) * 60 +
    Number(parts.find((p) => p.type === 'second')?.value ?? 0);
  return Math.max(60, 86_400 - elapsed);
}

@Injectable()
export class SessionsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly lock: DistributedLock,
    private readonly registry: ProviderRegistry,
    private readonly settings: SettingsService,
    private readonly events: EventBus,
    private readonly view: SessionView,
    private readonly lifecycle: SessionLifecycle,
    private readonly evaluation: EvaluationService,
    private readonly engine: ConversationEngine,
    @Inject(AI_CONFIG) private readonly config: AiConfig,
  ) {}

  /** Verify a lesson grant from learning-service for this learner and scenario. */
  private async verifyGrant(
    p: Principal,
    token: string,
    scenarioId: string,
  ): Promise<SessionContextRecord> {
    let grant;
    try {
      grant = await verifyLessonGrant(token, this.config.ai.lessonGrantSecret);
    } catch (err) {
      if (err instanceof TokenError) {
        throw new AppError(
          403,
          'GRANT_INVALID',
          err.code === 'expired'
            ? 'This lesson link has expired. Reopen the lesson to start the practice session.'
            : 'This lesson link is not valid. Reopen the lesson to start the practice session.',
        );
      }
      throw err;
    }
    if (
      grant.userId !== p.userId ||
      grant.organizationId !== p.organizationId ||
      grant.resource.type !== 'ai_scenario' ||
      grant.resource.id !== scenarioId
    ) {
      throw new AppError(
        403,
        'GRANT_MISMATCH',
        'This lesson link is for a different practice scenario or learner. Reopen the lesson and try again.',
      );
    }
    return {
      programId: grant.programId,
      enrollmentId: grant.enrollmentId,
      lessonId: grant.lessonId,
    };
  }

  private async assertDailyLimit(
    p: Principal,
    limit: number | null,
    timezone: string,
  ): Promise<void> {
    if (!limit) return;
    const { n } = await this.db
      .selectFrom('ai_sessions')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('user_id', '=', p.userId)
      .where('organization_id', '=', p.organizationId)
      .where('is_test', '=', false)
      .where(
        'started_at',
        '>=',
        sql<Date>`date_trunc('day', now() at time zone ${timezone}) at time zone ${timezone}`,
      )
      .executeTakeFirstOrThrow();
    if (Number(n) >= limit) {
      const retryAfter = secondsUntilMidnight(timezone);
      throw new AppError(
        429,
        'DAILY_SESSION_LIMIT',
        `You've reached today's limit of ${limit} practice sessions. Your limit resets at midnight.`,
        {
          limit,
          retryAfterSeconds: retryAfter,
        },
      );
    }
  }

  /** Start a practice (or lesson-assigned) session; returns it with the homeowner's opening line. */
  async start(
    p: Principal,
    input: StartInput,
    options: { test?: boolean } = {},
  ): Promise<ai.Session> {
    const scenario = await this.db
      .selectFrom('ai_scenarios')
      .select(['id', 'status', 'current_prompt_version_id'])
      .where('id', '=', input.scenarioId)
      .where('organization_id', '=', p.organizationId)
      .executeTakeFirst();
    const startable =
      scenario &&
      scenario.current_prompt_version_id &&
      (options.test ? scenario.status !== 'archived' : scenario.status === 'published');
    if (!startable) throw new NotFoundError('Scenario');
    if (options.test && input.lessonGrant)
      throw new PreconditionError(
        'TEST_SESSION_GRANT',
        'Test runs cannot be attached to a lesson.',
      );
    const context = input.lessonGrant
      ? await this.verifyGrant(p, input.lessonGrant, scenario.id)
      : {};
    if (input.modality === 'voice' && !this.engine.voiceAvailable) {
      throw new PreconditionError(
        'VOICE_NOT_AVAILABLE',
        'Voice practice is not available yet. Start a text session instead.',
      );
    }
    const settings = await this.settings.get(p.organizationId);
    const pv = await this.db
      .selectFrom('ai_prompt_versions')
      .selectAll()
      .where('id', '=', scenario.current_prompt_version_id!)
      .executeTakeFirstOrThrow();
    const snapshot = readScenarioSnapshot(pv.scenario_snapshot);
    const { provider, model } = this.registry.resolve('conversation', {
      provider: pv.provider,
      model: pv.model,
      settings,
    });

    const create = async (): Promise<SessionRow> => {
      if (!options.test)
        await this.assertDailyLimit(p, settings.maxSessionsPerLearnerPerDay, settings.timezone);
      const id = uuidv7();
      const now = new Date();
      return this.db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('ai_sessions')
          .values({
            id,
            organization_id: p.organizationId,
            user_id: p.userId,
            scenario_id: scenario.id,
            prompt_version_id: pv.id,
            rubric_version_id: pv.rubric_version_id,
            mode: input.lessonGrant ? 'assigned' : 'practice',
            is_test: options.test === true,
            context: JSON.stringify(context),
            modality: input.modality,
            status: 'active',
            end_reason: null,
            provider: provider.name,
            model,
            max_turns: snapshot.maxTurns,
            started_at: now,
            ended_at: null,
            last_activity_at: now,
            evaluation_error: null,
            transcript_purged_at: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('ai_messages')
          .values({
            id: uuidv7(),
            session_id: id,
            organization_id: p.organizationId,
            seq: 1,
            role: 'homeowner',
            content: snapshot.openingLine,
            modality: 'text',
            audio_ref: null,
            client_message_id: null,
            provider: null,
            model: null,
            input_tokens: null,
            output_tokens: null,
            latency_ms: null,
            created_at: now,
          })
          .execute();
        if (!options.test) {
          await this.events.emit(
            trx,
            aiEvents.sessionStarted,
            {
              sessionId: id,
              scenarioId: scenario.id,
              userId: p.userId,
              mode: input.lessonGrant ? 'assigned' : 'practice',
              context,
            },
            { subject: { type: 'ai_session', id }, organizationId: p.organizationId },
          );
        }
        return row;
      });
    };
    // Serialise starts per learner so concurrent requests cannot exceed the daily limit.
    const row = options.test
      ? await create()
      : await this.lock.withLock(`ai:start:${p.userId}`, 10_000, create, { waitMs: 5_000 });
    return this.view.build(row);
  }

  /** The caller's own session (404 for anyone else's). */
  async ownSession(p: Principal, id: string): Promise<SessionRow> {
    const row = await this.db
      .selectFrom('ai_sessions')
      .selectAll()
      .where('id', '=', id)
      .where('organization_id', '=', p.organizationId)
      .where('user_id', '=', p.userId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Practice session');
    return row;
  }

  async get(p: Principal, id: string): Promise<ai.Session> {
    return this.view.build(await this.ownSession(p, id));
  }

  async status(
    id: string,
  ): Promise<{ status: SessionStatus; turnCount: number; turnsRemaining: number }> {
    const s = await this.db
      .selectFrom('ai_sessions')
      .select(['status', 'turn_count', 'max_turns'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return {
      status: s.status,
      turnCount: s.turn_count,
      turnsRemaining: s.status === 'active' ? Math.max(0, s.max_turns - s.turn_count) : 0,
    };
  }

  /** The representative ends the conversation; scoring is queued when they said anything. */
  async end(p: Principal, id: string): Promise<ai.Session> {
    await this.ownSession(p, id);
    const status = await this.lock
      .withLock(
        ConversationEngine.lockName(id),
        15_000,
        () =>
          this.db.transaction().execute(async (trx) => {
            const locked = await trx
              .selectFrom('ai_sessions')
              .selectAll()
              .where('id', '=', id)
              .forUpdate()
              .executeTakeFirstOrThrow();
            if (locked.status !== 'active')
              throw new ConflictError('SESSION_ENDED', 'This conversation has already ended.');
            return this.lifecycle.end(trx, locked, 'rep_ended');
          }),
        { waitMs: 3_000 },
      )
      .catch((err: unknown) => {
        if ((err as Error).name === 'LockNotAcquiredError') {
          throw new ConflictError(
            'TURN_IN_PROGRESS',
            'The homeowner is still answering. End the session once the reply arrives.',
          );
        }
        throw err;
      });
    await this.lifecycle.afterCommit(id, status);
    return this.get(p, id);
  }

  /** Re-queue scoring after `evaluation_failed`. */
  async retryEvaluation(p: Principal, id: string): Promise<ai.Session> {
    const session = await this.ownSession(p, id);
    if (session.status !== 'evaluation_failed') {
      throw new ConflictError(
        'EVALUATION_NOT_FAILED',
        session.status === 'evaluated'
          ? 'This session is already scored.'
          : 'Scoring is not in a failed state, so there is nothing to retry.',
      );
    }
    await this.db
      .updateTable('ai_sessions')
      .set({ status: 'ended', evaluation_error: null })
      .where('id', '=', id)
      .where('status', '=', 'evaluation_failed')
      .execute();
    await this.evaluation.enqueue(id, { replace: true });
    return this.get(p, id);
  }

  /** The learner's history, newest first, with scores. Test runs are excluded. */
  async history(
    p: Principal,
    q: { scenarioId?: string; status?: SessionStatus; page: number; pageSize: number },
  ): Promise<Page<ai.SessionSummary>> {
    let query = this.db
      .selectFrom('ai_sessions as s')
      .innerJoin('ai_prompt_versions as pv', 'pv.id', 's.prompt_version_id')
      .leftJoin('ai_evaluations as e', 'e.session_id', 's.id')
      .select([
        's.id',
        's.scenario_id',
        's.mode',
        's.is_test',
        's.status',
        's.end_reason',
        's.turn_count',
        's.started_at',
        's.ended_at',
        's.provider',
        's.model',
        'pv.scenario_snapshot',
        'e.overall_score',
        'e.passed',
      ])
      .where('s.user_id', '=', p.userId)
      .where('s.organization_id', '=', p.organizationId)
      .where('s.is_test', '=', false);
    if (q.scenarioId) query = query.where('s.scenario_id', '=', q.scenarioId);
    if (q.status) query = query.where('s.status', '=', q.status);
    const page = await paginate(query.orderBy('s.started_at', 'desc'), q);
    return { ...page, items: page.items.map((r) => summaryDto(r)) };
  }
}

export function summaryDto(r: {
  id: string;
  scenario_id: string;
  mode: 'practice' | 'assigned';
  is_test: boolean;
  status: SessionStatus;
  end_reason: ai.EndReason | null;
  turn_count: number;
  started_at: Date;
  ended_at: Date | null;
  provider: 'anthropic' | 'openai' | 'dev_simulator';
  model: string;
  scenario_snapshot: Record<string, unknown>;
  overall_score: number | null;
  passed: boolean | null;
}): ai.SessionSummary {
  const s = readScenarioSnapshot(r.scenario_snapshot);
  return {
    id: r.id,
    scenario: {
      id: r.scenario_id,
      title: s.title,
      category: s.category,
      difficulty: s.difficulty,
      objection: s.objection,
    },
    mode: r.mode,
    isTest: r.is_test,
    status: r.status,
    endReason: r.end_reason,
    turnCount: r.turn_count,
    startedAt: iso(r.started_at),
    endedAt: isoOrNull(r.ended_at),
    overallScore: r.overall_score,
    passed: r.passed,
    provider: providerInfo(r.provider, r.model),
  };
}
