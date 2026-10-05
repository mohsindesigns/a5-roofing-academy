import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ai } from '@a5/contracts';
import { DistributedLock } from '@a5/messaging';
import {
  ConflictError,
  InjectDb,
  LOGGER,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '@a5/nest-kit';
import { uuidv7, type Logger } from '@a5/observability';
import { AI_CONFIG, type AiConfig } from '../config.js';
import type { Db, EndReason, Modality, SessionStatus } from '../database/index.js';
import { buildConversationMessages } from '../prompts/compiler.js';
import { EndMarkerFilter } from '../prompts/end-marker.js';
import { readPersonaSnapshot, readScenarioSnapshot } from '../prompts/snapshots.js';
import { ProviderRegistry } from '../providers/registry.js';
import { backoffDelay } from '../providers/retry.js';
import {
  SPEECH_TO_TEXT,
  TEXT_TO_SPEECH,
  type AudioInput,
  type SpeechToTextProvider,
  type TextToSpeechProvider,
} from '../providers/speech.js';
import {
  ProviderError,
  type AIProvider,
  type ProviderCallOptions,
  type StreamChunk,
} from '../providers/types.js';
import { UsageService } from '../usage/usage.service.js';
import { SessionLifecycle } from './lifecycle.js';
import { messageDto, turnsRemaining, type SessionRow } from './session-view.js';

export interface TurnActor {
  userId: string;
  organizationId: string;
}

/** Transport-agnostic input: typed text, or audio transcribed by a speech-to-text provider. */
export interface TurnInput {
  text?: string;
  audio?: AudioInput;
  /** Regenerate the reply to the last unanswered representative message. */
  retry?: boolean;
  clientMessageId?: string;
}

export type TurnEvent =
  | { type: 'accepted'; repMessage: ai.Message | null; retried: boolean }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      message: ai.Message;
      sessionEnded: boolean;
      endReason: EndReason | null;
      status: SessionStatus;
      turnCount: number;
      turnsRemaining: number;
    }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export const UNAVAILABLE_MESSAGE =
  'The homeowner simulator is unavailable. Your conversation is saved — retry.';

const FALLBACK_LINES: Record<'objective_reached' | 'homeowner_ended', string> = {
  objective_reached: 'Okay. That works for me.',
  homeowner_ended: 'I need to get going. Have a good day.',
};

interface PreparedTurn {
  session: SessionRow;
  repMessage: ai.Message | null;
  retried: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Runs one conversation turn: persists the representative's message first (it is never lost),
 * streams the homeowner reply through the end-marker filter, persists the reply and ends the
 * session on an end marker or the turn limit. One turn per session at a time (distributed lock
 * plus a row lock); transient provider failures are retried with backoff before the first token.
 */
@Injectable()
export class ConversationEngine {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly lock: DistributedLock,
    private readonly registry: ProviderRegistry,
    private readonly usage: UsageService,
    private readonly lifecycle: SessionLifecycle,
    @Inject(AI_CONFIG) private readonly config: AiConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Optional() @Inject(SPEECH_TO_TEXT) private readonly stt: SpeechToTextProvider | null = null,
    @Optional() @Inject(TEXT_TO_SPEECH) private readonly tts: TextToSpeechProvider | null = null,
  ) {}

  get voiceAvailable(): boolean {
    return Boolean(this.stt && this.tts);
  }

  /** Lock name shared with "end session" so a turn and an end never interleave. */
  static lockName(sessionId: string): string {
    return `ai:turn:${sessionId}`;
  }

  private lockTtlMs(): number {
    const p = this.config.ai.providers;
    return p.conversationTimeoutMs * (p.maxRetries + 1) + 30_000;
  }

