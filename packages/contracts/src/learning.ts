// API contracts for the learning domain. Shared by the service and the web app.
import { z } from 'zod';
import { ruleSchema } from '@a5/rules';
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

export const PROGRAM_STATUSES = ['draft', 'published', 'archived'] as const;
export const programStatusSchema = z.enum(PROGRAM_STATUSES);
export type ProgramStatus = z.infer<typeof programStatusSchema>;

/** Status of a phase, module or lesson in the working copy. `draft` = never published. */
export const nodeStatusSchema = z.enum(PROGRAM_STATUSES);
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

export const LESSON_TYPES = [
  'video',
  'article',
  'pdf',
  'document',
  'external',
  'quiz',
  'final_assessment',
  'assignment',
  'ai_simulation',
  'scenario',
  'manager_approval',
  'acknowledgment',
] as const;
export const lessonTypeSchema = z.enum(LESSON_TYPES);
export type LessonType = z.infer<typeof lessonTypeSchema>;

/** Learner-facing state of a node in the outline. */
export const NODE_STATES = ['locked', 'available', 'in_progress', 'completed'] as const;
export const nodeStateSchema = z.enum(NODE_STATES);
export type NodeState = z.infer<typeof nodeStateSchema>;

export const ENROLLMENT_STATUSES = ['active', 'completed', 'withdrawn'] as const;
export const enrollmentStatusSchema = z.enum(ENROLLMENT_STATUSES);
export type EnrollmentStatus = z.infer<typeof enrollmentStatusSchema>;

export const ENROLLMENT_SOURCES = ['manual', 'rule', 'self'] as const;
export const enrollmentSourceSchema = z.enum(ENROLLMENT_SOURCES);
export type EnrollmentSource = z.infer<typeof enrollmentSourceSchema>;

export const LESSON_PROGRESS_STATUSES = ['not_started', 'in_progress', 'completed'] as const;
export const lessonProgressStatusSchema = z.enum(LESSON_PROGRESS_STATUSES);
export type LessonProgressStatus = z.infer<typeof lessonProgressStatusSchema>;

/** What completed a lesson. */
export const COMPLETION_SOURCES = [
  'learner',
  'video',
  'assessment',
  'ai_score',
  'approval',
  'acknowledgment',
  'manager_override',
] as const;
export const completionSourceSchema = z.enum(COMPLETION_SOURCES);
export type CompletionSource = z.infer<typeof completionSourceSchema>;

/** How a lesson type completes (lesson type registry). */
export const COMPLETION_MODES = [
  'manual',
  'video',
  'assessment',
  'ai_score',
  'approval',
  'submission',
  'acknowledgment',
] as const;
export const completionModeSchema = z.enum(COMPLETION_MODES);
export type CompletionMode = z.infer<typeof completionModeSchema>;

export const APPROVAL_KINDS = ['manager_approval', 'assignment_review'] as const;
export const approvalKindSchema = z.enum(APPROVAL_KINDS);
export type ApprovalKind = z.infer<typeof approvalKindSchema>;

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const AUDIENCE_KINDS = ['role', 'team', 'department', 'location'] as const;
export const audienceKindSchema = z.enum(AUDIENCE_KINDS);
export type AudienceKind = z.infer<typeof audienceKindSchema>;

// ------------------------------------------------------------------ program settings

const navigationModeSchema = z.enum(['sequential', 'free']);

/**
 * Program behaviour. Every policy here is editable data:
 * - navigationMode: `sequential` adds implicit "previous required lesson / previous phase complete"
 *   rules; `free` only applies explicit unlock rules.
 * - allowSkipAhead: in sequential mode, lessons inside an unlocked phase may be taken in any order.
 * - defaultMinWatchPercent: credited watch percentage that completes a video lesson unless the
 *   lesson sets its own minimum.
 * - defaultDueDays: due date offset applied when someone is enrolled without an explicit due date.
 * - inactivityAlertDays: managers see an attention flag after this many days without activity.
 * - allowSelfEnrollment / autoEnrollAudience: who may join without being assigned.
 */
export const programSettingsSchema = z.object({
  navigationMode: navigationModeSchema.default('sequential'),
  allowSkipAhead: z.boolean().default(false),
  defaultMinWatchPercent: z.int().min(0).max(100).default(90),
  defaultDueDays: z.int().min(1).max(730).nullable().default(null),
  inactivityAlertDays: z.int().min(1).max(90).default(7),
  allowSelfEnrollment: z.boolean().default(false),
  autoEnrollAudience: z.boolean().default(false),
});
export type ProgramSettings = z.output<typeof programSettingsSchema>;

/** Partial settings for updates (no defaults, so omitted keys keep their current value). */
export const programSettingsPatchSchema = z
  .object({
    navigationMode: navigationModeSchema,
    allowSkipAhead: z.boolean(),
    defaultMinWatchPercent: z.int().min(0).max(100),
    defaultDueDays: z.int().min(1).max(730).nullable(),
    inactivityAlertDays: z.int().min(1).max(90),
    allowSelfEnrollment: z.boolean(),
    autoEnrollAudience: z.boolean(),
  })
  .partial();
