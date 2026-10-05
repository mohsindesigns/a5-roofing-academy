// API contracts for the assessment domain. Shared by assessment-service and the web app (question
// editor, assessment builder, learner player and review screens).
import { z } from 'zod';
import {
  isoDateTime,
  nameString,
  optionalText,
  pageQuerySchema,
  pageSchema,
  personRefSchema,
  queryBoolean,
  queryList,
} from './common.js';

// ------------------------------------------------------------------ enums

export const QUESTION_TYPES = [
  'multiple_choice',
  'multiple_select',
  'true_false',
  'short_answer',
  'long_answer',
  'scenario',
  'ordering',
  'matching',
] as const;
export const questionTypeSchema = z.enum(QUESTION_TYPES);
export type QuestionType = z.infer<typeof questionTypeSchema>;

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  multiple_choice: 'Multiple choice',
  multiple_select: 'Multiple select',
  true_false: 'True / false',
  short_answer: 'Short answer',
  long_answer: 'Long answer',
  scenario: 'Scenario',
  ordering: 'Ordering',
  matching: 'Matching',
};

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export const difficultySchema = z.enum(DIFFICULTIES);
export type Difficulty = z.infer<typeof difficultySchema>;

export const QUESTION_STATUSES = ['active', 'archived'] as const;
export const questionStatusSchema = z.enum(QUESTION_STATUSES);
export type QuestionStatus = z.infer<typeof questionStatusSchema>;

export const ASSESSMENT_KINDS = ['quiz', 'exam', 'final', 'practice'] as const;
export const assessmentKindSchema = z.enum(ASSESSMENT_KINDS);
export type AssessmentKind = z.infer<typeof assessmentKindSchema>;

export const ASSESSMENT_STATUSES = ['draft', 'published', 'archived'] as const;
export const assessmentStatusSchema = z.enum(ASSESSMENT_STATUSES);
export type AssessmentStatus = z.infer<typeof assessmentStatusSchema>;

/**
 * Attempt lifecycle:
 * `in_progress` → `submitted` (learner submitted) | `expired` (time limit passed; saved answers were
 * submitted automatically) → `graded` | `pending_review` (open answers wait for a trainer) → `graded`.
 * Answers are frozen as soon as an attempt leaves `in_progress`.
 */
export const ATTEMPT_STATUSES = ['in_progress', 'submitted', 'pending_review', 'graded', 'expired'] as const;
export const attemptStatusSchema = z.enum(ATTEMPT_STATUSES);
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

export const REVEAL_POLICIES = ['never', 'after_submit', 'after_pass', 'after_final_attempt'] as const;
export const revealPolicySchema = z.enum(REVEAL_POLICIES);
export type RevealPolicy = z.infer<typeof revealPolicySchema>;

export const MANAGER_NOTIFY_OUTCOMES = ['failed', 'passed'] as const;
export const managerNotifyOutcomeSchema = z.enum(MANAGER_NOTIFY_OUTCOMES);

export const SCORING_MODES = ['all_or_nothing', 'partial'] as const;
export const scoringModeSchema = z.enum(SCORING_MODES);
export type ScoringMode = z.infer<typeof scoringModeSchema>;

const refSchema = z.object({ id: z.uuid(), name: z.string() });

// ------------------------------------------------------------------ question content (per type)

/**
 * Identifier of an option, item or matching side inside one question. The editor generates random
 * ids; ids are shown to learners, so they must never encode the answer (no "1, 2, 3" for ordering).
 */
export const choiceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, digits, - and _ only');

const choiceText = (max = 500) => z.string().trim().min(1, 'Required').max(max);
const markdown = (max: number) => z.string().trim().min(1, 'Required').max(max);

function checkUnique(ids: readonly string[], ctx: z.RefinementCtx, path: Array<string | number>, label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) ctx.addIssue({ code: 'custom', path, message: `Each ${label} needs a unique id ("${id}" is repeated)` });
    seen.add(id);
  }
}

export const choiceOptionSchema = z.object({ id: choiceIdSchema, text: choiceText(), correct: z.boolean() });
export type ChoiceOption = z.infer<typeof choiceOptionSchema>;

function singleCorrect(options: ChoiceOption[], ctx: z.RefinementCtx): void {
  checkUnique(
    options.map((o) => o.id),
    ctx,
    ['options'],
    'option',
  );
  if (options.filter((o) => o.correct).length !== 1) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'Mark exactly one option as correct' });
  }
}

export const multipleChoiceConfigSchema = z
  .object({ options: z.array(choiceOptionSchema).min(2, 'Add at least two options').max(10, 'Use at most 10 options') })
  .superRefine((c, ctx) => singleCorrect(c.options, ctx));
export type MultipleChoiceConfig = z.infer<typeof multipleChoiceConfigSchema>;

export const multipleSelectConfigSchema = z
  .object({
    options: z.array(choiceOptionSchema).min(2, 'Add at least two options').max(12, 'Use at most 12 options'),
    /** `partial`: (correct picks − wrong picks) / correct options, never below zero. */
    scoring: scoringModeSchema.default('all_or_nothing'),
  })
  .superRefine((c, ctx) => {
    checkUnique(
      c.options.map((o) => o.id),
      ctx,
      ['options'],
      'option',
    );
    if (!c.options.some((o) => o.correct)) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Mark at least one option as correct' });
    }
  });
export type MultipleSelectConfig = z.infer<typeof multipleSelectConfigSchema>;

export const trueFalseConfigSchema = z.object({ correctAnswer: z.boolean() });
export type TrueFalseConfig = z.infer<typeof trueFalseConfigSchema>;

