// API contracts for the ai domain (AI homeowner objection trainer). Shared by the service and the web app.
import { z } from 'zod';
import {
  isoDate,
  isoDateTime,
  nameString,
  pageQuerySchema,
  pageSchema,
  personRefSchema,
  queryBoolean,
} from './common.js';

// ------------------------------------------------------------------ enums

export const AI_PROVIDERS = ['anthropic', 'openai', 'dev_simulator'] as const;
export const aiProviderSchema = z.enum(AI_PROVIDERS);
export type AiProvider = z.infer<typeof aiProviderSchema>;

/** Provider preference: `auto` picks the first configured real provider, then the development simulator. */
export const aiProviderPreferenceSchema = z.enum(['auto', ...AI_PROVIDERS]);
export type AiProviderPreference = z.infer<typeof aiProviderPreferenceSchema>;

export const SCENARIO_DIFFICULTIES = ['beginner', 'intermediate', 'advanced', 'expert'] as const;
export const scenarioDifficultySchema = z.enum(SCENARIO_DIFFICULTIES);
export type ScenarioDifficulty = z.infer<typeof scenarioDifficultySchema>;

export const SCENARIO_STATUSES = ['draft', 'published', 'archived'] as const;
export const scenarioStatusSchema = z.enum(SCENARIO_STATUSES);
export type ScenarioStatus = z.infer<typeof scenarioStatusSchema>;

export const SESSION_MODES = ['practice', 'assigned'] as const;
export const sessionModeSchema = z.enum(SESSION_MODES);

export const SESSION_STATUSES = [
  'active',
  'ended',
  'evaluating',
  'evaluated',
  'evaluation_failed',
  'abandoned',
] as const;
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const END_REASONS = [
  'rep_ended',
  'objective_reached',
  'homeowner_ended',
  'max_turns',
  'timeout',
] as const;
export const endReasonSchema = z.enum(END_REASONS);
export type EndReason = z.infer<typeof endReasonSchema>;

export const MODALITIES = ['text', 'voice'] as const;
export const modalitySchema = z.enum(MODALITIES);
export type Modality = z.infer<typeof modalitySchema>;

export const MESSAGE_ROLES = ['homeowner', 'rep'] as const;
export const messageRoleSchema = z.enum(MESSAGE_ROLES);

export const REVIEW_RECOMMENDATIONS = ['ready', 'practice_again', 'retrain'] as const;
export const reviewRecommendationSchema = z.enum(REVIEW_RECOMMENDATIONS);

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const effortSchema = z.enum(EFFORT_LEVELS);

/** The fourteen categories of the default A5 objection-handling rubric. */
export const DEFAULT_RUBRIC_CATEGORY_KEYS = [
  'discovery',
  'listening',
  'rapport',
  'empathy',
  'communication',
  'confidence',
  'roofing_knowledge',
  'insurance_knowledge',
  'value_presentation',
  'objection_isolation',
  'objection_handling',
  'question_quality',
  'next_step_closing',
  'compliance',
] as const;

const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, min > 0 ? 'Required' : undefined)
    .max(max);
const lineList = (maxItems: number, maxLength = 300) =>
  z.array(z.string().trim().min(1).max(maxLength)).max(maxItems);
const modelId = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, 'Use a model id such as claude-opus-5-5');

