import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { ai } from '@a5/contracts';
import { sql } from '@a5/database';
import { InjectDb, LOGGER } from '@a5/nest-kit';
import { uuidv7, type Logger } from '@a5/observability';
import { AI_CONFIG, type AiConfig } from '../config.js';
import type { DbOrTrx, Db, ProviderName, UsagePurpose } from '../database/index.js';
import { estimateCostUsd } from '../providers/pricing.js';
import { ZERO_USAGE, type TokenUsage } from '../providers/types.js';

export interface UsageRecord {
  organizationId: string;
  userId: string | null;
  sessionId: string | null;
  scenarioId: string | null;
  purpose: UsagePurpose;
  isTest: boolean;
  provider: ProviderName;
  model: string;
  usage: TokenUsage | undefined;
  latencyMs: number;
  success: boolean;
  errorCode?: string | null;
}

interface Totals {
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
}

const DAY_MS = 86_400_000;

/** Token usage and estimated cost of every provider call (ai_usage). */
@Injectable()
export class UsageService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(AI_CONFIG) private readonly config: AiConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Never throws: losing a usage row must not fail a conversation turn. */
  async record(executor: DbOrTrx | null, r: UsageRecord): Promise<void> {
    const usage = r.usage ?? ZERO_USAGE;
    const { costUsd, priced } = estimateCostUsd(r.model, usage, this.config.ai.providers.prices);
    try {
      await (executor ?? this.db)
        .insertInto('ai_usage')
        .values({
          id: uuidv7(),
          organization_id: r.organizationId,
          user_id: r.userId,
          session_id: r.sessionId,
          scenario_id: r.scenarioId,
          purpose: r.purpose,
          is_test: r.isTest,
          provider: r.provider,
          model: r.model,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_tokens: usage.cacheReadTokens,
          cache_write_tokens: usage.cacheWriteTokens,
          estimated_cost_usd: costUsd,
          priced,
          latency_ms: Math.max(0, Math.round(r.latencyMs)),
          success: r.success,
          error_code: r.errorCode ?? null,
        })
        .execute();
    } catch (err) {
      if (executor) throw err;
      this.logger.error({ err, sessionId: r.sessionId }, 'failed to record AI usage');
    }
  }

  async report(p: Principal, q: { from?: string; to?: string; provider?: ProviderName; model?: string; includeTests?: boolean }): Promise<ai.UsageReport> {
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS).toISOString().slice(0, 10);
    let base = this.db
      .selectFrom('ai_usage as u')
      .where('u.organization_id', '=', p.organizationId)
      .where('u.created_at', '>=', new Date(`${from}T00:00:00Z`))
      .where('u.created_at', '<', new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS));
    if (q.provider) base = base.where('u.provider', '=', q.provider);
    if (q.model) base = base.where('u.model', '=', q.model);
    if (q.includeTests === false) base = base.where('u.is_test', '=', false);

    const totals = base.select([
      sql<number>`count(*)::int`.as('calls'),
      sql<number>`count(*) filter (where not u.success)::int`.as('failedCalls'),
      sql<number>`coalesce(sum(u.input_tokens), 0)::bigint`.as('inputTokens'),
      sql<number>`coalesce(sum(u.output_tokens), 0)::bigint`.as('outputTokens'),
      sql<number>`coalesce(sum(u.cache_read_tokens), 0)::bigint`.as('cacheReadTokens'),
      sql<number>`coalesce(sum(u.cache_write_tokens), 0)::bigint`.as('cacheWriteTokens'),
      sql<number>`coalesce(sum(u.estimated_cost_usd), 0)::numeric`.as('estimatedCostUsd'),
    ]);
    const num = (t: Totals): Totals => ({
      calls: Number(t.calls),
      failedCalls: Number(t.failedCalls),
      inputTokens: Number(t.inputTokens),
      outputTokens: Number(t.outputTokens),
      cacheReadTokens: Number(t.cacheReadTokens),
      cacheWriteTokens: Number(t.cacheWriteTokens),
      estimatedCostUsd: Math.round(Number(t.estimatedCostUsd) * 1_000_000) / 1_000_000,
    });

    const [overall, unpriced, byDay, byModel, byProvider, byPurpose] = await Promise.all([
      totals.executeTakeFirstOrThrow(),
      base.select(sql<number>`count(*)::int`.as('n')).where('u.priced', '=', false).executeTakeFirstOrThrow(),
      totals
        .select(sql<string>`to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD')`.as('date'))
        .groupBy(sql`to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD')`)
        .orderBy('date')
        .execute(),
      totals.select(['u.provider', 'u.model']).groupBy(['u.provider', 'u.model']).orderBy('u.provider').orderBy('u.model').execute(),
      totals.select('u.provider').groupBy('u.provider').orderBy('u.provider').execute(),
      totals.select('u.purpose').groupBy('u.purpose').orderBy('u.purpose').execute(),
    ]);
    return {
      from,
      to,
      totals: { ...num(overall), unpricedCalls: Number(unpriced.n) },
      byDay: byDay.map((r) => ({ date: r.date, ...num(r) })),
      byModel: byModel.map((r) => ({ provider: r.provider, model: r.model, ...num(r) })),
      byProvider: byProvider.map((r) => ({ provider: r.provider, ...num(r) })),
      byPurpose: byPurpose.map((r) => ({ purpose: r.purpose, ...num(r) })),
    };
  }
}