export const shortAnswerConfigSchema = z
  .object({
    /** `auto`: compared with accepted answers after normalisation. `manual`: a trainer reviews it. */
    grading: z.enum(['auto', 'manual']).default('auto'),
    acceptedAnswers: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    caseSensitive: z.boolean().default(false),
    /** Trim and collapse runs of whitespace before comparing. */
    normalizeWhitespace: z.boolean().default(true),
    maxLength: z.int().min(1).max(500).default(200),
    /** Guidance for reviewers when grading is manual. */
    reviewGuidance: optionalText(5000),
  })
  .superRefine((c, ctx) => {
    if (c.grading === 'auto' && c.acceptedAnswers.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['acceptedAnswers'], message: 'Add at least one accepted answer, or switch to manual review' });
    }
  });
export type ShortAnswerConfig = z.infer<typeof shortAnswerConfigSchema>;

export const longAnswerConfigSchema = z
  .object({
    /** What a reviewer looks for; shown to trainers only. */
    rubric: markdown(5000),
    sampleAnswer: optionalText(5000),
    minWords: z.int().min(0).max(5000).nullable().default(null),
    maxWords: z.int().min(1).max(5000).nullable().default(null),
  })
  .superRefine((c, ctx) => {
    if (c.minWords !== null && c.maxWords !== null && c.minWords > c.maxWords) {
      ctx.addIssue({ code: 'custom', path: ['maxWords'], message: 'Maximum words must be at least the minimum' });
    }
  });
export type LongAnswerConfig = z.infer<typeof longAnswerConfigSchema>;

export const scenarioSubQuestionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('multiple_choice'),
      prompt: markdown(2000),
      options: z.array(choiceOptionSchema).min(2, 'Add at least two options').max(10),
    })
    .superRefine((c, ctx) => singleCorrect(c.options, ctx)),
  z.object({
    kind: z.literal('open_response'),
    prompt: markdown(2000),
    rubric: markdown(5000),
    sampleAnswer: optionalText(5000),
    maxLength: z.int().min(50).max(5000).default(2000),
  }),
]);
export type ScenarioSubQuestion = z.infer<typeof scenarioSubQuestionSchema>;

export const scenarioConfigSchema = z.object({
  scenario: markdown(5000),
  subQuestion: scenarioSubQuestionSchema,
});
export type ScenarioConfig = z.infer<typeof scenarioConfigSchema>;

export const orderingConfigSchema = z
  .object({
    /** Items listed in the correct order. Learners always see them shuffled. */
    items: z.array(z.object({ id: choiceIdSchema, text: choiceText(300) })).min(2, 'Add at least two items').max(10),
    /** `partial`: share of items in the correct position. */
    scoring: scoringModeSchema.default('all_or_nothing'),
  })
  .superRefine((c, ctx) =>
    checkUnique(
      c.items.map((i) => i.id),
      ctx,
      ['items'],
      'item',
    ),
  );
export type OrderingConfig = z.infer<typeof orderingConfigSchema>;

export const matchingConfigSchema = z
  .object({
    /** Correct pairs. Learners see the left side in this order and the right side shuffled. */
    pairs: z
      .array(z.object({ leftId: choiceIdSchema, left: choiceText(300), rightId: choiceIdSchema, right: choiceText(300) }))
      .min(2, 'Add at least two pairs')
      .max(10),
    /** `partial`: share of pairs matched correctly. */
    scoring: scoringModeSchema.default('all_or_nothing'),
  })
  .superRefine((c, ctx) => {
    const left = c.pairs.map((p) => p.leftId);
    const right = c.pairs.map((p) => p.rightId);
    checkUnique([...left, ...right], ctx, ['pairs'], 'side');
  });
export type MatchingConfig = z.infer<typeof matchingConfigSchema>;

/** A question's type and its type-specific configuration. */
export const questionDefinitionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('multiple_choice'), config: multipleChoiceConfigSchema }),
  z.object({ type: z.literal('multiple_select'), config: multipleSelectConfigSchema }),
  z.object({ type: z.literal('true_false'), config: trueFalseConfigSchema }),
  z.object({ type: z.literal('short_answer'), config: shortAnswerConfigSchema }),
  z.object({ type: z.literal('long_answer'), config: longAnswerConfigSchema }),
  z.object({ type: z.literal('scenario'), config: scenarioConfigSchema }),
  z.object({ type: z.literal('ordering'), config: orderingConfigSchema }),
  z.object({ type: z.literal('matching'), config: matchingConfigSchema }),
]);
export type QuestionDefinition = z.infer<typeof questionDefinitionSchema>;

/** Whether answers to this question are graded by a person rather than automatically. */
export function requiresManualReview(def: QuestionDefinition): boolean {
  switch (def.type) {
    case 'long_answer':
      return true;
    case 'short_answer':
      return def.config.grading === 'manual';
    case 'scenario':
      return def.config.subQuestion.kind === 'open_response';
    default:
      return false;
  }
}

export const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9 _-]*$/, 'Tags use letters, digits, spaces, - and _');

const tagListSchema = z
  .array(tagSchema)
  .max(20, 'Use at most 20 tags')
  .transform((tags) => [...new Set(tags)]);

const versionFields = {
  prompt: markdown(5000),
  explanation: optionalText(5000),
  points: z
    .number()
    .positive('Points must be greater than zero')
    .max(100)
    .transform((v) => Math.round(v * 100) / 100)
    .default(1),
  difficulty: difficultySchema.default('medium'),
  categoryId: z.uuid().nullable().default(null),
  competencyIds: z
    .array(z.uuid())
    .max(10)
    .default([])
    .transform((ids) => [...new Set(ids)]),
  tags: tagListSchema.default([]),
};

