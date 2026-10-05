import { Inject, Injectable } from '@nestjs/common';
import {
  aiEvents,
  assessmentEvents,
  certificationEvents,
  learningEvents,
  type EventEnvelope,
  type EventPayload,
  type EventType,
} from '@a5/events';
import { processOnce } from '@a5/messaging';
import { InjectDb, LOGGER, OnEvent } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import type { Db, Trx } from '../database/index.js';
import { FactWriter } from './fact-writer.js';

type Typed<T extends EventType> = EventEnvelope<EventPayload<T>, T>;

/**
 * Event consumers that build the analytics fact tables. Each handler runs its effects exactly once
 * per event (inbox) inside one transaction; the writer's guards make reordering harmless.
 */
@Injectable()
export class FactsConsumer {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly writer: FactWriter,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  private async run<T extends EventType>(event: EventEnvelope, apply: (trx: Trx, e: Typed<T>) => Promise<void>): Promise<boolean> {
    if (!event.organizationId) {
      this.logger.warn({ eventId: event.id, type: event.type }, 'analytics skipped an event without organization');
      return false;
    }
    return processOnce(this.db, `analytics.${event.type}`, event, (trx) => apply(trx, event as Typed<T>));
  }

  // learning
  @OnEvent(learningEvents.programPublished)
  onProgramPublished(e: EventEnvelope) {
    return this.run<'program.published'>(e, (trx, ev) => this.writer.programPublished(trx, ev));
  }

  @OnEvent(learningEvents.programArchived)
  onProgramArchived(e: EventEnvelope) {
    return this.run<'program.archived'>(e, (trx, ev) => this.writer.programArchived(trx, ev));
  }

  @OnEvent(learningEvents.enrolled)
  onEnrolled(e: EventEnvelope) {
    return this.run<'program.enrolled'>(e, (trx, ev) => this.writer.enrolled(trx, ev));
  }

  @OnEvent(learningEvents.enrollmentProgressed)
  onProgressed(e: EventEnvelope) {
    return this.run<'enrollment.progressed'>(e, (trx, ev) => this.writer.progressed(trx, ev));
  }

  @OnEvent(learningEvents.programCompleted)
  onProgramCompleted(e: EventEnvelope) {
    return this.run<'program.completed'>(e, (trx, ev) => this.writer.programCompleted(trx, ev));
  }

  @OnEvent(learningEvents.enrollmentWithdrawn)
  onWithdrawn(e: EventEnvelope) {
    return this.run<'enrollment.withdrawn'>(e, (trx, ev) => this.writer.withdrawn(trx, ev));
  }

  @OnEvent(learningEvents.enrollmentOverdue)
  onOverdue(e: EventEnvelope) {
    return this.run<'enrollment.overdue'>(e, (trx, ev) => this.writer.overdue(trx, ev));
  }

  @OnEvent(learningEvents.lessonStarted)
  onLessonStarted(e: EventEnvelope) {
    return this.run<'lesson.started'>(e, (trx, ev) => this.writer.lessonStarted(trx, ev));
  }

  @OnEvent(learningEvents.lessonCompleted)
  onLessonCompleted(e: EventEnvelope) {
    return this.run<'lesson.completed'>(e, (trx, ev) => this.writer.lessonCompleted(trx, ev));
  }

  @OnEvent(learningEvents.phaseCompleted)
  onPhaseCompleted(e: EventEnvelope) {
    return this.run<'phase.completed'>(e, (trx, ev) => this.writer.phaseCompleted(trx, ev));
  }

  // assessment
  @OnEvent(assessmentEvents.attemptGraded)
  onAttemptGraded(e: EventEnvelope) {
    return this.run<'assessment.attempt.graded'>(e, (trx, ev) => this.writer.attemptGraded(trx, ev));
  }

  // ai coaching
  @OnEvent(aiEvents.scoreGenerated)
  onAiScore(e: EventEnvelope) {
    return this.run<'ai.score.generated'>(e, (trx, ev) => this.writer.aiScored(trx, ev));
  }

  // certification
  @OnEvent(certificationEvents.eligible)
  onCertificateEligible(e: EventEnvelope) {
    return this.run<'certificate.eligible'>(e, (trx, ev) => this.writer.certificateEligible(trx, ev));
  }

  @OnEvent(certificationEvents.approvalRequested)
  onCertificateApprovalRequested(e: EventEnvelope) {
    return this.run<'certificate.approval_requested'>(e, (trx, ev) => this.writer.certificateApprovalRequested(trx, ev));
  }

  @OnEvent(certificationEvents.issued)
  onCertificateIssued(e: EventEnvelope) {
    return this.run<'certificate.issued'>(e, (trx, ev) => this.writer.certificateIssued(trx, ev));
  }

  @OnEvent(certificationEvents.revoked)
  onCertificateRevoked(e: EventEnvelope) {
    return this.run<'certificate.revoked'>(e, (trx, ev) => this.writer.certificateRevoked(trx, ev));
  }

  @OnEvent(certificationEvents.expired)
  onCertificateExpired(e: EventEnvelope) {
    return this.run<'certificate.expired'>(e, (trx, ev) => this.writer.certificateExpired(trx, ev));
  }

  @OnEvent(certificationEvents.reissued)
  onCertificateReissued(e: EventEnvelope) {
    return this.run<'certificate.reissued'>(e, (trx, ev) => this.writer.certificateReissued(trx, ev));
  }
}
