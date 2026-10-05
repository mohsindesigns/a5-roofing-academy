import { z } from 'zod';
import type { Producer } from './envelope.js';

/**
 * Versioned domain event contracts. Within a version only optional fields may be added.
 * A breaking change introduces `version + 1`; producers dual-publish during migrations.
 */
export interface EventDefinition<T extends string, S extends z.ZodType> {
  type: T;
  version: number;
  producer: Producer;
  payload: S;
  /** Payload contains secrets (one-time links). Consumers must not persist it verbatim. */
  sensitive?: boolean;
  description: string;
}

function define<const T extends string, S extends z.ZodType>(
  def: EventDefinition<T, S>,
): EventDefinition<T, S> {
  return def;
}

const id = z.uuid();
const ts = z.iso.datetime({ offset: true });
const nullableId = id.nullable();

export const learningContextSchema = z
  .object({
    programId: id.optional(),
    enrollmentId: id.optional(),
    lessonId: id.optional(),
  })
  .partial();

// ---------------------------------------------------------------- identity

const directoryUser = z.object({
  id,
  organizationId: id,
  firstName: z.string(),
  lastName: z.string(),
  displayName: z.string(),
  email: z.string(),
  employeeId: z.string().nullable(),
  jobTitle: z.string().nullable(),
  status: z.enum(['invited', 'active', 'deactivated', 'locked']),
  locationId: nullableId,
  departmentId: nullableId,
  teamIds: z.array(id),
  managerIds: z.array(id),
  trainerIds: z.array(id),
  roleKeys: z.array(z.string()),
  hiredAt: ts.nullable(),
});
export type DirectoryUserRecord = z.infer<typeof directoryUser>;

const directoryTeam = z.object({
  id,
  organizationId: id,
  name: z.string(),
  locationId: nullableId,
  departmentId: nullableId,
  managerIds: z.array(id),
  memberIds: z.array(id),
  archived: z.boolean(),
});
export type DirectoryTeamRecord = z.infer<typeof directoryTeam>;

const directoryUnit = z.object({
  id,
  organizationId: id,
  kind: z.enum(['location', 'department']),
  name: z.string(),
  archived: z.boolean(),
});
export type DirectoryUnitRecord = z.infer<typeof directoryUnit>;

export const identityEvents = {
  userCreated: define({
    type: 'user.created',
    version: 1,
    producer: 'identity-service',
    description: 'A user account was created (invited).',
    payload: z.object({
      userId: id,
      email: z.string(),
      displayName: z.string(),
      roleKeys: z.array(z.string()),
      createdBy: nullableId,
    }),
  }),
  userActivated: define({
    type: 'user.activated',
    version: 1,
    producer: 'identity-service',
    description: 'A user completed activation or was reactivated.',
    payload: z.object({ userId: id }),
  }),
  userDeactivated: define({
    type: 'user.deactivated',
    version: 1,
    producer: 'identity-service',
    description: 'A user account was deactivated.',
    payload: z.object({ userId: id, reason: z.string().nullable() }),
  }),
  directoryUserUpserted: define({
    type: 'directory.user.upserted',
    version: 1,
    producer: 'identity-service',
    description: 'Full directory record for a user. Consumers upsert when revision is newer.',
    payload: z.object({ user: directoryUser, revision: z.int() }),
  }),
  directoryTeamUpserted: define({
    type: 'directory.team.upserted',
    version: 1,
    producer: 'identity-service',
    description: 'Full directory record for a team including members and managers.',
    payload: z.object({ team: directoryTeam, revision: z.int() }),
  }),
  directoryUnitUpserted: define({
    type: 'directory.unit.upserted',
    version: 1,
    producer: 'identity-service',
    description: 'Location or department record.',
    payload: z.object({ unit: directoryUnit, revision: z.int() }),
  }),
  invitationCreated: define({
    type: 'identity.invitation.created',
    version: 1,
    producer: 'identity-service',
    sensitive: true,
    description: 'An activation link was issued for a new account.',
    payload: z.object({
      userId: id,
      email: z.string(),
      displayName: z.string(),
      activationUrl: z.string(),
      expiresAt: ts,
      invitedByName: z.string().nullable(),
    }),
  }),
  passwordResetRequested: define({
    type: 'identity.password_reset.requested',
    version: 1,
    producer: 'identity-service',
    sensitive: true,
    description: 'A password reset link was issued.',
    payload: z.object({
      userId: id,
      email: z.string(),
      displayName: z.string(),
      resetUrl: z.string(),
      expiresAt: ts,
    }),
  }),
};