function versionInput<T extends QuestionType, C extends z.ZodType, E extends z.ZodRawShape>(type: T, config: C, extra: E) {
  return z.object({ type: z.literal(type), config, ...versionFields, ...extra });
}

function versionInputUnion<E extends z.ZodRawShape>(extra: E) {
  return z.discriminatedUnion('type', [
    versionInput('multiple_choice', multipleChoiceConfigSchema, extra),
    versionInput('multiple_select', multipleSelectConfigSchema, extra),
    versionInput('true_false', trueFalseConfigSchema, extra),
    versionInput('short_answer', shortAnswerConfigSchema, extra),
    versionInput('long_answer', longAnswerConfigSchema, extra),
    versionInput('scenario', scenarioConfigSchema, extra),
    versionInput('ordering', orderingConfigSchema, extra),
    versionInput('matching', matchingConfigSchema, extra),
  ]);
}

/** Content of one immutable question version, as authored in the editor. */
export const questionVersionInputSchema = versionInputUnion({});
export type QuestionVersionInput = z.input<typeof questionVersionInputSchema>;
export type QuestionVersionData = z.infer<typeof questionVersionInputSchema>;

export const createQuestionRequestSchema = versionInputUnion({ bankId: z.uuid() });
export type CreateQuestionRequest = z.input<typeof createQuestionRequestSchema>;

/** Editing a question always creates a new immutable version; past attempts keep theirs. */
export const updateQuestionRequestSchema = versionInputUnion({
  changeNote: optionalText(500),
  /** Optimistic concurrency: the version the editor started from. */
  expectedVersion: z.int().min(1).optional(),
});
export type UpdateQuestionRequest = z.input<typeof updateQuestionRequestSchema>;

// ------------------------------------------------------------------ learner answers

export const answerResponseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('multiple_choice'), optionId: choiceIdSchema }),
  z.object({ type: z.literal('multiple_select'), optionIds: z.array(choiceIdSchema).max(12) }),
  z.object({ type: z.literal('true_false'), value: z.boolean() }),
  z.object({ type: z.literal('short_answer'), text: z.string().max(500) }),
  z.object({ type: z.literal('long_answer'), text: z.string().max(30_000) }),
  z
    .object({ type: z.literal('scenario'), optionId: choiceIdSchema.optional(), text: z.string().max(5000).optional() })
    .refine((r) => (r.optionId === undefined) !== (r.text === undefined), {
      message: 'Answer a scenario with either an option or text',
    }),
  z.object({ type: z.literal('ordering'), order: z.array(choiceIdSchema).max(10) }),
  z.object({ type: z.literal('matching'), matches: z.record(choiceIdSchema, choiceIdSchema) }),
]);
export type AnswerResponse = z.infer<typeof answerResponseSchema>;

/** The correct answer of a question, revealed to learners according to the reveal policy. */
export const correctAnswerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('multiple_choice'), optionId: z.string() }),
  z.object({ type: z.literal('multiple_select'), optionIds: z.array(z.string()) }),
  z.object({ type: z.literal('true_false'), value: z.boolean() }),
  z.object({ type: z.literal('short_answer'), acceptedAnswers: z.array(z.string()) }),
  z.object({ type: z.literal('long_answer'), sampleAnswer: z.string().nullable() }),
  z.object({ type: z.literal('scenario'), optionId: z.string().nullable(), sampleAnswer: z.string().nullable() }),
  z.object({ type: z.literal('ordering'), order: z.array(z.string()) }),
  z.object({ type: z.literal('matching'), matches: z.record(z.string(), z.string()) }),
]);
export type CorrectAnswer = z.infer<typeof correctAnswerSchema>;

const choiceViewSchema = z.object({ id: z.string(), text: z.string() });

const learnerQuestionBase = {
  /** Attempt question id (stable for the life of the attempt). */
  id: z.uuid(),
  position: z.int(),
  prompt: z.string(),
  points: z.number(),
  response: answerResponseSchema.nullable(),
  savedAt: isoDateTime.nullable(),
};

/** A drawn question as the learner sees it: options in the snapshotted order, no answer key. */
export const learnerQuestionSchema = z.discriminatedUnion('type', [
  z.object({ ...learnerQuestionBase, type: z.literal('multiple_choice'), options: z.array(choiceViewSchema) }),
  z.object({ ...learnerQuestionBase, type: z.literal('multiple_select'), options: z.array(choiceViewSchema) }),
  z.object({ ...learnerQuestionBase, type: z.literal('true_false') }),
  z.object({ ...learnerQuestionBase, type: z.literal('short_answer'), maxLength: z.int() }),
  z.object({
    ...learnerQuestionBase,
    type: z.literal('long_answer'),
    minWords: z.int().nullable(),
    maxWords: z.int().nullable(),
  }),
  z.object({
    ...learnerQuestionBase,
    type: z.literal('scenario'),
    scenario: z.string(),
    subQuestion: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('multiple_choice'), prompt: z.string(), options: z.array(choiceViewSchema) }),
      z.object({ kind: z.literal('open_response'), prompt: z.string(), maxLength: z.int() }),
    ]),
  }),
  z.object({ ...learnerQuestionBase, type: z.literal('ordering'), items: z.array(choiceViewSchema) }),
  z.object({
    ...learnerQuestionBase,
    type: z.literal('matching'),
    prompts: z.array(choiceViewSchema),
    choices: z.array(choiceViewSchema),
  }),
]);
export type LearnerQuestion = z.infer<typeof learnerQuestionSchema>;