  /**
   * Yields `accepted` (the representative message is saved), then `delta`s, then `done` or
   * `error`. Validation failures throw before the first event, so transports can still answer
   * with a regular error response.
   */
  async *handleTurn(
    actor: TurnActor,
    sessionId: string,
    input: TurnInput,
  ): AsyncGenerator<TurnEvent> {
    const lock = await this.lock.acquire(ConversationEngine.lockName(sessionId), this.lockTtlMs());
    if (!lock) {
      throw new ConflictError(
        'TURN_IN_PROGRESS',
        'The homeowner is still answering your last message. Wait for the reply, then send your next message.',
      );
    }
    try {
      const prepared = await this.prepare(actor, sessionId, input);
      yield { type: 'accepted', repMessage: prepared.repMessage, retried: prepared.retried };
      yield* this.reply(prepared.session);
    } finally {
      await lock.release().catch(() => false);
    }
  }

  private async prepare(
    actor: TurnActor,
    sessionId: string,
    input: TurnInput,
  ): Promise<PreparedTurn> {
    const session = await this.db
      .selectFrom('ai_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .where('organization_id', '=', actor.organizationId)
      .executeTakeFirst();
    if (!session || session.user_id !== actor.userId) throw new NotFoundError('Practice session');
    if (session.status !== 'active')
      throw new ConflictError(
        'SESSION_ENDED',
        'This conversation has ended. Start a new session to practice again.',
      );

    let text = input.text?.trim() ?? '';
    let modality: Modality = 'text';
    let audioRef: string | null = null;
    if (input.audio && !input.retry) {
      if (!this.stt)
        throw new PreconditionError(
          'VOICE_NOT_AVAILABLE',
          'Voice practice is not available yet. Type your response instead.',
        );
      const transcribed = await this.stt.transcribe(input.audio, { language: 'en-US' });
      text = transcribed.text.trim();
      modality = 'voice';
      audioRef = input.audio.ref;
      if (!text)
        throw new PreconditionError(
          'VOICE_NOT_UNDERSTOOD',
          "We couldn't make out what you said. Try again or type your response.",
        );
    }

    return this.db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('ai_sessions')
        .selectAll()
        .where('id', '=', sessionId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (locked.status !== 'active')
        throw new ConflictError(
          'SESSION_ENDED',
          'This conversation has ended. Start a new session to practice again.',
        );
      const last = await trx
        .selectFrom('ai_messages')
        .select(['id', 'seq', 'role', 'content', 'modality', 'audio_ref', 'created_at'])
        .where('session_id', '=', sessionId)
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();

      let retry = input.retry === true;
      if (input.clientMessageId) {
        const duplicate = await trx
          .selectFrom('ai_messages')
          .select('id')
          .where('session_id', '=', sessionId)
          .where('client_message_id', '=', input.clientMessageId)
          .executeTakeFirst();
        if (duplicate) {
          if (last?.id !== duplicate.id || last.role !== 'rep') {
            throw new ConflictError(
              'MESSAGE_ALREADY_SENT',
              'This message was already sent and answered.',
            );
          }
          retry = true;
        }
      }
      if (retry) {
        if (!last || last.role !== 'rep')
          throw new ConflictError(
            'NOTHING_TO_RETRY',
            'There is no unanswered message to retry. Send a new message instead.',
          );
        return { session: locked, repMessage: messageDto(last), retried: true };
      }
      if (!text)
        throw new ValidationError([
          { path: 'text', message: 'Type a message, or retry the last one' },
        ]);
      if (locked.turn_count >= locked.max_turns) {
        throw new ConflictError(
          'MAX_TURNS_REACHED',
          'This conversation has reached its turn limit. End the session to get your scorecard.',
        );
      }
      const now = new Date();
      const message = {
        id: uuidv7(),
        session_id: sessionId,
        organization_id: locked.organization_id,
        seq: (last?.seq ?? 0) + 1,
        role: 'rep' as const,
        content: text,
        modality,
        audio_ref: audioRef,
        client_message_id: input.clientMessageId ?? null,
        provider: null,
        model: null,
        input_tokens: null,
        output_tokens: null,
        latency_ms: null,
        created_at: now,
      };
      await trx.insertInto('ai_messages').values(message).execute();
      await trx
        .updateTable('ai_sessions')
        .set({ turn_count: locked.turn_count + 1, last_activity_at: now })
        .where('id', '=', sessionId)
        .execute();
      return {
        session: { ...locked, turn_count: locked.turn_count + 1, last_activity_at: now },
        repMessage: messageDto(message),
        retried: false,
      };
    });
  }