// ---------------------------------------------------------------- learning

const enrollmentRef = { enrollmentId: id, programId: id, userId: id };

export const learningEvents = {
  programPublished: define({
    type: 'program.published',
    version: 1,
    producer: 'learning-service',
    description: 'Program changes were published. Carries the requirement map consumers need.',
    payload: z.object({
      programId: id,
      title: z.string(),
      version: z.int(),
      phases: z.array(z.object({ phaseId: id, title: z.string(), position: z.int() })),
      requiredLessonIds: z.array(id),
      assessments: z.array(
        z.object({
          assessmentId: id,
          lessonId: id,
          kind: z.enum(['quiz', 'exam', 'final', 'practice']),
          required: z.boolean(),
          title: z.string(),
        }),
      ),
      aiScenarios: z.array(z.object({ scenarioId: id, lessonId: id, minScore: z.number().nullable() })),
      /** Published lesson outline in learner order (optional; lets consumers label and order lessons). */
      lessons: z
        .array(
          z.object({
            lessonId: id,
            phaseId: id,
            moduleId: id,
            title: z.string(),
            type: z.string(),
            position: z.int(),
            required: z.boolean(),
          }),
        )
        .optional(),
    }),
  }),
  programArchived: define({
    type: 'program.archived',
    version: 1,
    producer: 'learning-service',
    description: 'A program was archived.',
    payload: z.object({ programId: id }),
  }),
  enrolled: define({
    type: 'program.enrolled',
    version: 1,
    producer: 'learning-service',
    description: 'A user was enrolled in a program.',
    payload: z.object({
      ...enrollmentRef,
      programTitle: z.string(),
      assignedBy: nullableId,
      dueAt: ts.nullable(),
      source: z.enum(['manual', 'rule', 'self']),
    }),
  }),
  enrollmentWithdrawn: define({
    type: 'enrollment.withdrawn',
    version: 1,
    producer: 'learning-service',
    description: 'An enrollment was withdrawn.',
    payload: z.object(enrollmentRef),
  }),
  enrollmentProgressed: define({
    type: 'enrollment.progressed',
    version: 1,
    producer: 'learning-service',
    description: 'Enrollment progress changed.',
    payload: z.object({
      ...enrollmentRef,
      progressPercent: z.number(),
      requiredCompleted: z.int(),
      requiredTotal: z.int(),
      currentPhaseId: nullableId,
    }),
  }),
  enrollmentOverdue: define({
    type: 'enrollment.overdue',
    version: 1,
    producer: 'learning-service',
    description: 'An enrollment passed its due date without completion.',
    payload: z.object({
      ...enrollmentRef,
      programTitle: z.string(),
      dueAt: ts,
      progressPercent: z.number(),
    }),
  }),
  lessonStarted: define({
    type: 'lesson.started',
    version: 1,
    producer: 'learning-service',
    description: 'A learner opened a lesson for the first time.',
    payload: z.object({ ...enrollmentRef, lessonId: id, lessonType: z.string() }),
  }),
  lessonCompleted: define({
    type: 'lesson.completed',
    version: 1,
    producer: 'learning-service',
    description: 'A learner completed a lesson.',
    payload: z.object({
      ...enrollmentRef,
      phaseId: id,
      moduleId: id,
      lessonId: id,
      lessonType: z.string(),
      lessonTitle: z.string(),
      required: z.boolean(),
      source: z.string(),
      completedAt: ts,
    }),
  }),
  phaseCompleted: define({
    type: 'phase.completed',
    version: 1,
    producer: 'learning-service',
    description: 'A learner completed every required lesson in a phase (week).',
    payload: z.object({ ...enrollmentRef, phaseId: id, phaseTitle: z.string(), completedAt: ts }),
  }),
  programCompleted: define({
    type: 'program.completed',
    version: 1,
    producer: 'learning-service',
    description: 'A learner completed every required lesson of a program.',
    payload: z.object({ ...enrollmentRef, programTitle: z.string(), completedAt: ts }),
  }),
  approvalRequested: define({
    type: 'approval.requested',
    version: 1,
    producer: 'learning-service',
    description: 'A manager-approval lesson is waiting for a decision.',
    payload: z.object({
      ...enrollmentRef,
      approvalId: id,
      lessonId: id,
      lessonTitle: z.string(),
      programTitle: z.string(),
    }),
  }),
  approvalDecided: define({
    type: 'approval.decided',
    version: 1,
    producer: 'learning-service',
    description: 'A manager-approval lesson was approved or rejected.',
    payload: z.object({
      ...enrollmentRef,
      approvalId: id,
      lessonId: id,
      lessonTitle: z.string(),
      decision: z.enum(['approved', 'rejected']),
      decidedBy: id,
      comment: z.string().nullable(),
    }),
  }),
};