/** Option order snapshotted when the question was drawn for an attempt. */
export const optionOrderSchema = z.object({
  options: z.array(z.string()).optional(),
  items: z.array(z.string()).optional(),
  choices: z.array(z.string()).optional(),
});
export type OptionOrder = z.infer<typeof optionOrderSchema>;

export const QUESTION_OUTCOMES = ['correct', 'partial', 'incorrect', 'unanswered', 'pending_review'] as const;
export const questionOutcomeSchema = z.enum(QUESTION_OUTCOMES);
export type QuestionOutcome = z.infer<typeof questionOutcomeSchema>;

// ------------------------------------------------------------------ question banks

export const questionBankSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  archived: z.boolean(),
  questionCount: z.int(),
  activeQuestionCount: z.int(),
  categoryCount: z.int(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type QuestionBankSummary = z.infer<typeof questionBankSummarySchema>;

export const questionCategorySchema = z.object({
  id: z.uuid(),
  bankId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  position: z.int(),
  questionCount: z.int(),
});
export type QuestionCategory = z.infer<typeof questionCategorySchema>;

export const competencySchema = z.object({
  id: z.uuid(),
  bankId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  questionCount: z.int(),
});
export type Competency = z.infer<typeof competencySchema>;

export const questionBankDetailSchema = questionBankSummarySchema.extend({
  categories: z.array(questionCategorySchema),
  competencies: z.array(competencySchema),
  createdBy: personRefSchema.nullable(),
  updatedBy: personRefSchema.nullable(),
});
export type QuestionBankDetail = z.infer<typeof questionBankDetailSchema>;

export const questionBankPageSchema = pageSchema(questionBankSummarySchema);

export const listQuestionBanksQuerySchema = pageQuerySchema.extend({ includeArchived: queryBoolean });

export const createQuestionBankRequestSchema = z.object({
  title: nameString(160),
  description: optionalText(2000),
});
export type CreateQuestionBankRequest = z.input<typeof createQuestionBankRequestSchema>;

export const updateQuestionBankRequestSchema = createQuestionBankRequestSchema.partial();

export const createCategoryRequestSchema = z.object({
  name: nameString(120),
  description: optionalText(1000),
  position: z.int().min(0).max(10_000).optional(),
});
export const updateCategoryRequestSchema = createCategoryRequestSchema.partial();

export const createCompetencyRequestSchema = z.object({
  name: nameString(120),
  description: optionalText(1000),
});
export const updateCompetencyRequestSchema = createCompetencyRequestSchema.partial();

// ------------------------------------------------------------------ questions

export const listQuestionsQuerySchema = pageQuerySchema.extend({
  bankId: z.uuid().optional(),
  type: queryList(questionTypeSchema),
  categoryId: z.uuid().optional(),
  competencyId: z.uuid().optional(),
  difficulty: queryList(difficultySchema),
  /** Questions carrying every listed tag. */
  tags: queryList(tagSchema),
  status: z.enum(['active', 'archived', 'all']).default('active'),
});
export type ListQuestionsQuery = z.input<typeof listQuestionsQuerySchema>;

export const questionSummarySchema = z.object({
  id: z.uuid(),
  bank: z.object({ id: z.uuid(), title: z.string() }),
  status: questionStatusSchema,
  versionId: z.uuid(),
  version: z.int(),
  type: questionTypeSchema,
  prompt: z.string(),
  difficulty: difficultySchema,
  points: z.number(),
  category: refSchema.nullable(),
  tags: z.array(z.string()),
  competencyIds: z.array(z.uuid()),
  manualReview: z.boolean(),
  usedInAssessments: z.int(),
  updatedAt: isoDateTime,
});
export type QuestionSummary = z.infer<typeof questionSummarySchema>;
export const questionPageSchema = pageSchema(questionSummarySchema);

const versionOutputFields = {
  id: z.uuid(),
  questionId: z.uuid(),
  version: z.int(),
  prompt: z.string(),
  explanation: z.string().nullable(),
  points: z.number(),
  difficulty: difficultySchema,
  category: refSchema.nullable(),
  competencies: z.array(refSchema),
  tags: z.array(z.string()),
  changeNote: z.string().nullable(),
  createdAt: isoDateTime,
  createdBy: personRefSchema.nullable(),
};

function versionOutput<T extends QuestionType, C extends z.ZodType>(type: T, config: C) {
  return z.object({ ...versionOutputFields, type: z.literal(type), config });
}

/** A stored, immutable question version including its answer key (administrators only). */
export const questionVersionSchema = z.discriminatedUnion('type', [
  versionOutput('multiple_choice', multipleChoiceConfigSchema),
  versionOutput('multiple_select', multipleSelectConfigSchema),
  versionOutput('true_false', trueFalseConfigSchema),
  versionOutput('short_answer', shortAnswerConfigSchema),
  versionOutput('long_answer', longAnswerConfigSchema),
  versionOutput('scenario', scenarioConfigSchema),
  versionOutput('ordering', orderingConfigSchema),
  versionOutput('matching', matchingConfigSchema),
]);
export type QuestionVersion = z.infer<typeof questionVersionSchema>;

export const questionUsageSchema = z.object({
  assessmentId: z.uuid(),
  title: z.string(),
  status: assessmentStatusSchema,
  kind: assessmentKindSchema,
});

export const questionDetailSchema = z.object({
  id: z.uuid(),
  bank: z.object({ id: z.uuid(), title: z.string() }),
  status: questionStatusSchema,
  archivedAt: isoDateTime.nullable(),
  versionCount: z.int(),
  currentVersion: questionVersionSchema,
  /** Assessments that include this question as a fixed item. */
  usage: z.array(questionUsageSchema),
  /** Attempts that drew any version of this question. */
  attemptCount: z.int(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type QuestionDetail = z.infer<typeof questionDetailSchema>;

export const questionVersionListSchema = z.object({ items: z.array(questionVersionSchema) });

export const questionPreviewQuerySchema = z.object({ versionId: z.uuid().optional() });

export const questionPreviewSchema = z.object({
  versionId: z.uuid(),
  version: z.int(),
  /** Learner rendering with options in a sample shuffled order. */
  question: learnerQuestionSchema,
  correctAnswer: correctAnswerSchema,
  explanation: z.string().nullable(),
  manualReview: z.boolean(),
});
export type QuestionPreview = z.infer<typeof questionPreviewSchema>;

export const checkAnswerRequestSchema = z.object({
  response: answerResponseSchema,
  versionId: z.uuid().optional(),
});

export const checkAnswerResultSchema = z.object({
  outcome: questionOutcomeSchema,
  awardedPoints: z.number().nullable(),
  points: z.number(),
  correctAnswer: correctAnswerSchema,
  explanation: z.string().nullable(),
});

// ------------------------------------------------------------------ assessments

export const assessmentConfigSchema = z.object({
  passingPercent: z.number().min(0).max(100),
  /** null = unlimited attempts. */
  maxAttempts: z.int().min(1).max(100).nullable(),
  /** null = untimed. Enforced by the server. */
  timeLimitSeconds: z.int().min(60).max(8 * 3600).nullable(),
  randomizeQuestions: z.boolean(),
  randomizeOptions: z.boolean(),
  revealCorrectAnswers: revealPolicySchema,
  /** Show the score and per-question correctness to the learner. */
  revealScore: z.boolean(),
  /** Minutes a learner waits after an attempt before starting another (0 = no wait). */
  retryCooldownMinutes: z.int().min(0).max(60 * 24 * 30),
  /** Notify the learner's managers when an attempt ends with these outcomes. */
  notifyManagerOn: z.array(managerNotifyOutcomeSchema).transform((v) => [...new Set(v)]),
  /** Allow attempts outside a lesson (practice from the assessment library). */
  allowStandalone: z.boolean(),
});
export type AssessmentConfig = z.infer<typeof assessmentConfigSchema>;

export const DEFAULT_ASSESSMENT_CONFIG: AssessmentConfig = {
  passingPercent: 80,
  maxAttempts: 3,
  timeLimitSeconds: null,
  randomizeQuestions: false,
  randomizeOptions: true,
  revealCorrectAnswers: 'after_submit',
  revealScore: true,
  retryCooldownMinutes: 0,
  notifyManagerOn: ['failed'],
  allowStandalone: false,
};

const configWithDefaults = z.object({
  passingPercent: assessmentConfigSchema.shape.passingPercent.default(DEFAULT_ASSESSMENT_CONFIG.passingPercent),
  maxAttempts: assessmentConfigSchema.shape.maxAttempts.default(DEFAULT_ASSESSMENT_CONFIG.maxAttempts),
  timeLimitSeconds: assessmentConfigSchema.shape.timeLimitSeconds.default(DEFAULT_ASSESSMENT_CONFIG.timeLimitSeconds),
  randomizeQuestions: z.boolean().default(DEFAULT_ASSESSMENT_CONFIG.randomizeQuestions),
  randomizeOptions: z.boolean().default(DEFAULT_ASSESSMENT_CONFIG.randomizeOptions),
  revealCorrectAnswers: revealPolicySchema.default(DEFAULT_ASSESSMENT_CONFIG.revealCorrectAnswers),
  revealScore: z.boolean().default(DEFAULT_ASSESSMENT_CONFIG.revealScore),
  retryCooldownMinutes: assessmentConfigSchema.shape.retryCooldownMinutes.default(DEFAULT_ASSESSMENT_CONFIG.retryCooldownMinutes),
  notifyManagerOn: assessmentConfigSchema.shape.notifyManagerOn.default([...DEFAULT_ASSESSMENT_CONFIG.notifyManagerOn]),
  allowStandalone: z.boolean().default(DEFAULT_ASSESSMENT_CONFIG.allowStandalone),
});

/** Attempt configuration snapshot: the assessment's config plus identity at the time of the attempt. */
export const attemptConfigSnapshotSchema = assessmentConfigSchema.extend({
  title: z.string(),
  kind: assessmentKindSchema,
  assessmentRevision: z.int(),
});
export type AttemptConfigSnapshot = z.infer<typeof attemptConfigSnapshotSchema>;

const itemPoints = z
  .number()
  .positive()
  .max(100)
  .transform((v) => Math.round(v * 100) / 100)
  .nullable()
  .default(null);

const fixedItemShape = {
  kind: z.literal('question'),
  questionId: z.uuid(),
  /** Overrides the question version's points. */
  points: itemPoints,
};
const poolItemShape = {
  kind: z.literal('pool'),
  bankId: z.uuid(),
  categoryId: z.uuid().nullable().default(null),
  difficulty: difficultySchema.nullable().default(null),
  /** Drawn questions carry every listed tag. */
  tags: tagListSchema.default([]),
  count: z.int().min(1).max(200),
  /** Overrides the points of each drawn question. */
  points: itemPoints,
};

/** Fixed question or pool rule. */
export const assessmentItemInputSchema = z.discriminatedUnion('kind', [z.object(fixedItemShape), z.object(poolItemShape)]);
export type AssessmentItemInput = z.input<typeof assessmentItemInputSchema>;

/** Add one item; `position` inserts it (later items shift down), omitted appends it. */
export const addAssessmentItemRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...fixedItemShape, position: z.int().min(1).optional() }),
  z.object({ ...poolItemShape, position: z.int().min(1).optional() }),
]);
export type AddAssessmentItemRequest = z.input<typeof addAssessmentItemRequestSchema>;