/** Per-scenario model tuning. Values the selected model does not support are ignored by the provider. */
export const modelSettingsSchema = z.object({
  /** Sampling temperature for models that accept it (current Claude models do not). */
  temperature: z.number().min(0).max(1).optional(),
  /** Upper bound for one homeowner reply. */
  maxOutputTokens: z.int().min(64).max(64_000).optional(),
  /** Reasoning effort for the homeowner (low keeps replies fast). */
  effort: effortSchema.optional(),
  /** Reasoning effort for the evaluator. */
  evaluationEffort: effortSchema.optional(),
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;

export const providerInfoSchema = z.object({
  name: aiProviderSchema,
  /** Human label, e.g. "Anthropic Claude" or "Development simulator". */
  label: z.string(),
  model: z.string(),
  simulated: z.boolean(),
});
export type ProviderInfo = z.infer<typeof providerInfoSchema>;

// ------------------------------------------------------------------ personas

export const personaSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  temperament: z.string(),
  speakingStyle: z.string(),
  background: z.string(),
  traits: z.array(z.string()),
  archived: z.boolean(),
  scenarioCount: z.int(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Persona = z.infer<typeof personaSchema>;

export const createPersonaRequestSchema = z.object({
  name: nameString(80),
  description: text(1, 2000),
  temperament: text(1, 300),
  speakingStyle: text(1, 600),
  background: text(1, 2000),
  traits: lineList(12, 120).default([]),
});
export type CreatePersonaRequest = z.infer<typeof createPersonaRequestSchema>;

export const updatePersonaRequestSchema = createPersonaRequestSchema.partial().extend({
  changeNote: z.string().trim().max(300).optional(),
});
export type UpdatePersonaRequest = z.infer<typeof updatePersonaRequestSchema>;

export const listPersonasQuerySchema = pageQuerySchema.extend({ includeArchived: queryBoolean });
export const personaPageSchema = pageSchema(personaSchema);

// ------------------------------------------------------------------ rubrics

export const rubricCategorySchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use lowercase letters, digits and underscores'),
  label: text(1, 80),
  description: text(1, 600),
  weight: z.number().min(0).max(100),
  guidance: text(0, 1500),
});
export type RubricCategory = z.infer<typeof rubricCategorySchema>;

export const rubricCategoriesSchema = z
  .array(rubricCategorySchema)
  .min(1)
  .max(30)
  .refine(
    (list) => new Set(list.map((c) => c.key)).size === list.length,
    'Category keys must be unique',
  )
  .refine(
    (list) => list.reduce((sum, c) => sum + c.weight, 0) > 0,
    'At least one category needs a weight above zero',
  );

export const rubricVersionSummarySchema = z.object({
  id: z.uuid(),
  version: z.int(),
  passingScore: z.int(),
  categoryCount: z.int(),
  changeNote: z.string().nullable(),
  createdBy: personRefSchema.nullable(),
  createdAt: isoDateTime,
});

export const rubricVersionSchema = rubricVersionSummarySchema.extend({
  rubricId: z.uuid(),
  categories: z.array(rubricCategorySchema),
});
export type RubricVersion = z.infer<typeof rubricVersionSchema>;

export const rubricSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  archived: z.boolean(),
  scenarioCount: z.int(),
  currentVersion: rubricVersionSummarySchema,
  updatedAt: isoDateTime,
});
export const rubricPageSchema = pageSchema(rubricSummarySchema);

export const rubricDetailSchema = rubricSummarySchema.extend({
  currentVersion: rubricVersionSchema,
  versions: z.array(rubricVersionSummarySchema),
});
export type RubricDetail = z.infer<typeof rubricDetailSchema>;

export const createRubricRequestSchema = z.object({
  title: nameString(120),
  description: z.string().trim().max(1000).nullable().optional(),
  /** Omit to start from the fourteen default A5 categories. */
  categories: rubricCategoriesSchema.optional(),
  passingScore: z.int().min(0).max(100).default(75),
});
export type CreateRubricRequest = z.infer<typeof createRubricRequestSchema>;

export const updateRubricRequestSchema = z.object({
  title: nameString(120).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
});

export const createRubricVersionRequestSchema = z.object({
  categories: rubricCategoriesSchema,
  passingScore: z.int().min(0).max(100),
  changeNote: z.string().trim().max(300).optional(),
});
export type CreateRubricVersionRequest = z.infer<typeof createRubricVersionRequestSchema>;

export const listRubricsQuerySchema = pageQuerySchema.extend({ includeArchived: queryBoolean });

// ------------------------------------------------------------------ scenarios (administration)

const scenarioBody = {
  title: nameString(120),
  category: nameString(60),
  difficulty: scenarioDifficultySchema,
  personaId: z.uuid(),
  objection: text(1, 300),
  /** What the representative knows before the door opens. Shown to learners. */
  repBrief: text(1, 1500),
  background: text(1, 3000),
  propertyContext: text(1, 2000),
  trigger: text(1, 1000),
  /** Never shown to learners; revealed by the homeowner only after genuine discovery. */
  hiddenConcern: text(1, 1500),
  expectedBehaviors: lineList(20),
  requiredTalkingPoints: lineList(20),
  forbiddenClaims: lineList(20),
  aiInstructions: text(0, 3000).default(''),
  openingLine: text(1, 500),
  passingScore: z.int().min(0).max(100),
  rubricId: z.uuid(),
  maxTurns: z.int().min(2).max(60),
  /** Null uses the organization default. */
  provider: aiProviderSchema.nullable().default(null),
  model: modelId.nullable().default(null),
  evaluationModel: modelId.nullable().default(null),
  modelSettings: modelSettingsSchema.default({}),
};