// ---------------------------------------------------------------- media

const watchFields = {
  assetId: id,
  userId: id,
  contextType: z.string(),
  contextId: id,
  watchedPercent: z.number(),
  watchedSeconds: z.number(),
  durationSeconds: z.number(),
};

export const mediaEvents = {
  videoStarted: define({
    type: 'video.started',
    version: 1,
    producer: 'media-service',
    description: 'First playback of a video in a context.',
    payload: z.object({ assetId: id, userId: id, contextType: z.string(), contextId: id }),
  }),
  videoProgressed: define({
    type: 'video.progressed',
    version: 1,
    producer: 'media-service',
    description: 'Credited watch percentage crossed a 5% boundary.',
    payload: z.object(watchFields),
  }),
  videoCompleted: define({
    type: 'video.completed',
    version: 1,
    producer: 'media-service',
    description: 'Credited watch time reached the end of the video.',
    payload: z.object(watchFields),
  }),
  assetReady: define({
    type: 'media.asset.ready',
    version: 1,
    producer: 'media-service',
    description: 'Media finished processing and can be played.',
    payload: z.object({
      assetId: id,
      kind: z.enum(['video', 'document', 'image', 'caption']),
      title: z.string(),
      durationSeconds: z.number().nullable(),
    }),
  }),
  assetFailed: define({
    type: 'media.asset.failed',
    version: 1,
    producer: 'media-service',
    description: 'Media processing failed.',
    payload: z.object({ assetId: id, title: z.string(), error: z.string() }),
  }),
};

// ---------------------------------------------------------------- assessment