/** Replace one item's definition and move it to `position`. */
export const updateAssessmentItemRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...fixedItemShape, position: z.int().min(1) }),
  z.object({ ...poolItemShape, position: z.int().min(1) }),
]);
export type UpdateAssessmentItemRequest = z.input<typeof updateAssessmentItemRequestSchema>;

/** Replace the whole item list. Positions must be 1..n; items with an `id` are kept and updated. */
export const replaceAssessmentItemsRequestSchema = z.object({
  items: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ ...fixedItemShape, id: z.uuid().optional(), position: z.int().min(1) }),
        z.object({ ...poolItemShape, id: z.uuid().optional(), position: z.int().min(1) }),
      ]),
    )
    .max(200),
});
export type ReplaceAssessmentItemsRequest = z.input<typeof replaceAssessmentItemsRequestSchema>;

export const assessmentItemSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.uuid(),
    position: z.int(),
    kind: z.literal('question'),
    points: z.number().nullable(),
    question: z.object({
      id: z.uuid(),
      status: questionStatusSchema,
      version: z.int(),
      type: questionTypeSchema,
      prompt: z.string(),
      difficulty: difficultySchema,
      points: z.number(),
      category: refSchema.nullable(),
    }),
  }),
  z.object({
    id: z.uuid(),
    position: z.int(),
    kind: z.literal('pool'),
    points: z.number().nullable(),
    bank: z.object({ id: z.uuid(), title: z.string() }),
    category: refSchema.nullable(),
    difficulty: difficultySchema.nullable(),
    tags: z.array(z.string()),
    count: z.int(),
    /** Active questions matching the rule (before excluding fixed items). */
    available: z.int(),
  }),
]);
export type AssessmentItem = z.infer<typeof assessmentItemSchema>;