  private errorEvent(err: unknown): Extract<TurnEvent, { type: 'error' }> {
    if (err instanceof ProviderError && !err.retryable) {
      if (err.kind === 'refusal') {
        return {
          type: 'error',
          code: err.code,
          message:
            "The homeowner simulator couldn't continue from your last message. Your conversation is saved — rephrase it and retry, or end the session.",
          retryable: true,
        };
      }
      return {
        type: 'error',
        code: err.code,
        message:
          'The homeowner simulator is not available right now. Your conversation is saved — ask an administrator to check the AI settings, then retry.',
        retryable: false,
      };
    }
    return {
      type: 'error',
      code: err instanceof ProviderError ? err.code : 'AI_PROVIDER_UNAVAILABLE',
      message: UNAVAILABLE_MESSAGE,
      retryable: true,
    };
  }

  private async *reply(session: SessionRow): AsyncGenerator<TurnEvent> {
    const providers = this.config.ai.providers;
    const [pv, transcript] = await Promise.all([
      this.db
        .selectFrom('ai_prompt_versions')
        .selectAll()
        .where('id', '=', session.prompt_version_id)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('ai_messages')
        .select(['seq', 'role', 'content'])
        .where('session_id', '=', session.id)
        .orderBy('seq')
        .execute(),
    ]);
    let provider: AIProvider;
    try {
      provider = this.registry.get(session.provider);
    } catch (err) {
      this.logger.error(
        { err, sessionId: session.id, provider: session.provider },
        'session provider is no longer configured',
      );
      yield {
        type: 'error',
        code: 'AI_PROVIDER_NOT_CONFIGURED',
        message: UNAVAILABLE_MESSAGE,
        retryable: true,
      };
      return;
    }
    const options: ProviderCallOptions = {
      model: session.model,
      system: pv.homeowner_system_prompt,
      maxOutputTokens: pv.model_settings.maxOutputTokens ?? providers.conversationMaxTokens,
      timeoutMs: providers.conversationTimeoutMs,
      effort: pv.model_settings.effort ?? providers.conversationEffort,
      temperature: pv.model_settings.temperature,
      simulation: {
        kind: 'conversation',
        persona: readPersonaSnapshot(pv.persona_snapshot),
        scenario: readScenarioSnapshot(pv.scenario_snapshot),
      },
    };
    const messages = buildConversationMessages(transcript);
    const usageBase = {
      organizationId: session.organization_id,
      userId: session.user_id,
      sessionId: session.id,
      scenarioId: session.scenario_id,
      purpose: 'conversation' as const,
      isTest: session.is_test,
      provider: provider.name,
      model: session.model,
    };

    let filter = new EndMarkerFilter();
    let done: Extract<StreamChunk, { type: 'done' }> | null = null;
    const firstStarted = Date.now();
    let started = firstStarted;
    for (let attempt = 0; ; attempt++) {
      let emitted = false;
      if (attempt > 0) started = Date.now();
      try {
        for await (const chunk of provider.stream(messages, options)) {
          if (chunk.type === 'done') {
            done = chunk;
            continue;
          }
          const safe = filter.push(chunk.text);
          if (safe) {
            emitted = true;
            yield { type: 'delta', text: safe };
          }
        }
        if (!done)
          throw new ProviderError(
            provider.name,
            'server',
            'The stream ended without a final message.',
          );
        break;
      } catch (err) {
        const perr =
          err instanceof ProviderError
            ? err
            : new ProviderError(
                provider.name,
                'server',
                (err as Error)?.message ?? 'Unknown provider error',
                undefined,
                { cause: err },
              );
        await this.usage.record(null, {
          ...usageBase,
          usage: perr.usage,
          latencyMs: Date.now() - started,
          success: false,
          errorCode: perr.code,
        });
        if (!emitted && perr.retryable && attempt < providers.maxRetries) {
          const delay = backoffDelay(attempt, providers.retryBaseMs);
          this.logger.warn(
            { err: perr, sessionId: session.id, attempt: attempt + 1, delay },
            'homeowner reply failed; retrying',
          );
          await sleep(delay);
          filter = new EndMarkerFilter();
          done = null;
          continue;
        }
        this.logger.error({ err: perr, sessionId: session.id }, 'homeowner reply failed');
        yield this.errorEvent(perr);
        return;
      }
    }

    const finished = filter.finish();
    if (finished.tail) yield { type: 'delta', text: finished.tail };
    let content = finished.text;
    let endReason: EndReason | null = finished.endReason;
    if (!content) {
      if (!endReason) {
        await this.usage.record(null, {
          ...usageBase,
          model: done.model,
          usage: done.usage,
          latencyMs: Date.now() - started,
          success: false,
          errorCode: 'AI_PROVIDER_EMPTY_REPLY',
        });
        yield {
          type: 'error',
          code: 'AI_PROVIDER_EMPTY_REPLY',
          message: UNAVAILABLE_MESSAGE,
          retryable: true,
        };
        return;
      }
      content = FALLBACK_LINES[endReason as keyof typeof FALLBACK_LINES];
      yield { type: 'delta', text: content };
    }
    if (!endReason && session.turn_count >= session.max_turns) endReason = 'max_turns';
    const latencyMs = Date.now() - started;

    let audioRef: string | null = null;
    if (session.modality === 'voice' && this.tts) {
      try {
        audioRef = (
          await this.tts.synthesize(content, {
            organizationId: session.organization_id,
            sessionId: session.id,
          })
        ).audioRef;
      } catch (err) {
        this.logger.warn(
          { err, sessionId: session.id },
          'text-to-speech failed; reply delivered as text',
        );
      }
    }

    const final = done;
    const outcome = await this.db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('ai_sessions')
        .selectAll()
        .where('id', '=', session.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await this.usage.record(trx, {
        ...usageBase,
        model: final.model,
        usage: final.usage,
        latencyMs,
        success: true,
      });
      if (locked.status !== 'active') return null;
      const { seq } = await trx
        .selectFrom('ai_messages')
        .select((eb) => eb.fn.coalesce(eb.fn.max('seq'), eb.lit(0)).as('seq'))
        .where('session_id', '=', session.id)
        .executeTakeFirstOrThrow();
      const now = new Date();
      const message = {
        id: uuidv7(),
        session_id: session.id,
        organization_id: session.organization_id,
        seq: Number(seq) + 1,
        role: 'homeowner' as const,
        content,
        modality: audioRef ? ('voice' as const) : ('text' as const),
        audio_ref: audioRef,
        client_message_id: null,
        provider: provider.name,
        model: final.model,
        input_tokens:
          final.usage.inputTokens + final.usage.cacheReadTokens + final.usage.cacheWriteTokens,
        output_tokens: final.usage.outputTokens,
        latency_ms: latencyMs,
        created_at: now,
      };
      await trx.insertInto('ai_messages').values(message).execute();
      await trx
        .updateTable('ai_sessions')
        .set({ last_activity_at: now })
        .where('id', '=', session.id)
        .execute();
      const status = endReason
        ? await this.lifecycle.end(trx, locked, endReason, now)
        : locked.status;
      return { message, status, turnCount: locked.turn_count, maxTurns: locked.max_turns };
    });
    if (!outcome) {
      yield {
        type: 'error',
        code: 'SESSION_ENDED',
        message: 'This conversation already ended. Your scorecard will appear in the session.',
        retryable: false,
      };
      return;
    }
    if (endReason) await this.lifecycle.afterCommit(session.id, outcome.status);
    yield {
      type: 'done',
      message: messageDto(outcome.message),
      sessionEnded: outcome.status !== 'active',
      endReason: outcome.status !== 'active' ? endReason : null,
      status: outcome.status,
      turnCount: outcome.turnCount,
      turnsRemaining: turnsRemaining({
        max_turns: outcome.maxTurns,
        turn_count: outcome.turnCount,
        status: outcome.status,
      }),
    };
  }
}