export const assessmentEvents = {
  attemptStarted: define({
    type: 'assessment.attempt.started',
    version: 1,
    producer: 'assessment-service',
    description: 'A learner started an attempt.',
    payload: z.object({
      attemptId: id,
      assessmentId: id,
      userId: id,
      attemptNumber: z.int(),
      context: learningContextSchema,
    }),
  }),
  attemptSubmitted: define({
    type: 'assessment.attempt.submitted',
    version: 1,
    producer: 'assessment-service',
    description: 'A learner submitted an attempt.',
    payload: z.object({
      attemptId: id,
      assessmentId: id,
      assessmentTitle: z.string(),
      userId: id,
      needsReview: z.boolean(),
      context: learningContextSchema,
    }),
  }),
  attemptGraded: define({
    type: 'assessment.attempt.graded',
    version: 1,
    producer: 'assessment-service',
    description: 'An attempt has a final score (quiz.passed / quiz.failed via `passed`).',
    payload: z.object({
      attemptId: id,
      assessmentId: id,
      assessmentTitle: z.string(),
      kind: z.enum(['quiz', 'exam', 'final', 'practice']),
      userId: id,
      attemptNumber: z.int(),
      scorePercent: z.number(),
      passed: z.boolean(),
      passingPercent: z.number(),
      gradedAt: ts,
      overridden: z.boolean(),
      context: learningContextSchema,
      questionResults: z.array(
        z.object({
          questionId: id,
          questionVersionId: id,
          categoryId: nullableId,
          correct: z.boolean().nullable(),
          awardedPoints: z.number(),
          possiblePoints: z.number(),
          /** Question stem as shown to the learner (optional; used for reporting labels). */
          prompt: z.string().optional(),
          categoryName: z.string().nullable().optional(),
        }),
      ),
    }),
  }),
};

// ---------------------------------------------------------------- ai

export const aiEvents = {
  sessionStarted: define({
    type: 'ai.session.started',
    version: 1,
    producer: 'ai-coaching-service',
    description: 'A role-play session started.',
    payload: z.object({
      sessionId: id,
      scenarioId: id,
      userId: id,
      mode: z.enum(['practice', 'assigned']),
      context: learningContextSchema,
    }),
  }),
  sessionCompleted: define({
    type: 'ai.session.completed',
    version: 1,
    producer: 'ai-coaching-service',
    description: 'A role-play conversation ended and is queued for scoring.',
    payload: z.object({
      sessionId: id,
      scenarioId: id,
      userId: id,
      endReason: z.string(),
      turnCount: z.int(),
      durationSeconds: z.number(),
    }),
  }),
  scoreGenerated: define({
    type: 'ai.score.generated',
    version: 1,
    producer: 'ai-coaching-service',
    description: 'A role-play session was evaluated.',
    payload: z.object({
      sessionId: id,
      scenarioId: id,
      scenarioTitle: z.string(),
      scenarioCategory: z.string(),
      difficulty: z.string(),
      userId: id,
      overallScore: z.number(),
      passed: z.boolean(),
      passingScore: z.number(),
      categoryScores: z.array(z.object({ key: z.string(), label: z.string(), score: z.number() })),
      context: learningContextSchema,
      evaluatedAt: ts,
      promptVersionId: id,
      rubricVersionId: id,
    }),
  }),
  sessionReviewed: define({
    type: 'ai.session.reviewed',
    version: 1,
    producer: 'ai-coaching-service',
    description: 'A trainer or manager left coaching feedback on a session.',
    payload: z.object({
      sessionId: id,
      scenarioTitle: z.string(),
      userId: id,
      reviewerId: id,
    }),
  }),
};

// ---------------------------------------------------------------- certification

const certRef = {
  certificateId: id,
  definitionId: id,
  definitionName: z.string(),
  userId: id,
};