export const assessmentSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  kind: assessmentKindSchema,
  status: assessmentStatusSchema,
  passingPercent: z.number(),
  itemCount: z.int(),
  questionCount: z.int(),
  attemptCount: z.int(),
  publishedAt: isoDateTime.nullable(),
  archivedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type AssessmentSummary = z.infer<typeof assessmentSummarySchema>;
export const assessmentPageSchema = pageSchema(assessmentSummarySchema);

export const assessmentDetailSchema = assessmentSummarySchema.extend({
  config: assessmentConfigSchema,
  revision: z.int(),
  items: z.array(assessmentItemSchema),
  createdBy: personRefSchema.nullable(),
  updatedBy: personRefSchema.nullable(),
});
export type AssessmentDetail = z.infer<typeof assessmentDetailSchema>;

export const listAssessmentsQuerySchema = pageQuerySchema.extend({
  status: queryList(assessmentStatusSchema),
  kind: queryList(assessmentKindSchema),
});
export type ListAssessmentsQuery = z.input<typeof listAssessmentsQuerySchema>;

export const createAssessmentRequestSchema = z.object({
  title: nameString(200),
  description: optionalText(5000),
  kind: assessmentKindSchema.default('quiz'),
  config: configWithDefaults.default(() => configWithDefaults.parse({})),
});
export type CreateAssessmentRequest = z.input<typeof createAssessmentRequestSchema>;

export const updateAssessmentRequestSchema = z
  .object({
    title: nameString(200),
    description: optionalText(5000),
    kind: assessmentKindSchema,
    config: assessmentConfigSchema.partial(),
  })
  .partial();
export type UpdateAssessmentRequest = z.input<typeof updateAssessmentRequestSchema>;

export const duplicateAssessmentRequestSchema = z.object({ title: nameString(200).optional() });

export const assessmentValidationIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  itemId: z.uuid().nullable(),
  position: z.int().nullable(),
});

export const assessmentValidationSchema = z.object({
  valid: z.boolean(),
  questionCount: z.int(),
  issues: z.array(assessmentValidationIssueSchema),
  pools: z.array(
    z.object({
      itemId: z.uuid(),
      position: z.int(),
      required: z.int(),
      /** Active questions matching the rule that are not already fixed items. */
      available: z.int(),
    }),
  ),
});
export type AssessmentValidation = z.infer<typeof assessmentValidationSchema>;

export const assessmentPreviewSchema = z.object({
  questionCount: z.int(),
  totalPoints: z.number(),
  questions: z.array(
    z.object({
      position: z.int(),
      itemId: z.uuid(),
      source: z.enum(['question', 'pool']),
      questionId: z.uuid(),
      questionVersionId: z.uuid(),
      version: z.int(),
      difficulty: difficultySchema,
      category: refSchema.nullable(),
      question: learnerQuestionSchema,
      correctAnswer: correctAnswerSchema,
      explanation: z.string().nullable(),
    }),
  ),
});
export type AssessmentPreview = z.infer<typeof assessmentPreviewSchema>;

