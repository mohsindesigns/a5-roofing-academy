import type { EventEnvelope, EventType } from '@a5/events';
import type { Trx } from '../database/index.js';
import type { FactWriter } from './fact-writer.js';

/** Event types the analytics facts consume (besides the directory events). */
export const FACT_EVENT_TYPES = [
  'program.published',
  'program.archived',
  'program.enrolled',
  'enrollment.progressed',
  'program.completed',
  'enrollment.withdrawn',
  'enrollment.overdue',
  'lesson.started',
  'lesson.completed',
  'phase.completed',
  'assessment.attempt.graded',
  'ai.score.generated',
  'certificate.eligible',
  'certificate.approval_requested',
  'certificate.issued',
  'certificate.revoked',
  'certificate.expired',
  'certificate.reissued',
] as const satisfies readonly EventType[];

type FactEventType = (typeof FACT_EVENT_TYPES)[number];

const HANDLERS: Record<FactEventType, (writer: FactWriter, trx: Trx, event: never) => Promise<void>> = {
  'program.published': (w, t, e) => w.programPublished(t, e),
  'program.archived': (w, t, e) => w.programArchived(t, e),
  'program.enrolled': (w, t, e) => w.enrolled(t, e),
  'enrollment.progressed': (w, t, e) => w.progressed(t, e),
  'program.completed': (w, t, e) => w.programCompleted(t, e),
  'enrollment.withdrawn': (w, t, e) => w.withdrawn(t, e),
  'enrollment.overdue': (w, t, e) => w.overdue(t, e),
  'lesson.started': (w, t, e) => w.lessonStarted(t, e),
  'lesson.completed': (w, t, e) => w.lessonCompleted(t, e),
  'phase.completed': (w, t, e) => w.phaseCompleted(t, e),
  'assessment.attempt.graded': (w, t, e) => w.attemptGraded(t, e),
  'ai.score.generated': (w, t, e) => w.aiScored(t, e),
  'certificate.eligible': (w, t, e) => w.certificateEligible(t, e),
  'certificate.approval_requested': (w, t, e) => w.certificateApprovalRequested(t, e),
  'certificate.issued': (w, t, e) => w.certificateIssued(t, e),
  'certificate.revoked': (w, t, e) => w.certificateRevoked(t, e),
  'certificate.expired': (w, t, e) => w.certificateExpired(t, e),
  'certificate.reissued': (w, t, e) => w.certificateReissued(t, e),
};

/** Apply a consumed event with the writer (used by the seed; consumers call the writer per event type). */
export async function applyFactEvent(writer: FactWriter, trx: Trx, event: EventEnvelope): Promise<boolean> {
  const handler = HANDLERS[event.type as FactEventType] as ((w: FactWriter, t: Trx, e: EventEnvelope) => Promise<void>) | undefined;
  if (!handler) return false;
  await handler(writer, trx, event);
  return true;
}