export type ProgramSettingsPatch = z.infer<typeof programSettingsPatchSchema>;

// ------------------------------------------------------------------ lesson configuration (per type)

const mediaAssetIdSchema = z.uuid('Choose a file from the media library');
const longText = (max: number) => z.string().trim().min(1, 'Required').max(max);

export const videoLessonConfigSchema = z.object({
  mediaAssetId: mediaAssetIdSchema,
  /** Null uses the program's default minimum watch percentage. */
  minWatchPercent: z.int().min(0).max(100).nullable().default(null),
  /** Lets the viewer seek ahead; sent to media-service in the grant policy as `allowSeekAhead`. */
  allowSkipping: z.boolean().default(false),
  /** Playback above this rate earns no additional watch credit. */
  maxCreditedPlaybackRate: z.number().min(1).max(4).default(2),
  /** `auto` completes when the minimum is reached; `manual` lets the learner confirm once it is. */
  completion: z.enum(['auto', 'manual']).default('auto'),
});
export type VideoLessonConfig = z.output<typeof videoLessonConfigSchema>;

/** Articles keep their markdown in the lesson body. */
export const articleLessonConfigSchema = z.object({});
export type ArticleLessonConfig = z.output<typeof articleLessonConfigSchema>;

/** PDF and document lessons complete manually after the learner opened the file. */
export const documentLessonConfigSchema = z.object({
  mediaAssetId: mediaAssetIdSchema,
  allowDownload: z.boolean().default(true),
});
export type DocumentLessonConfig = z.output<typeof documentLessonConfigSchema>;

export const externalLessonConfigSchema = z.object({
  url: z.url({ protocol: /^https?$/, error: 'Enter a full http(s) address' }).max(2000),
  linkLabel: z.string().trim().max(120).nullable().default(null),
  openInNewTab: z.boolean().default(true),
});
export type ExternalLessonConfig = z.output<typeof externalLessonConfigSchema>;

/** Quiz and final assessment lessons complete when the linked assessment is passed. */
export const assessmentLessonConfigSchema = z.object({
  assessmentId: z.uuid('Choose an assessment'),
});
export type AssessmentLessonConfig = z.output<typeof assessmentLessonConfigSchema>;

export const assignmentLessonConfigSchema = z.object({
  /** Markdown shown to the learner. */
  instructions: longText(20_000),
  minWords: z.int().min(0).max(5_000).default(0),
});
export type AssignmentLessonConfig = z.output<typeof assignmentLessonConfigSchema>;

/** AI role-play lessons complete when a scored session reaches `minScore`. */
export const aiSimulationLessonConfigSchema = z.object({
  scenarioId: z.uuid('Choose an AI scenario'),
  minScore: z.number().min(0).max(100),
});
export type AiSimulationLessonConfig = z.output<typeof aiSimulationLessonConfigSchema>;

export const managerApprovalLessonConfigSchema = z.object({
  /** Markdown describing what the manager confirms. */
  instructions: longText(5_000),
});
export type ManagerApprovalLessonConfig = z.output<typeof managerApprovalLessonConfigSchema>;

export const acknowledgmentLessonConfigSchema = z.object({
  /** Markdown statement; the learner acknowledges by typing their full name. */
  statement: longText(20_000),
});
export type AcknowledgmentLessonConfig = z.output<typeof acknowledgmentLessonConfigSchema>;

/** Config schema per lesson type. The web editor and the service validate with the same schemas. */
export const lessonConfigSchemas = {
  video: videoLessonConfigSchema,
  article: articleLessonConfigSchema,
  pdf: documentLessonConfigSchema,
  document: documentLessonConfigSchema,
  external: externalLessonConfigSchema,
  quiz: assessmentLessonConfigSchema,
  final_assessment: assessmentLessonConfigSchema,
  assignment: assignmentLessonConfigSchema,
  ai_simulation: aiSimulationLessonConfigSchema,
  scenario: aiSimulationLessonConfigSchema,
  manager_approval: managerApprovalLessonConfigSchema,
  acknowledgment: acknowledgmentLessonConfigSchema,
} as const satisfies Record<LessonType, z.ZodType>;

export type LessonConfigFor<T extends LessonType> = z.output<(typeof lessonConfigSchemas)[T]>;

export const lessonConfigRecordSchema = z.record(z.string(), z.unknown());

// ------------------------------------------------------------------ shared response pieces

const refSchema = z.object({ id: z.uuid(), name: z.string() });
const titledRefSchema = z.object({ id: z.uuid(), title: z.string() });

export const requirementProgressSchema = z.object({
  current: z.number(),
  target: z.number(),
  unit: z.enum(['percent', 'count', 'days', 'boolean']),
});

/** One unlock requirement in plain language, with progress numbers when measurable. */
export const requirementSchema = z.object({
  description: z.string(),
  satisfied: z.boolean(),
  progress: requirementProgressSchema.nullable(),
});
export type Requirement = z.infer<typeof requirementSchema>;

const phaseRefSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  label: z.string(),
  position: z.int(),
});

// ------------------------------------------------------------------ admin: programs

export const listProgramsQuerySchema = pageQuerySchema.extend({
  status: queryList(programStatusSchema),
  category: z.string().trim().max(80).optional(),
});
export type ListProgramsQuery = z.input<typeof listProgramsQuerySchema>;

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Use at least 3 characters')
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens');

const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(20);

const programFields = {
  title: nameString(160),
  slug: slugSchema,
  summary: optionalText(1_000),
  description: optionalText(20_000),
  category: optionalText(80),
  coverMediaAssetId: z.uuid().nullable(),
  ownerUserId: z.uuid().nullable(),
  phaseLabel: nameString(30),
  estimatedMinutes: z.int().min(0).max(100_000).nullable(),
  durationDays: z.int().min(1).max(730).nullable(),
  availabilityStartsAt: isoDateTime.nullable(),
  availabilityEndsAt: isoDateTime.nullable(),
  tags: tagsSchema,
};

const availabilityRefinement = (v: {
  availabilityStartsAt?: string | null;
  availabilityEndsAt?: string | null;
}) =>
  !v.availabilityStartsAt ||
  !v.availabilityEndsAt ||
  new Date(v.availabilityEndsAt) > new Date(v.availabilityStartsAt);

export const createProgramRequestSchema = z
  .object({
    title: programFields.title,
    slug: programFields.slug.optional(),
    summary: programFields.summary,
    description: programFields.description,
    category: programFields.category,
    coverMediaAssetId: programFields.coverMediaAssetId.optional(),
    ownerUserId: programFields.ownerUserId.optional(),
    phaseLabel: programFields.phaseLabel.default('Week'),
    estimatedMinutes: programFields.estimatedMinutes.optional(),
    durationDays: programFields.durationDays.optional(),
    availabilityStartsAt: programFields.availabilityStartsAt.optional(),
    availabilityEndsAt: programFields.availabilityEndsAt.optional(),
    tags: programFields.tags.default([]),
    settings: programSettingsPatchSchema.default({}),
  })
  .refine(availabilityRefinement, {
    path: ['availabilityEndsAt'],
    message: 'End must be after the start',
  });
export type CreateProgramRequest = z.input<typeof createProgramRequestSchema>;

export const updateProgramRequestSchema = z
  .object({ ...programFields, settings: programSettingsPatchSchema })
  .partial()
  .refine(availabilityRefinement, {
    path: ['availabilityEndsAt'],
    message: 'End must be after the start',
  });
export type UpdateProgramRequest = z.input<typeof updateProgramRequestSchema>;

export const duplicateProgramRequestSchema = z.object({
  title: nameString(160).optional(),
  slug: slugSchema.optional(),
});

export const publishProgramRequestSchema = z.object({
  changeNote: z.string().trim().min(3, 'Describe what changed for learners').max(2_000),
});

export const audienceSchema = z.object({
  kind: audienceKindSchema,
  /** Team, department or location id; role key for `role`. */
  ref: z.string().trim().min(1).max(80),
});
export type Audience = z.infer<typeof audienceSchema>;

export const setAudiencesRequestSchema = z.object({ audiences: z.array(audienceSchema).max(100) });
export const setPrerequisitesRequestSchema = z.object({ programIds: z.array(z.uuid()).max(20) });

export const programSummarySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  category: z.string().nullable(),
  status: programStatusSchema,
  coverMediaAssetId: z.uuid().nullable(),
  phaseLabel: z.string(),
  tags: z.array(z.string()),
  owner: personRefSchema.nullable(),
  publishedVersion: z.int(),
  publishedAt: isoDateTime.nullable(),
  hasUnpublishedChanges: z.boolean(),
  archivedAt: isoDateTime.nullable(),
  counts: z.object({
    phases: z.int(),
    lessons: z.int(),
    activeEnrollments: z.int(),
    completedEnrollments: z.int(),
  }),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type ProgramSummary = z.infer<typeof programSummarySchema>;
export const programPageSchema = pageSchema(programSummarySchema);

export const lessonResourceSchema = z.object({
  id: z.uuid(),
  position: z.int(),
  title: z.string(),
  description: z.string().nullable(),
  kind: z.enum(['link', 'media']),
  url: z.string().nullable(),
  mediaAssetId: z.uuid().nullable(),
});
export type LessonResource = z.infer<typeof lessonResourceSchema>;

