import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { ai } from '@a5/contracts';
import { Cache } from '@a5/messaging';
import { EventBus, InjectDb } from '@a5/nest-kit';
import { AI_CONFIG, type AiConfig } from '../config.js';
import { People, isoOrNull } from '../common/people.js';
import type { Db, ProviderPreference } from '../database/index.js';
import { ProviderRegistry, providerInfo } from '../providers/registry.js';

export interface EffectiveSettings {
  defaultProvider: ProviderPreference;
  conversationModel: string | null;
  evaluationModel: string | null;
  maxSessionsPerLearnerPerDay: number | null;
  transcriptRetentionDays: number | null;
  timezone: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const DEFAULT_MAX_SESSIONS_PER_DAY = 20;
export const DEFAULT_TIMEZONE = 'America/Chicago';

@Injectable()
export class SettingsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly cache: Cache,
    private readonly registry: ProviderRegistry,
    private readonly people: People,
    private readonly events: EventBus,
    @Inject(AI_CONFIG) private readonly config: AiConfig,
  ) {}

  private key(organizationId: string): string {
    return this.cache.key('cfg', 'ai', organizationId);
  }

  /** Organization AI settings, with defaults when none were saved (cached for a minute). */
  async get(organizationId: string): Promise<EffectiveSettings> {
    return this.cache.getOrSet(this.key(organizationId), 60, async () => {
      const row = await this.db.selectFrom('ai_settings').selectAll().where('organization_id', '=', organizationId).executeTakeFirst();
      if (!row) {
        return {
          defaultProvider: this.config.ai.providers.defaultProvider,
          conversationModel: null,
          evaluationModel: null,
          maxSessionsPerLearnerPerDay: DEFAULT_MAX_SESSIONS_PER_DAY,
          transcriptRetentionDays: null,
          timezone: DEFAULT_TIMEZONE,
          updatedAt: null,
          updatedBy: null,
        };
      }
      return {
        defaultProvider: row.default_provider,
        conversationModel: row.conversation_model,
        evaluationModel: row.evaluation_model,
        maxSessionsPerLearnerPerDay: row.max_sessions_per_learner_per_day,
        transcriptRetentionDays: row.transcript_retention_days,
        timezone: row.timezone,
        updatedAt: isoOrNull(row.updated_at),
        updatedBy: row.updated_by,
      };
    });
  }

  async view(p: Principal): Promise<ai.AiSettings> {
    const s = await this.get(p.organizationId);
    const conversation = this.registry.resolve('conversation', { provider: null, model: null, settings: s });
    const evaluation = this.registry.resolve('evaluation', { provider: null, model: null, settings: s });
    return {
      defaultProvider: s.defaultProvider,
      conversationModel: s.conversationModel,
      evaluationModel: s.evaluationModel,
      maxSessionsPerLearnerPerDay: s.maxSessionsPerLearnerPerDay,
      transcriptRetentionDays: s.transcriptRetentionDays,
      timezone: s.timezone,
      updatedAt: s.updatedAt,
      updatedBy: await this.people.ref(s.updatedBy),
      providers: this.registry.status(),
      effective: {
        conversation: providerInfo(conversation.provider.name, conversation.model),
        evaluation: providerInfo(evaluation.provider.name, evaluation.model),
      },
    };
  }

  async update(p: Principal, input: ai.UpdateAiSettingsRequest): Promise<ai.AiSettings> {
    const before = await this.get(p.organizationId);
    const next = {
      default_provider: input.defaultProvider ?? before.defaultProvider,
      conversation_model: input.conversationModel !== undefined ? input.conversationModel : before.conversationModel,
      evaluation_model: input.evaluationModel !== undefined ? input.evaluationModel : before.evaluationModel,
      max_sessions_per_learner_per_day:
        input.maxSessionsPerLearnerPerDay !== undefined ? input.maxSessionsPerLearnerPerDay : before.maxSessionsPerLearnerPerDay,
      transcript_retention_days: input.transcriptRetentionDays !== undefined ? input.transcriptRetentionDays : before.transcriptRetentionDays,
      timezone: input.timezone ?? before.timezone,
      updated_by: p.userId,
    };
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('ai_settings')
        .values({ organization_id: p.organizationId, ...next })
        .onConflict((oc) => oc.column('organization_id').doUpdateSet(next))
        .execute();
      await this.events.audit(
        trx,
        { action: 'ai.settings.updated', resourceType: 'ai_settings', resourceId: p.organizationId, actorDisplay: p.displayName, before, after: next },
        { organizationId: p.organizationId },
      );
    });
    await this.cache.del(this.key(p.organizationId));
    return this.view(p);
  }
}