export const certificationEvents = {
  eligible: define({
    type: 'certificate.eligible',
    version: 1,
    producer: 'certification-service',
    description: 'A user satisfied every automatic requirement of a certification.',
    payload: z.object({
      candidateId: id,
      definitionId: id,
      definitionName: z.string(),
      userId: id,
      requiresApproval: z.boolean(),
    }),
  }),
  approvalRequested: define({
    type: 'certificate.approval_requested',
    version: 1,
    producer: 'certification-service',
    description: 'A certification is waiting for approval.',
    payload: z.object({
      approvalId: id,
      definitionId: id,
      definitionName: z.string(),
      userId: id,
    }),
  }),
  approvalDecided: define({
    type: 'certificate.approval_decided',
    version: 1,
    producer: 'certification-service',
    description: 'A certification approval was decided.',
    payload: z.object({
      approvalId: id,
      definitionId: id,
      definitionName: z.string(),
      userId: id,
      decision: z.enum(['approved', 'rejected']),
      decidedBy: id,
      comment: z.string().nullable(),
    }),
  }),
  issued: define({
    type: 'certificate.issued',
    version: 1,
    producer: 'certification-service',
    description: 'A certificate was issued.',
    payload: z.object({
      ...certRef,
      certificateNumber: z.string(),
      issuedAt: ts,
      expiresAt: ts.nullable(),
      mode: z.enum(['automatic', 'manual', 'approval', 'reissue', 'renewal']),
    }),
  }),
  generated: define({
    type: 'certificate.generated',
    version: 1,
    producer: 'certification-service',
    description: 'The certificate PDF is available.',
    payload: z.object({ ...certRef, certificateNumber: z.string() }),
  }),
  downloaded: define({
    type: 'certificate.downloaded',
    version: 1,
    producer: 'certification-service',
    description: 'A certificate PDF was downloaded.',
    payload: z.object({ ...certRef, downloadedBy: id }),
  }),
  revoked: define({
    type: 'certificate.revoked',
    version: 1,
    producer: 'certification-service',
    description: 'A certificate was revoked.',
    payload: z.object({ ...certRef, certificateNumber: z.string(), reason: z.string() }),
  }),
  reissued: define({
    type: 'certificate.reissued',
    version: 1,
    producer: 'certification-service',
    description: 'A certificate was replaced by a corrected certificate.',
    payload: z.object({ ...certRef, originalCertificateId: id, reason: z.string() }),
  }),
  expired: define({
    type: 'certificate.expired',
    version: 1,
    producer: 'certification-service',
    description: 'A certificate passed its expiration date.',
    payload: z.object({ ...certRef, expiredAt: ts }),
  }),
  expiring: define({
    type: 'certificate.expiring',
    version: 1,
    producer: 'certification-service',
    description: 'A certificate reached a configured reminder offset before expiry.',
    payload: z.object({ ...certRef, expiresAt: ts, daysRemaining: z.int() }),
  }),
  renewalRequired: define({
    type: 'certificate.renewal_required',
    version: 1,
    producer: 'certification-service',
    description: 'A certificate entered its renewal window.',
    payload: z.object({ ...certRef, renewalId: id, dueAt: ts }),
  }),
};

// ---------------------------------------------------------------- audit

export const auditRecordSchema = z.object({
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  actorDisplay: z.string().nullable(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  reason: z.string().nullable().optional(),
  ip: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  requestId: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AuditRecord = z.infer<typeof auditRecordSchema>;

export const auditEvents = {
  recorded: define({
    type: 'audit.recorded',
    version: 1,
    producer: 'identity-service',
    description:
      'A sensitive or administrative action. Every service publishes this type on its own stream.',
    payload: auditRecordSchema,
  }),
};

// ---------------------------------------------------------------- registry

export const EVENT_DEFINITIONS = [
  ...Object.values(identityEvents),
  ...Object.values(learningEvents),
  ...Object.values(mediaEvents),
  ...Object.values(assessmentEvents),
  ...Object.values(aiEvents),
  ...Object.values(certificationEvents),
  ...Object.values(auditEvents),
] as const;

type AnyDefinition = (typeof EVENT_DEFINITIONS)[number];
export type EventType = AnyDefinition['type'];
export type EventPayload<T extends EventType> = z.infer<Extract<AnyDefinition, { type: T }>['payload']>;

const registry = new Map<string, AnyDefinition>(
  EVENT_DEFINITIONS.map((d) => [`${d.type}@${d.version}`, d]),
);

export function getEventDefinition(type: string, version: number): AnyDefinition | undefined {
  return registry.get(`${type}@${version}`);
}

export function isSensitiveEvent(type: string, version: number): boolean {
  return Boolean(getEventDefinition(type, version)?.sensitive);
}