export const adminLessonSchema = z.object({
  id: z.uuid(),
  programId: z.uuid(),
  phaseId: z.uuid(),
  moduleId: z.uuid(),
  position: z.int(),
  type: lessonTypeSchema,
  title: z.string(),
  summary: z.string().nullable(),
  body: z.string().nullable(),
  config: lessonConfigRecordSchema,
  isRequired: z.boolean(),
  estimatedMinutes: z.int(),
  unlockRule: ruleSchema.nullable(),
  status: nodeStatusSchema,
  hasUnpublishedChanges: z.boolean(),
  firstPublishedAt: isoDateTime.nullable(),
  completionMode: completionModeSchema,
  resources: z.array(lessonResourceSchema),
  activity: z.object({ learnersStarted: z.int(), learnersCompleted: z.int() }),
  updatedAt: isoDateTime,
});
export type AdminLesson = z.infer<typeof adminLessonSchema>;

export const adminModuleSchema = z.object({
  id: z.uuid(),
  phaseId: z.uuid(),
  position: z.int(),
  title: z.string(),
  summary: z.string().nullable(),
  unlockRule: ruleSchema.nullable(),
  status: nodeStatusSchema,
  hasUnpublishedChanges: z.boolean(),
  lessons: z.array(adminLessonSchema),
});
export type AdminModule = z.infer<typeof adminModuleSchema>;

export const adminPhaseSchema = z.object({
  id: z.uuid(),
  position: z.int(),
  label: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  unlockRule: ruleSchema.nullable(),
  status: nodeStatusSchema,
  hasUnpublishedChanges: z.boolean(),
  modules: z.array(adminModuleSchema),
});
export type AdminPhase = z.infer<typeof adminPhaseSchema>;

export const publishIssueSchema = z.object({
  nodeType: z.enum(['program', 'phase', 'module', 'lesson']),
  nodeId: z.uuid(),
  message: z.string(),
});
export type PublishIssue = z.infer<typeof publishIssueSchema>;

export const programDetailSchema = programSummarySchema.extend({
  description: z.string().nullable(),
  settings: programSettingsSchema,
  estimatedMinutes: z.int().nullable(),
  computedMinutes: z.int(),
  durationDays: z.int().nullable(),
  availabilityStartsAt: isoDateTime.nullable(),
  availabilityEndsAt: isoDateTime.nullable(),
  audiences: z.array(audienceSchema.extend({ name: z.string() })),
  prerequisites: z.array(titledRefSchema),
  phases: z.array(adminPhaseSchema),
  publishIssues: z.array(publishIssueSchema),
});
export type ProgramDetail = z.infer<typeof programDetailSchema>;

export const programVersionSchema = z.object({
  version: z.int(),
  changeNote: z.string(),
  publishedAt: isoDateTime,
  publishedBy: personRefSchema.nullable(),
  stats: z.object({
    phases: z.int(),
    modules: z.int(),
    lessons: z.int(),
    requiredLessons: z.int(),
    estimatedMinutes: z.int(),
  }),
});
export type ProgramVersion = z.infer<typeof programVersionSchema>;

export const programVersionDetailSchema = programVersionSchema.extend({
  snapshot: z.record(z.string(), z.unknown()),
});

export const publishResultSchema = z.object({
  version: programVersionSchema,
  program: programDetailSchema,
});

export const deleteResultSchema = z.object({
  outcome: z.enum(['deleted', 'archived']),
  message: z.string(),
});
export type DeleteResult = z.infer<typeof deleteResultSchema>;

// ------------------------------------------------------------------ admin: structure

const unlockRuleInput = ruleSchema.nullable();
const positionSchema = z.int().min(1).max(10_000);

export const createPhaseRequestSchema = z.object({
  title: nameString(160),
  summary: optionalText(1_000),
  unlockRule: unlockRuleInput.optional(),
  position: positionSchema.optional(),
});
export const updatePhaseRequestSchema = z
  .object({ title: nameString(160), summary: optionalText(1_000), unlockRule: unlockRuleInput })
  .partial();

export const createModuleRequestSchema = z.object({
  phaseId: z.uuid(),
  title: nameString(160),
  summary: optionalText(1_000),
  unlockRule: unlockRuleInput.optional(),
  position: positionSchema.optional(),
});
export const updateModuleRequestSchema = z
  .object({ title: nameString(160), summary: optionalText(1_000), unlockRule: unlockRuleInput })
  .partial();

/** Explicit position moves (1-based); siblings are renumbered. */
export const movePhaseRequestSchema = z.object({ position: positionSchema });
export const moveModuleRequestSchema = z.object({
  phaseId: z.uuid().optional(),
  position: positionSchema,
});
export const moveLessonRequestSchema = z.object({
  moduleId: z.uuid().optional(),
  position: positionSchema,
});

/**
 * Validate a lesson config against its type. Issues are reported under `config.*` so forms can
 * attach them to the right field.
 */
export function parseLessonConfig(
  type: LessonType,
  config: unknown,
):
  | { success: true; data: Record<string, unknown> }
  | { success: false; issues: Array<{ path: string; message: string }> } {
  const result = lessonConfigSchemas[type].safeParse(config ?? {});
  if (result.success) return { success: true, data: result.data as Record<string, unknown> };
  return {
    success: false,
    issues: result.error.issues.map((i) => ({
      path: ['config', ...i.path.map(String)].join('.'),
      message: i.message,
    })),
  };
}