export const createScenarioRequestSchema = z.object({
  ...scenarioBody,
  changeNote: z.string().trim().max(300).optional(),
});
export type CreateScenarioRequest = z.infer<typeof createScenarioRequestSchema>;

export const updateScenarioRequestSchema = z
  .object({
    title: scenarioBody.title.optional(),
    category: scenarioBody.category.optional(),
    difficulty: scenarioBody.difficulty.optional(),
    personaId: scenarioBody.personaId.optional(),
    objection: scenarioBody.objection.optional(),
    repBrief: scenarioBody.repBrief.optional(),
    background: scenarioBody.background.optional(),
    propertyContext: scenarioBody.propertyContext.optional(),
    trigger: scenarioBody.trigger.optional(),
    hiddenConcern: scenarioBody.hiddenConcern.optional(),
    expectedBehaviors: scenarioBody.expectedBehaviors.optional(),
    requiredTalkingPoints: scenarioBody.requiredTalkingPoints.optional(),
    forbiddenClaims: scenarioBody.forbiddenClaims.optional(),
    aiInstructions: text(0, 3000).optional(),
    openingLine: scenarioBody.openingLine.optional(),
    passingScore: scenarioBody.passingScore.optional(),
    rubricId: scenarioBody.rubricId.optional(),
    maxTurns: scenarioBody.maxTurns.optional(),
    provider: aiProviderSchema.nullable().optional(),
    model: modelId.nullable().optional(),
    evaluationModel: modelId.nullable().optional(),
    modelSettings: modelSettingsSchema.optional(),
    changeNote: z.string().trim().max(300).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'changeNote'), 'Change at least one field');
export type UpdateScenarioRequest = z.infer<typeof updateScenarioRequestSchema>;

export const duplicateScenarioRequestSchema = z.object({ title: nameString(120).optional() });

export const listScenariosQuerySchema = pageQuerySchema.extend({
  status: scenarioStatusSchema.optional(),
  category: z.string().trim().max(60).optional(),
  difficulty: scenarioDifficultySchema.optional(),
  personaId: z.uuid().optional(),
});

export const promptVersionRefSchema = z.object({
  id: z.uuid(),
  version: z.int(),
  createdAt: isoDateTime,
});

export const scenarioSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  category: z.string(),
  difficulty: scenarioDifficultySchema,
  status: scenarioStatusSchema,
  objection: z.string(),
  persona: z.object({ id: z.uuid(), name: z.string() }),
  passingScore: z.int(),
  maxTurns: z.int(),
  provider: aiProviderSchema.nullable(),
  model: z.string().nullable(),
  currentPromptVersion: promptVersionRefSchema.nullable(),
  sessionCount: z.int(),
  publishedAt: isoDateTime.nullable(),
  updatedAt: isoDateTime,
});
export const scenarioPageSchema = pageSchema(scenarioSummarySchema);

