import { Injectable } from '@nestjs/common';
import { sql } from '@a5/database';
import {
  aiEvents,
  assessmentEvents,
  certificationEvents,
  identityEvents,
  learningEvents,
  type EventEnvelope,
  type EventPayload,
} from '@a5/events';
import { processOnce, type DeliveryInfo } from '@a5/messaging';
import { InjectDb, OnEvent } from '@a5/nest-kit';
import type { Db, Trx } from '../database/index.js';
import { NotificationEngine } from './notification-engine.js';

/**
 * Subscriptions of the notification engine. Each handler is idempotent (inbox claim inside the
 * engine) and tolerates redelivery and reordering.
 */
@Injectable()
export class NotificationEventHandlers {
  constructor(private readonly engine: NotificationEngine) {}

  private dispatch(event: EventEnvelope, delivery?: DeliveryInfo): Promise<unknown> {
    return this.engine.handle(event, delivery?.deliveryCount);
  }

  @OnEvent(identityEvents.userCreated)
  userCreated(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(identityEvents.invitationCreated)
  invitationCreated(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(identityEvents.passwordResetRequested)
  passwordResetRequested(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(learningEvents.enrolled)
  enrolled(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(learningEvents.enrollmentOverdue)
  enrollmentOverdue(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(learningEvents.programPublished)
  programPublished(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(learningEvents.approvalRequested)
  approvalRequested(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(learningEvents.approvalDecided)
  approvalDecided(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(assessmentEvents.attemptGraded)
  attemptGraded(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(aiEvents.scoreGenerated)
  aiScoreGenerated(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(aiEvents.sessionReviewed)
  aiSessionReviewed(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(certificationEvents.eligible)
  certificateEligible(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(certificationEvents.approvalRequested)
  certificateApprovalRequested(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(certificationEvents.approvalDecided)
  certificateApprovalDecided(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(certificationEvents.issued)
  certificateIssued(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(certificationEvents.generated)
  certificateGenerated(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(certificationEvents.expiring)
  certificateExpiring(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(certificationEvents.expired)
  certificateExpired(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(certificationEvents.revoked)
  certificateRevoked(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }

  @OnEvent(certificationEvents.renewalRequired)
  certificateRenewalRequired(e: EventEnvelope, d?: DeliveryInfo) {
    return this.dispatch(e, d);
  }
}

/**
 * Who is enrolled in which program, so program-wide announcements (`enrolled_learners`) can be
 * addressed. Guarded by event time so out-of-order delivery cannot resurrect a withdrawal.
 */
@Injectable()
export class ProgramLearnersProjection {
  constructor(@InjectDb() private readonly db: Db) {}

  @OnEvent(learningEvents.enrolled)
  async onEnrolled(event: EventEnvelope) {
    const p = event.payload as EventPayload<'program.enrolled'>;
    await processOnce(this.db, 'program-learners', event, (trx) => this.apply(trx, event, p, null));
  }

  @OnEvent(learningEvents.enrollmentWithdrawn)
  async onWithdrawn(event: EventEnvelope) {
    const p = event.payload as EventPayload<'enrollment.withdrawn'>;
    await processOnce(this.db, 'program-learners', event, (trx) => this.apply(trx, event, p, new Date(event.occurredAt)));
  }

  private async apply(
    trx: Trx,
    event: EventEnvelope,
    p: { programId: string; userId: string; enrollmentId: string },
    withdrawnAt: Date | null,
  ): Promise<void> {
    if (!event.organizationId) return;
    const at = new Date(event.occurredAt);
    await trx
      .insertInto('program_learners')
      .values({
        program_id: p.programId,
        user_id: p.userId,
        organization_id: event.organizationId,
        enrollment_id: p.enrollmentId,
        enrolled_at: at,
        withdrawn_at: withdrawnAt,
        event_at: at,
      })
      .onConflict((oc) =>
        oc
          .columns(['program_id', 'user_id'])
          .doUpdateSet((eb) => ({
            enrollment_id: eb.ref('excluded.enrollment_id'),
            enrolled_at: withdrawnAt ? eb.ref('program_learners.enrolled_at') : eb.ref('excluded.enrolled_at'),
            withdrawn_at: eb.ref('excluded.withdrawn_at'),
            event_at: eb.ref('excluded.event_at'),
          }))
          .where('program_learners.event_at', '<', sql<Date>`excluded.event_at`),
      )
      .execute();
  }
}