const lessonContentFields = {
  title: nameString(200),
  summary: optionalText(1_000),
  /** Markdown body: the article itself, or companion notes for other types. */
  body: optionalText(100_000),
  isRequired: z.boolean(),
  estimatedMinutes: z.int().min(0).max(600),
  unlockRule: unlockRuleInput,
};

export const createLessonRequestSchema = z
  .object({
    moduleId: z.uuid(),
    type: lessonTypeSchema,
    config: lessonConfigRecordSchema.default({}),
    position: positionSchema.optional(),
    title: lessonContentFields.title,
    summary: lessonContentFields.summary,
    body: lessonContentFields.body,
    isRequired: lessonContentFields.isRequired.default(true),
    estimatedMinutes: lessonContentFields.estimatedMinutes.default(0),
    unlockRule: lessonContentFields.unlockRule.optional(),
  })
  .superRefine((value, ctx) => {
    const parsed = parseLessonConfig(value.type, value.config);
    if (!parsed.success) {
      for (const issue of parsed.issues)
        ctx.addIssue({ code: 'custom', path: issue.path.split('.'), message: issue.message });
    }
  })
  .transform((value) => {
    const parsed = parseLessonConfig(value.type, value.config);
    return { ...value, config: parsed.success ? parsed.data : value.config };
  });
export type CreateLessonRequest = z.input<typeof createLessonRequestSchema>;

/** The lesson type cannot change; the config is validated against the existing type. */
export const updateLessonRequestSchema = z
  .object({ ...lessonContentFields, config: lessonConfigRecordSchema })
  .partial();
export type UpdateLessonRequest = z.input<typeof updateLessonRequestSchema>;

export const lessonResourceRequestSchema = z
  .object({
    title: nameString(160),
    description: optionalText(1_000),
    kind: z.enum(['link', 'media']),
    url: z
      .url({ protocol: /^https?$/, error: 'Enter a full http(s) address' })
      .max(2000)
      .nullable()
      .optional(),
    mediaAssetId: z.uuid().nullable().optional(),
    position: positionSchema.optional(),
  })
  .refine((v) => (v.kind === 'link' ? Boolean(v.url) : Boolean(v.mediaAssetId)), {
    path: ['url'],
    message: 'Links need an address and media resources need a file',
  });
export const updateLessonResourceRequestSchema = z
  .object({
    title: nameString(160),
    description: optionalText(1_000),
    url: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .nullable(),
    mediaAssetId: z.uuid().nullable(),
    position: positionSchema,
  })
  .partial();

export const lessonResourceListSchema = z.object({ items: z.array(lessonResourceSchema) });

// ------------------------------------------------------------------ outline (learner + preview)

const progressNumbers = {
  percent: z.number(),
  requiredTotal: z.int(),
  requiredCompleted: z.int(),
};

export const outlineLessonSchema = z.object({
  id: z.uuid(),
  type: lessonTypeSchema,
  title: z.string(),
  summary: z.string().nullable(),
  position: z.int(),
  isRequired: z.boolean(),
  estimatedMinutes: z.int(),
  state: nodeStateSchema,
  percent: z.number(),
  completedAt: isoDateTime.nullable(),
  requirements: z.array(requirementSchema),
});
export type OutlineLesson = z.infer<typeof outlineLessonSchema>;

export const outlineModuleSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  summary: z.string().nullable(),
  position: z.int(),
  state: nodeStateSchema,
  ...progressNumbers,
  requirements: z.array(requirementSchema),
  lessons: z.array(outlineLessonSchema),
});
export type OutlineModule = z.infer<typeof outlineModuleSchema>;

export const outlinePhaseSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  summary: z.string().nullable(),
  position: z.int(),
  label: z.string(),
  state: nodeStateSchema,
  ...progressNumbers,
  completedAt: isoDateTime.nullable(),
  requirements: z.array(requirementSchema),
  modules: z.array(outlineModuleSchema),
});
export type OutlinePhase = z.infer<typeof outlinePhaseSchema>;

export const enrollmentProgressSchema = z.object({
  id: z.uuid(),
  status: enrollmentStatusSchema,
  source: enrollmentSourceSchema,
  enrolledAt: isoDateTime,
  dueAt: isoDateTime.nullable(),
  overdue: z.boolean(),
  startedAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
  lastActivityAt: isoDateTime.nullable(),
  progressPercent: z.number(),
  requiredTotal: z.int(),
  requiredCompleted: z.int(),
  currentLessonId: z.uuid().nullable(),
  currentPhaseId: z.uuid().nullable(),
});
export type EnrollmentProgress = z.infer<typeof enrollmentProgressSchema>;