export const scenarioDetailSchema = scenarioSummarySchema.extend({
  repBrief: z.string(),
  background: z.string(),
  propertyContext: z.string(),
  trigger: z.string(),
  hiddenConcern: z.string(),
  expectedBehaviors: z.array(z.string()),
  requiredTalkingPoints: z.array(z.string()),
  forbiddenClaims: z.array(z.string()),
  aiInstructions: z.string(),
  openingLine: z.string(),
  rubric: z.object({ id: z.uuid(), title: z.string(), currentVersion: z.int() }),
  evaluationModel: z.string().nullable(),
  modelSettings: modelSettingsSchema,
  archivedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type ScenarioDetail = z.infer<typeof scenarioDetailSchema>;

export const promptVersionSummarySchema = z.object({
  id: z.uuid(),
  version: z.int(),
  changeNote: z.string().nullable(),
  provider: aiProviderSchema.nullable(),
  model: z.string().nullable(),
  evaluationModel: z.string().nullable(),
  rubricVersionId: z.uuid(),
  current: z.boolean(),
  sessionCount: z.int(),
  createdBy: personRefSchema.nullable(),
  createdAt: isoDateTime,
});
export const promptVersionListSchema = z.object({ items: z.array(promptVersionSummarySchema) });

export const promptVersionDetailSchema = promptVersionSummarySchema.extend({
  scenarioId: z.uuid(),
  homeownerSystemPrompt: z.string(),
  evaluatorSystemPrompt: z.string(),
  personaSnapshot: z.record(z.string(), z.unknown()),
  scenarioSnapshot: z.record(z.string(), z.unknown()),
  modelSettings: modelSettingsSchema,
});
export type PromptVersionDetail = z.infer<typeof promptVersionDetailSchema>;

export const promptVersionDiffQuerySchema = z.object({ from: z.uuid(), to: z.uuid() });
export const promptVersionDiffSchema = z.object({
  from: promptVersionSummarySchema,
  to: promptVersionSummarySchema,
  changes: z.array(z.object({ field: z.string(), before: z.unknown(), after: z.unknown() })),
});
export type PromptVersionDiff = z.infer<typeof promptVersionDiffSchema>;

// ------------------------------------------------------------------ practice catalogue (learners)

export const listPracticeScenariosQuerySchema = pageQuerySchema.extend({
  category: z.string().trim().max(60).optional(),
  difficulty: scenarioDifficultySchema.optional(),
});

export const practiceStatsSchema = z.object({
  attempts: z.int(),
  bestScore: z.int().nullable(),
  passed: z.boolean(),
  lastPracticedAt: isoDateTime.nullable(),
});

export const practiceScenarioSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  category: z.string(),
  difficulty: scenarioDifficultySchema,
  objection: z.string(),
  persona: z.object({ name: z.string() }),
  passingScore: z.int(),
  maxTurns: z.int(),
  myStats: practiceStatsSchema,
});
export type PracticeScenario = z.infer<typeof practiceScenarioSchema>;
export const practiceScenarioPageSchema = pageSchema(practiceScenarioSchema);

/** What a representative may know before the conversation. Never includes the hidden concern or rubric internals. */
export const practiceScenarioBriefSchema = practiceScenarioSchema.extend({
  repBrief: z.string(),
  persona: z.object({ name: z.string(), description: z.string() }),
  scoredOn: z.array(z.object({ key: z.string(), label: z.string() })),
});
export type PracticeScenarioBrief = z.infer<typeof practiceScenarioBriefSchema>;

// ------------------------------------------------------------------ sessions

export const learningContextSchema = z.object({
  programId: z.uuid().optional(),
  enrollmentId: z.uuid().optional(),
  lessonId: z.uuid().optional(),
});

export const startSessionRequestSchema = z.object({
  scenarioId: z.uuid(),
  /** Signed lesson grant from learning-service; makes the session an assigned lesson attempt. */
  lessonGrant: z.string().trim().min(16).max(8000).optional(),
  modality: modalitySchema.default('text'),
});
export type StartSessionRequest = z.infer<typeof startSessionRequestSchema>;

export const messageSchema = z.object({
  id: z.uuid(),
  seq: z.int(),
  role: messageRoleSchema,
  content: z.string(),
  modality: modalitySchema,
  audioRef: z.string().nullable(),
  createdAt: isoDateTime,
});
export type Message = z.infer<typeof messageSchema>;

export const evidenceSchema = z.object({ seq: z.int(), quote: z.string() });