export const assessmentStatsSchema = z.object({
  assessmentId: z.uuid(),
  attempts: z.object({
    total: z.int(),
    inProgress: z.int(),
    pendingReview: z.int(),
    graded: z.int(),
    autoSubmitted: z.int(),
  }),
  learners: z.int(),
  /** Share of graded attempts that passed (effective scores, including overrides), 0–100. */
  passRate: z.number().nullable(),
  firstAttemptPassRate: z.number().nullable(),
  averageScorePercent: z.number().nullable(),
  medianScorePercent: z.number().nullable(),
  averageDurationSeconds: z.number().nullable(),
  scoreDistribution: z.array(z.object({ from: z.number(), to: z.number(), count: z.int() })),
  /** Questions with the lowest correctness among graded attempts. */
  hardestQuestions: z.array(
    z.object({
      questionId: z.uuid(),
      prompt: z.string(),
      type: questionTypeSchema,
      difficulty: difficultySchema,
      category: refSchema.nullable(),
      answered: z.int(),
      correctRate: z.number(),
      averageScoreRatio: z.number(),
    }),
  ),
});
export type AssessmentStats = z.infer<typeof assessmentStatsSchema>;

// ------------------------------------------------------------------ learner: intro and attempts

const grantToken = z.string().trim().min(20).max(8192);

export const assessmentIntroQuerySchema = z.object({ grant: grantToken.optional() });

export const attemptContextSchema = z.object({
  programId: z.uuid().optional(),
  enrollmentId: z.uuid().optional(),
  lessonId: z.uuid().optional(),
});
export type AttemptContext = z.infer<typeof attemptContextSchema>;

export const learnerAttemptSummarySchema = z.object({
  id: z.uuid(),
  assessmentId: z.uuid(),
  title: z.string(),
  kind: assessmentKindSchema,
  attemptNumber: z.int(),
  status: attemptStatusSchema,
  startedAt: isoDateTime,
  submittedAt: isoDateTime.nullable(),
  gradedAt: isoDateTime.nullable(),
  autoSubmitted: z.boolean(),
  /** Hidden (null) when the assessment does not reveal scores. */
  scorePercent: z.number().nullable(),
  passed: z.boolean().nullable(),
});
export type LearnerAttemptSummary = z.infer<typeof learnerAttemptSummarySchema>;

export const assessmentIntroSchema = z.object({
  assessment: z.object({
    id: z.uuid(),
    title: z.string(),
    description: z.string().nullable(),
    kind: assessmentKindSchema,
    questionCount: z.int(),
    passingPercent: z.number(),
    timeLimitSeconds: z.int().nullable(),
    maxAttempts: z.int().nullable(),
    revealScore: z.boolean(),
    revealCorrectAnswers: revealPolicySchema,
  }),
  attemptsUsed: z.int(),
  /** null = unlimited. */
  attemptsRemaining: z.int().nullable(),
  inProgressAttempt: z
    .object({ id: z.uuid(), attemptNumber: z.int(), startedAt: isoDateTime, expiresAt: isoDateTime.nullable() })
    .nullable(),
  cooldownUntil: isoDateTime.nullable(),
  bestScorePercent: z.number().nullable(),
  passed: z.boolean(),
  canStart: z.boolean(),
  blockedReason: z.object({ code: z.string(), message: z.string() }).nullable(),
  attempts: z.array(learnerAttemptSummarySchema),
});
export type AssessmentIntro = z.infer<typeof assessmentIntroSchema>;

/** Start (or resume) an attempt from a lesson grant, or directly when the assessment allows it. */
export const startAttemptRequestSchema = z
  .object({ grant: grantToken.optional(), assessmentId: z.uuid().optional() })
  .refine((v) => (v.grant === undefined) !== (v.assessmentId === undefined), {
    message: 'Provide either the lesson grant or the assessment id',
  });
export type StartAttemptRequest = z.input<typeof startAttemptRequestSchema>;

export const learnerAttemptSchema = z.object({
  id: z.uuid(),
  assessmentId: z.uuid(),
  title: z.string(),
  kind: assessmentKindSchema,
  attemptNumber: z.int(),
  status: attemptStatusSchema,
  startedAt: isoDateTime,
  expiresAt: isoDateTime.nullable(),
  timeLimitSeconds: z.int().nullable(),
  /** Seconds left on the server clock; null when untimed or closed. */
  timeRemainingSeconds: z.int().nullable(),
  submittedAt: isoDateTime.nullable(),
  autoSubmitted: z.boolean(),
  passingPercent: z.number(),
  questionCount: z.int(),
  answeredCount: z.int(),
  questions: z.array(learnerQuestionSchema),
  /** True when an existing in-progress attempt was returned instead of starting a new one. */
  resumed: z.boolean(),
  context: attemptContextSchema,
});
export type LearnerAttempt = z.infer<typeof learnerAttemptSchema>;