export const outlineSchema = z.object({
  program: z.object({
    id: z.uuid(),
    title: z.string(),
    summary: z.string().nullable(),
    phaseLabel: z.string(),
    navigationMode: navigationModeSchema,
    version: z.int(),
    coverMediaAssetId: z.uuid().nullable(),
  }),
  /** Null in previews. */
  enrollment: enrollmentProgressSchema.nullable(),
  /** Program-level state: locked while prerequisites or the availability window are not met. */
  state: nodeStateSchema,
  requirements: z.array(requirementSchema),
  ...progressNumbers,
  estimatedRemainingMinutes: z.int(),
  nextLessonId: z.uuid().nullable(),
  phases: z.array(outlinePhaseSchema),
});
export type Outline = z.infer<typeof outlineSchema>;

export const previewQuerySchema = z.object({
  source: z.enum(['draft', 'published']).default('draft'),
});

// ------------------------------------------------------------------ enrollments (admin / manager)

export const enrollRequestSchema = z.object({
  programId: z.uuid(),
  userIds: z.array(z.uuid()).min(1, 'Choose at least one person').max(500),
  /** Explicit due date; defaults to the program's due-date offset when omitted. */
  dueAt: isoDateTime.nullable().optional(),
});
export type EnrollRequest = z.input<typeof enrollRequestSchema>;

export const bulkEnrollResultSchema = z.object({
  created: z.int(),
  reactivated: z.int(),
  unchanged: z.int(),
  items: z.array(
    z.object({
      userId: z.uuid(),
      enrollmentId: z.uuid(),
      outcome: z.enum(['created', 'reactivated', 'unchanged']),
    }),
  ),
});
export type BulkEnrollResult = z.infer<typeof bulkEnrollResultSchema>;

export const listEnrollmentsQuerySchema = pageQuerySchema.extend({
  programId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  userId: z.uuid().optional(),
  status: queryList(enrollmentStatusSchema),
  overdue: queryBoolean,
});
export type ListEnrollmentsQuery = z.input<typeof listEnrollmentsQuerySchema>;

const learnerRefSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  email: z.string().nullable(),
  jobTitle: z.string().nullable(),
  teams: z.array(refSchema),
});

export const enrollmentSummarySchema = enrollmentProgressSchema.extend({
  learner: learnerRefSchema,
  program: titledRefSchema,
  currentPhase: phaseRefSchema.nullable(),
  assignedBy: personRefSchema.nullable(),
  withdrawnAt: isoDateTime.nullable(),
});
export type EnrollmentSummary = z.infer<typeof enrollmentSummarySchema>;
export const enrollmentPageSchema = pageSchema(enrollmentSummarySchema);

export const enrollmentLessonProgressSchema = z.object({
  lessonId: z.uuid(),
  phaseId: z.uuid(),
  moduleId: z.uuid(),
  title: z.string(),
  type: lessonTypeSchema,
  isRequired: z.boolean(),
  state: nodeStateSchema,
  status: lessonProgressStatusSchema,
  percent: z.number(),
  startedAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
  completionSource: completionSourceSchema.nullable(),
});

export const approvalSummarySchema = z.object({
  id: z.uuid(),
  kind: approvalKindSchema,
  status: approvalStatusSchema,
  learner: personRefSchema,
  program: titledRefSchema,
  lesson: z.object({ id: z.uuid(), title: z.string(), type: lessonTypeSchema }),
  enrollmentId: z.uuid(),
  requestedAt: isoDateTime,
  requestNote: z.string().nullable(),
  decidedAt: isoDateTime.nullable(),
  decidedBy: personRefSchema.nullable(),
  comment: z.string().nullable(),
  submission: z
    .object({ id: z.uuid(), body: z.string(), wordCount: z.int(), submittedAt: isoDateTime })
    .nullable(),
});
export type ApprovalSummary = z.infer<typeof approvalSummarySchema>;
export const approvalPageSchema = pageSchema(approvalSummarySchema);

export const enrollmentDetailSchema = enrollmentSummarySchema.extend({
  withdrawalReason: z.string().nullable(),
  phases: z.array(
    phaseRefSchema.extend({
      state: nodeStateSchema,
      ...progressNumbers,
      completedAt: isoDateTime.nullable(),
    }),
  ),
  lessons: z.array(enrollmentLessonProgressSchema),
  approvals: z.array(approvalSummarySchema),
});
export type EnrollmentDetail = z.infer<typeof enrollmentDetailSchema>;

export const withdrawEnrollmentRequestSchema = z.object({ reason: optionalText(500) });
export const setDueDateRequestSchema = z.object({ dueAt: isoDateTime.nullable() });
export const overrideCompletionRequestSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Explain why you are completing this lesson for the learner')
    .max(500),
});

// ------------------------------------------------------------------ manager oversight

export const ATTENTION_CODES = [
  'inactive',
  'overdue',
  'failing_assessment',
  'awaiting_approval',
  'not_started',
] as const;
export const attentionFlagSchema = z.object({ code: z.enum(ATTENTION_CODES), message: z.string() });
export type AttentionFlag = z.infer<typeof attentionFlagSchema>;