export const scorecardSchema = z.object({
  id: z.uuid(),
  overallScore: z.int().min(0).max(100),
  passed: z.boolean(),
  passingScore: z.int(),
  categoryScores: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      weight: z.number(),
      score: z.int().min(0).max(100),
      rationale: z.string(),
      evidence: z.array(evidenceSchema),
    }),
  ),
  strengths: z.array(z.object({ point: z.string(), evidence: z.array(evidenceSchema) })),
  missedOpportunities: z.array(
    z.object({
      point: z.string(),
      seq: z.int().nullable(),
      quote: z.string().nullable(),
      betterApproach: z.string(),
    }),
  ),
  questionsToAsk: z.array(z.object({ question: z.string(), why: z.string() })),
  riskyStatements: z.array(
    z.object({ seq: z.int(), quote: z.string(), issue: z.string(), saferAlternative: z.string() }),
  ),
  recommendedResponses: z.array(
    z.object({
      seq: z.int().nullable(),
      repSaid: z.string().nullable(),
      betterResponse: z.string(),
      why: z.string(),
    }),
  ),
  nextGoal: z.string(),
  summary: z.string(),
  provider: providerInfoSchema,
  promptVersionId: z.uuid(),
  rubricVersionId: z.uuid(),
  evaluatedAt: isoDateTime,
});
export type Scorecard = z.infer<typeof scorecardSchema>;

export const reviewSchema = z.object({
  id: z.uuid(),
  reviewer: personRefSchema,
  comment: z.string(),
  recommendation: reviewRecommendationSchema,
  createdAt: isoDateTime,
});
export type Review = z.infer<typeof reviewSchema>;

export const sessionScenarioRefSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  category: z.string(),
  difficulty: scenarioDifficultySchema,
  objection: z.string(),
});

export const sessionSchema = z.object({
  id: z.uuid(),
  scenario: sessionScenarioRefSchema,
  promptVersion: z.object({ id: z.uuid(), version: z.int() }),
  mode: sessionModeSchema,
  isTest: z.boolean(),
  modality: modalitySchema,
  status: sessionStatusSchema,
  endReason: endReasonSchema.nullable(),
  context: learningContextSchema,
  turnCount: z.int(),
  maxTurns: z.int(),
  turnsRemaining: z.int(),
  /** The last representative message has no homeowner reply yet (retry it). */
  awaitingReply: z.boolean(),
  provider: providerInfoSchema,
  startedAt: isoDateTime,
  endedAt: isoDateTime.nullable(),
  messages: z.array(messageSchema),
  /** Transcript removed by the organization's retention policy. */
  transcriptPurged: z.boolean(),
  evaluation: scorecardSchema.nullable(),
  evaluationError: z.string().nullable(),
  reviews: z.array(reviewSchema),
});
export type Session = z.infer<typeof sessionSchema>;

export const sessionSummarySchema = z.object({
  id: z.uuid(),
  scenario: sessionScenarioRefSchema,
  mode: sessionModeSchema,
  isTest: z.boolean(),
  status: sessionStatusSchema,
  endReason: endReasonSchema.nullable(),
  turnCount: z.int(),
  startedAt: isoDateTime,
  endedAt: isoDateTime.nullable(),
  overallScore: z.int().nullable(),
  passed: z.boolean().nullable(),
  provider: providerInfoSchema,
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export const sessionPageSchema = pageSchema(sessionSummarySchema);

export const mySessionsQuerySchema = pageQuerySchema.extend({
  scenarioId: z.uuid().optional(),
  status: sessionStatusSchema.optional(),
});

export const sendMessageRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(2000).optional(),
    /** Reference to an uploaded audio clip (voice modality; requires a speech-to-text provider). */
    audioRef: z.string().trim().min(1).max(500).optional(),
    /** Regenerate the homeowner reply to the last unanswered message (after an error). */
    retry: z.boolean().optional(),
    /** Client-generated id; resending the same id never duplicates the message. */
    clientMessageId: z.uuid().optional(),
  })
  .refine((v) => Boolean(v.text) || Boolean(v.audioRef) || v.retry === true, {
    message: 'Type a message, or retry the last one',
    path: ['text'],
  });
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const turnErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});

/** JSON response of POST /ai/sessions/:id/messages when the client sends `Accept: application/json`. */
export const sendMessageResponseSchema = z.object({
  repMessage: messageSchema.nullable(),
  reply: messageSchema.nullable(),
  sessionEnded: z.boolean(),
  endReason: endReasonSchema.nullable(),
  status: sessionStatusSchema,
  turnCount: z.int(),
  turnsRemaining: z.int(),
  error: turnErrorSchema.nullable(),
});
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;

/**
 * Server-Sent Events of POST /ai/sessions/:id/messages (Accept: text/event-stream):
 * `accepted` (rep message saved) → `delta`* (homeowner reply text) → `done` | `error`.
 */