export const saveAnswerRequestSchema = z.object({
  /** null clears the answer. */
  response: answerResponseSchema.nullable(),
  /** Monotonic counter from the client; stale autosaves (lower sequence) are ignored. */
  clientSequence: z.int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type SaveAnswerRequest = z.input<typeof saveAnswerRequestSchema>;

export const saveAnswerResultSchema = z.object({
  attemptQuestionId: z.uuid(),
  answered: z.boolean(),
  savedAt: isoDateTime.nullable(),
  /** false when a newer autosave was already stored. */
  applied: z.boolean(),
  answeredCount: z.int(),
  timeRemainingSeconds: z.int().nullable(),
});

export const resultQuestionSchema = z.object({
  attemptQuestionId: z.uuid(),
  position: z.int(),
  type: questionTypeSchema,
  prompt: z.string(),
  points: z.number(),
  response: answerResponseSchema.nullable(),
  /** null when the assessment hides scores. */
  outcome: questionOutcomeSchema.nullable(),
  awardedPoints: z.number().nullable(),
  /** Reviewer feedback on open answers. */
  feedback: z.string().nullable(),
  /** Present only when the reveal policy allows it. */
  correctAnswer: correctAnswerSchema.nullable(),
  explanation: z.string().nullable(),
});

export const attemptResultSchema = z.object({
  attemptId: z.uuid(),
  assessmentId: z.uuid(),
  title: z.string(),
  kind: assessmentKindSchema,
  attemptNumber: z.int(),
  status: attemptStatusSchema,
  submittedAt: isoDateTime.nullable(),
  gradedAt: isoDateTime.nullable(),
  autoSubmitted: z.boolean(),
  scoreVisible: z.boolean(),
  scorePercent: z.number().nullable(),
  scorePoints: z.number().nullable(),
  maxPoints: z.number().nullable(),
  passed: z.boolean().nullable(),
  passingPercent: z.number(),
  /** The effective score comes from a recorded override. */
  overridden: z.boolean(),
  answersRevealed: z.boolean(),
  attemptsUsed: z.int(),
  attemptsRemaining: z.int().nullable(),
  retakeAvailableAt: isoDateTime.nullable(),
  message: z.string(),
  questions: z.array(resultQuestionSchema),
});
export type AttemptResult = z.infer<typeof attemptResultSchema>;

export const myAttemptsQuerySchema = z.object({ assessmentId: z.uuid().optional() });
export const myAttemptsSchema = z.object({ items: z.array(learnerAttemptSummarySchema) });

// ------------------------------------------------------------------ review

export const listAttemptsQuerySchema = pageQuerySchema.extend({
  assessmentId: z.uuid().optional(),
  userId: z.uuid().optional(),
  status: queryList(attemptStatusSchema),
  /** Only attempts with open answers waiting for a reviewer. */
  pendingReview: queryBoolean,
  submittedFrom: isoDateTime.optional(),
  submittedTo: isoDateTime.optional(),
});
export type ListAttemptsQuery = z.input<typeof listAttemptsQuerySchema>;

export const reviewAttemptSummarySchema = z.object({
  id: z.uuid(),
  assessment: z.object({ id: z.uuid(), title: z.string(), kind: assessmentKindSchema }),
  learner: personRefSchema,
  attemptNumber: z.int(),
  status: attemptStatusSchema,
  startedAt: isoDateTime,
  submittedAt: isoDateTime.nullable(),
  gradedAt: isoDateTime.nullable(),
  autoSubmitted: z.boolean(),
  /** Effective score: the latest override, otherwise the graded score. */
  scorePercent: z.number().nullable(),
  passed: z.boolean().nullable(),
  overridden: z.boolean(),
  pendingReviewCount: z.int(),
  context: attemptContextSchema,
});
export type ReviewAttemptSummary = z.infer<typeof reviewAttemptSummarySchema>;
export const reviewAttemptPageSchema = pageSchema(reviewAttemptSummarySchema);

export const scoreOverrideSchema = z.object({
  id: z.uuid(),
  previousScorePercent: z.number(),
  previousPassed: z.boolean(),
  newScorePercent: z.number(),
  newPassed: z.boolean(),
  reason: z.string(),
  actor: personRefSchema,
  createdAt: isoDateTime,
});
export type ScoreOverride = z.infer<typeof scoreOverrideSchema>;

export const reviewQuestionSchema = z.object({
  attemptQuestionId: z.uuid(),
  position: z.int(),
  questionId: z.uuid(),
  questionVersionId: z.uuid(),
  version: z.int(),
  points: z.number(),
  difficulty: difficultySchema,
  category: refSchema.nullable(),
  prompt: z.string(),
  explanation: z.string().nullable(),
  definition: questionDefinitionSchema,
  optionOrder: optionOrderSchema,
  response: answerResponseSchema.nullable(),
  savedAt: isoDateTime.nullable(),
  outcome: questionOutcomeSchema,
  needsReview: z.boolean(),
  isCorrect: z.boolean().nullable(),
  awardedPoints: z.number().nullable(),
  feedback: z.string().nullable(),
  gradedBy: personRefSchema.nullable(),
  gradedAt: isoDateTime.nullable(),
});
export type ReviewQuestion = z.infer<typeof reviewQuestionSchema>;

export const reviewAttemptDetailSchema = reviewAttemptSummarySchema.extend({
  config: attemptConfigSnapshotSchema,
  expiresAt: isoDateTime.nullable(),
  maxPoints: z.number(),
  /** Original grading, never changed by overrides. */
  gradedScorePoints: z.number().nullable(),
  gradedScorePercent: z.number().nullable(),
  gradedPassed: z.boolean().nullable(),
  questions: z.array(reviewQuestionSchema),
  overrides: z.array(scoreOverrideSchema),
});
export type ReviewAttemptDetail = z.infer<typeof reviewAttemptDetailSchema>;

export const gradeAnswersRequestSchema = z.object({
  grades: z
    .array(
      z.object({
        attemptQuestionId: z.uuid(),
        awardedPoints: z.number().min(0).max(100),
        feedback: optionalText(5000),
      }),
    )
    .min(1, 'Grade at least one answer')
    .max(200),
});
export type GradeAnswersRequest = z.input<typeof gradeAnswersRequestSchema>;

export const overrideScoreRequestSchema = z.object({
  scorePercent: z.number().min(0).max(100),
  /** Defaults to comparing the new score with the attempt's passing percentage. */
  passed: z.boolean().optional(),
  reason: z.string().trim().min(10, 'Explain the override in at least 10 characters').max(2000),
});
export type OverrideScoreRequest = z.input<typeof overrideScoreRequestSchema>;