export const teamProgressQuerySchema = pageQuerySchema.extend({
  programId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  status: queryList(enrollmentStatusSchema),
  /** Only rows with at least one attention flag. */
  attention: queryBoolean,
});
export type TeamProgressQuery = z.input<typeof teamProgressQuerySchema>;

export const teamProgressRowSchema = z.object({
  enrollmentId: z.uuid(),
  learner: learnerRefSchema,
  program: titledRefSchema,
  status: enrollmentStatusSchema,
  progressPercent: z.number(),
  requiredTotal: z.int(),
  requiredCompleted: z.int(),
  currentPhase: phaseRefSchema.nullable(),
  enrolledAt: isoDateTime,
  lastActivityAt: isoDateTime.nullable(),
  dueAt: isoDateTime.nullable(),
  overdue: z.boolean(),
  attention: z.array(attentionFlagSchema),
});
export type TeamProgressRow = z.infer<typeof teamProgressRowSchema>;
export const teamProgressPageSchema = pageSchema(teamProgressRowSchema);

export const learnerScoreSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  bestScore: z.number(),
  lastScore: z.number(),
  passed: z.boolean(),
  attempts: z.int(),
  lastAt: isoDateTime,
});

export const learnerProgressSchema = z.object({
  learner: learnerRefSchema,
  enrollments: z.array(teamProgressRowSchema),
  assessments: z.array(learnerScoreSchema.extend({ kind: z.string() })),
  aiScenarios: z.array(learnerScoreSchema),
});
export type LearnerProgress = z.infer<typeof learnerProgressSchema>;

export const listApprovalsQuerySchema = pageQuerySchema.extend({
  status: approvalStatusSchema.default('pending'),
  kind: approvalKindSchema.optional(),
  programId: z.uuid().optional(),
});
export type ListApprovalsQuery = z.input<typeof listApprovalsQuerySchema>;

export const decideApprovalRequestSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    comment: optionalText(2_000),
  })
  .refine((v) => v.decision === 'approved' || Boolean(v.comment), {
    path: ['comment'],
    message: 'Tell the learner what to work on before you reject',
  });
export type DecideApprovalRequest = z.input<typeof decideApprovalRequestSchema>;

// ------------------------------------------------------------------ learner self-service

export const lessonProgressSchema = z.object({
  lessonId: z.uuid(),
  status: lessonProgressStatusSchema,
  percent: z.number(),
  startedAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
  completionSource: completionSourceSchema.nullable(),
  /** Credited video watch percentage, best assessment / AI score, depending on type. */
  watchedPercent: z.number().nullable(),
  bestScore: z.number().nullable(),
});
export type LessonProgress = z.infer<typeof lessonProgressSchema>;

export const myEnrollmentSchema = enrollmentProgressSchema.extend({
  program: z.object({
    id: z.uuid(),
    title: z.string(),
    summary: z.string().nullable(),
    category: z.string().nullable(),
    coverMediaAssetId: z.uuid().nullable(),
    phaseLabel: z.string(),
    phaseCount: z.int(),
  }),
  currentPhase: phaseRefSchema.nullable(),
  nextLesson: z
    .object({
      id: z.uuid(),
      title: z.string(),
      type: lessonTypeSchema,
      estimatedMinutes: z.int(),
      phaseTitle: z.string(),
      moduleTitle: z.string(),
      state: nodeStateSchema,
    })
    .nullable(),
  estimatedRemainingMinutes: z.int(),
});
export type MyEnrollment = z.infer<typeof myEnrollmentSchema>;
export const myEnrollmentListSchema = z.object({ items: z.array(myEnrollmentSchema) });

/** Programs a learner may join on their own (self-enrollment enabled, audience matches). */
export const catalogItemSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  summary: z.string().nullable(),
  category: z.string().nullable(),
  coverMediaAssetId: z.uuid().nullable(),
  phaseLabel: z.string(),
  phaseCount: z.int(),
  lessonCount: z.int(),
  estimatedMinutes: z.int(),
});
export type CatalogItem = z.infer<typeof catalogItemSchema>;
export const catalogSchema = z.object({ items: z.array(catalogItemSchema) });

export const continueLearningSchema = z.object({
  item: z
    .object({
      enrollmentId: z.uuid(),
      program: titledRefSchema,
      phase: phaseRefSchema,
      module: titledRefSchema,
      lesson: z.object({
        id: z.uuid(),
        title: z.string(),
        type: lessonTypeSchema,
        estimatedMinutes: z.int(),
        state: nodeStateSchema,
        percent: z.number(),
      }),
      progressPercent: z.number(),
    })
    .nullable(),
});
export type ContinueLearning = z.infer<typeof continueLearningSchema>;

export const lessonGrantSchema = z.object({
  token: z.string(),
  expiresAt: isoDateTime,
  resource: z.object({
    type: z.enum(['media', 'assessment', 'ai_scenario', 'document']),
    id: z.uuid(),
  }),
  policy: z.record(z.string(), z.unknown()),
});
export type LessonGrantDto = z.infer<typeof lessonGrantSchema>;