export const streamAcceptedEventSchema = z.object({
  repMessage: messageSchema.nullable(),
  retried: z.boolean(),
});
export const streamDeltaEventSchema = z.object({ text: z.string() });
export const streamDoneEventSchema = z.object({
  messageId: z.uuid(),
  message: messageSchema,
  sessionEnded: z.boolean(),
  endReason: endReasonSchema.nullable(),
  status: sessionStatusSchema,
  turnCount: z.int(),
  turnsRemaining: z.int(),
});
export const streamErrorEventSchema = turnErrorSchema;

// ------------------------------------------------------------------ review (trainers / managers)

export const reviewSessionsQuerySchema = pageQuerySchema.extend({
  userId: z.uuid().optional(),
  scenarioId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  status: sessionStatusSchema.optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  reviewed: queryBoolean,
  includeTests: queryBoolean,
});

export const reviewSessionSummarySchema = sessionSummarySchema.extend({
  learner: personRefSchema,
  reviewCount: z.int(),
  lastReviewedAt: isoDateTime.nullable(),
});
export type ReviewSessionSummary = z.infer<typeof reviewSessionSummarySchema>;
export const reviewSessionPageSchema = pageSchema(reviewSessionSummarySchema);

export const reviewSessionDetailSchema = sessionSchema.extend({ learner: personRefSchema });
export type ReviewSessionDetail = z.infer<typeof reviewSessionDetailSchema>;

export const createReviewRequestSchema = z.object({
  comment: text(1, 4000),
  recommendation: reviewRecommendationSchema,
});
export type CreateReviewRequest = z.infer<typeof createReviewRequestSchema>;

// ------------------------------------------------------------------ settings & usage

export const providerStatusSchema = z.object({
  name: aiProviderSchema,
  label: z.string(),
  available: z.boolean(),
  simulated: z.boolean(),
  defaultConversationModel: z.string(),
  defaultEvaluationModel: z.string(),
});

export const aiSettingsSchema = z.object({
  defaultProvider: aiProviderPreferenceSchema,
  conversationModel: z.string().nullable(),
  evaluationModel: z.string().nullable(),
  maxSessionsPerLearnerPerDay: z.int().nullable(),
  transcriptRetentionDays: z.int().nullable(),
  timezone: z.string(),
  updatedAt: isoDateTime.nullable(),
  updatedBy: personRefSchema.nullable(),
  providers: z.array(providerStatusSchema),
  effective: z.object({ conversation: providerInfoSchema, evaluation: providerInfoSchema }),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const updateAiSettingsRequestSchema = z
  .object({
    defaultProvider: aiProviderPreferenceSchema.optional(),
    conversationModel: modelId.nullable().optional(),
    evaluationModel: modelId.nullable().optional(),
    maxSessionsPerLearnerPerDay: z.int().min(1).max(500).nullable().optional(),
    transcriptRetentionDays: z.int().min(30).max(3650).nullable().optional(),
    timezone: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Use an IANA time zone such as America/Chicago')
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one setting');
export type UpdateAiSettingsRequest = z.infer<typeof updateAiSettingsRequestSchema>;

export const usageQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  provider: aiProviderSchema.optional(),
  model: z.string().trim().max(100).optional(),
  includeTests: queryBoolean,
});

const usageTotals = {
  calls: z.int(),
  failedCalls: z.int(),
  inputTokens: z.int(),
  outputTokens: z.int(),
  cacheReadTokens: z.int(),
  cacheWriteTokens: z.int(),
  estimatedCostUsd: z.number(),
};

export const usageReportSchema = z.object({
  from: isoDate,
  to: isoDate,
  totals: z.object({ ...usageTotals, unpricedCalls: z.int() }),
  byDay: z.array(z.object({ date: isoDate, ...usageTotals })),
  byModel: z.array(z.object({ provider: aiProviderSchema, model: z.string(), ...usageTotals })),
  byProvider: z.array(z.object({ provider: aiProviderSchema, ...usageTotals })),
  byPurpose: z.array(z.object({ purpose: z.enum(['conversation', 'evaluation']), ...usageTotals })),
});
export type UsageReport = z.infer<typeof usageReportSchema>;
