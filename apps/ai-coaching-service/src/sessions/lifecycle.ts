import { Inject, Injectable } from '@nestjs/common';
import { aiEvents } from '@a5/events';
import { EventBus, LOGGER } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import type { EndReason, SessionStatus, Trx } from '../database/index.js';
import { EvaluationService } from '../evaluation/evaluation.service.js';
import type { SessionRow } from './session-view.js';

/**
 * Ending a conversation: `ended` (queued for scoring, emits `ai.session.completed`) when the
 * representative said anything, otherwise `abandoned` (nothing to score).
 */
@Injectable()
export class SessionLifecycle {
  constructor(
    private readonly events: EventBus,
    private readonly evaluation: EvaluationService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Call inside the transaction that holds the session row lock. */
  async end(
    trx: Trx,
    session: SessionRow,
    reason: EndReason,
    at: Date = new Date(),
  ): Promise<SessionStatus> {
    const status: SessionStatus = session.turn_count > 0 ? 'ended' : 'abandoned';
    await trx
      .updateTable('ai_sessions')
      .set({ status, end_reason: reason, ended_at: at, last_activity_at: at })
      .where('id', '=', session.id)
      .where('status', '=', 'active')
      .execute();
    if (status === 'ended' && !session.is_test) {
      await this.events.emit(
        trx,
        aiEvents.sessionCompleted,
        {
          sessionId: session.id,
          scenarioId: session.scenario_id,
          userId: session.user_id,
          endReason: reason,
          turnCount: session.turn_count,
          durationSeconds: Math.max(
            0,
            Math.round((at.getTime() - new Date(session.started_at).getTime()) / 1000),
          ),
        },
        {
          subject: { type: 'ai_session', id: session.id },
          organizationId: session.organization_id,
        },
      );
    }
    return status;
  }

  /** After commit: queue scoring. A lost enqueue is recovered by the maintenance sweep. */
  async afterCommit(sessionId: string, status: SessionStatus): Promise<void> {
    if (status !== 'ended') return;
    try {
      await this.evaluation.enqueue(sessionId);
    } catch (err) {
      this.logger.error(
        { err, sessionId },
        'could not queue AI evaluation; the maintenance sweep will retry',
      );
    }
  }
}