export const noteSchema = z.object({
  id: z.uuid(),
  lessonId: z.uuid(),
  body: z.string(),
  videoTimestampSeconds: z.int().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Note = z.infer<typeof noteSchema>;
export const noteListSchema = z.object({ items: z.array(noteSchema) });

export const createNoteRequestSchema = z.object({
  body: z.string().trim().min(1, 'Write something first').max(5_000),
  videoTimestampSeconds: z.int().min(0).max(86_400).nullable().optional(),
});
export const updateNoteRequestSchema = createNoteRequestSchema.partial();

export const acknowledgmentSchema = z.object({
  id: z.uuid(),
  lessonId: z.uuid(),
  typedName: z.string(),
  statementHash: z.string(),
  acknowledgedAt: isoDateTime,
});
export type Acknowledgment = z.infer<typeof acknowledgmentSchema>;

export const acknowledgeRequestSchema = z.object({
  typedName: z.string().trim().min(1, 'Type your full name').max(200),
});

export const submissionSchema = z.object({
  id: z.uuid(),
  lessonId: z.uuid(),
  body: z.string(),
  wordCount: z.int(),
  status: z.enum(['submitted', 'approved', 'rejected']),
  submittedAt: isoDateTime,
  reviewedAt: isoDateTime.nullable(),
  reviewedBy: personRefSchema.nullable(),
  feedback: z.string().nullable(),
});
export type Submission = z.infer<typeof submissionSchema>;

export const submitAssignmentRequestSchema = z.object({
  body: z.string().trim().min(1, 'Write your response first').max(50_000),
});

export const requestApprovalRequestSchema = z.object({ note: optionalText(1_000) });

export const learnerApprovalSchema = z.object({
  id: z.uuid(),
  kind: approvalKindSchema,
  status: approvalStatusSchema,
  requestedAt: isoDateTime,
  decidedAt: isoDateTime.nullable(),
  decidedBy: personRefSchema.nullable(),
  comment: z.string().nullable(),
});
export type LearnerApproval = z.infer<typeof learnerApprovalSchema>;

export const lessonDetailSchema = z.object({
  enrollmentId: z.uuid(),
  program: titledRefSchema,
  phase: phaseRefSchema,
  module: titledRefSchema,
  lesson: z.object({
    id: z.uuid(),
    type: lessonTypeSchema,
    title: z.string(),
    summary: z.string().nullable(),
    /** Null while the lesson is locked. */
    body: z.string().nullable(),
    config: lessonConfigRecordSchema.nullable(),
    isRequired: z.boolean(),
    estimatedMinutes: z.int(),
    resources: z.array(lessonResourceSchema),
  }),
  state: nodeStateSchema,
  requirements: z.array(requirementSchema),
  completion: z.object({
    mode: completionModeSchema,
    canCompleteManually: z.boolean(),
    hint: z.string(),
  }),
  progress: lessonProgressSchema,
  /** Signed capability for media, assessment or AI services; only for unlocked lessons. */
  grant: lessonGrantSchema.nullable(),
  notes: z.array(noteSchema),
  approval: learnerApprovalSchema.nullable(),
  submission: submissionSchema.nullable(),
  acknowledgment: acknowledgmentSchema.nullable(),
  previousLessonId: z.uuid().nullable(),
  nextLessonId: z.uuid().nullable(),
});
export type LessonDetail = z.infer<typeof lessonDetailSchema>;

export const completeLessonResultSchema = z.object({
  progress: lessonProgressSchema,
  enrollment: enrollmentProgressSchema,
});
export type CompleteLessonResult = z.infer<typeof completeLessonResultSchema>;

export const submissionResultSchema = z.object({
  submission: submissionSchema,
  approval: learnerApprovalSchema,
});

// ------------------------------------------------------------------ search

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Type at least 2 characters').max(100),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

export const searchResultSchema = z.object({
  programs: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      summary: z.string().nullable(),
      status: programStatusSchema,
    }),
  ),
  lessons: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      type: lessonTypeSchema,
      programId: z.uuid(),
      programTitle: z.string(),
      phaseTitle: z.string(),
      status: nodeStatusSchema,
    }),
  ),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

// ------------------------------------------------------------------ internal (service-to-service)

export const internalProgramSummarySchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  title: z.string(),
  status: programStatusSchema,
  publishedVersion: z.int(),
  phaseLabel: z.string(),
  phases: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      position: z.int(),
      requiredLessonIds: z.array(z.uuid()),
    }),
  ),
  requiredLessonIds: z.array(z.uuid()),
  assessments: z.array(
    z.object({
      assessmentId: z.uuid(),
      lessonId: z.uuid(),
      kind: z.enum(['quiz', 'exam', 'final', 'practice']),
      required: z.boolean(),
      title: z.string(),
    }),
  ),
  aiScenarios: z.array(
    z.object({ scenarioId: z.uuid(), lessonId: z.uuid(), minScore: z.number().nullable() }),
  ),
});
export type InternalProgramSummary = z.infer<typeof internalProgramSummarySchema>;
