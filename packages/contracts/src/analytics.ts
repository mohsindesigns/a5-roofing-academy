// API contracts for the analytics domain. Shared by the service and the web app.
import { z } from 'zod';
import { isoDate, isoDateTime, pageQuerySchema, pageSchema } from './common.js';

// ------------------------------------------------------------------ filters

const MAX_RANGE_DAYS = 3 * 366;

/**
 * Filters shared by dashboards, reports and exports. All are optional and combine with AND.
 * They can only narrow what the caller's data scope already admits.
 *
 * - `from` / `to` (inclusive calendar dates in the organization's reporting time zone) restrict
 *   activity facts by their event date (lesson completion, grading, AI evaluation, certificate
 *   issuance) and enrollment cohorts by enrollment date. Point-in-time figures (headcount,
 *   overdue, active certificates, expiring certificates) always reflect the current state.
 * - `programId` restricts program facts to that program and people to its enrollees.
 * - `certificationId` restricts certificate figures to that certification.
 * - `teamId`, `managerId`, `departmentId`, `locationId`, `userId` restrict the people.
 */
export const analyticsFilterShape = {
  from: isoDate.optional(),
  to: isoDate.optional(),
  programId: z.uuid().optional(),
  certificationId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  managerId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  userId: z.uuid().optional(),
};

function dateRangeIssues(v: { from?: string | undefined; to?: string | undefined }, ctx: z.RefinementCtx): void {
  if (v.from && v.to) {
    if (v.from > v.to) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'End date must be on or after the start date' });
      return;
    }
    const days = (Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`)) / 86_400_000;
    if (days > MAX_RANGE_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'Choose a date range of at most three years' });
    }
  }
}

export const analyticsFiltersSchema = z.object(analyticsFilterShape).superRefine(dateRangeIssues);
export type AnalyticsFilters = z.infer<typeof analyticsFiltersSchema>;

export const trendIntervalSchema = z.enum(['day', 'week', 'month']);
export type TrendInterval = z.infer<typeof trendIntervalSchema>;

export const dashboardQuerySchema = z
  .object({ ...analyticsFilterShape, interval: trendIntervalSchema.optional() })
  .superRefine(dateRangeIssues);
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

// ------------------------------------------------------------------ building blocks

export const trendPointSchema = z.object({
  /** First day of the bucket (YYYY-MM-DD). */
  date: isoDate,
  /** Bucket value; null when the bucket has no samples (render as a gap, not zero). */
  value: z.number().nullable(),
  /** Number of samples behind the value (sessions, attempts, completions). */
  count: z.int(),
});
export type TrendPoint = z.infer<typeof trendPointSchema>;

export const trendSchema = z.object({
  interval: trendIntervalSchema,
  from: isoDate,
  to: isoDate,
  points: z.array(trendPointSchema),
});
export type Trend = z.infer<typeof trendSchema>;

export const ratioSchema = z.object({
  /** Percentage 0–100 with one decimal, null when the denominator is zero. */
  percent: z.number().nullable(),
  numerator: z.int(),
  denominator: z.int(),
});
export type Ratio = z.infer<typeof ratioSchema>;

export const personBriefSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  teamNames: z.array(z.string()),
});
export type PersonBrief = z.infer<typeof personBriefSchema>;

export const appliedScopeSchema = z.enum(['own', 'managed', 'organization', 'platform']);

export const teamKpisSchema = z.object({
  headcount: z.int(),
  activeTrainees: z.int(),
  enrollments: z.int(),
  /** Completed enrollments ÷ enrollments (withdrawn excluded). */
  programCompletion: ratioSchema,
  /** Average progress across enrollments. */
  averageProgressPercent: z.number().nullable(),
  averageAssessmentScore: z.number().nullable(),
  assessmentAttempts: z.int(),
  aiRolePlayAverage: z.number().nullable(),
  aiSessions: z.int(),
  /** Completed the program and passed a final assessment. */
  fieldReadyCount: z.int(),
  /** Holds an active (issued, unexpired) certificate. */
  certifiedCount: z.int(),
});
export type TeamKpis = z.infer<typeof teamKpisSchema>;

export const fallingBehindReasonSchema = z.enum(['overdue', 'inactive', 'behind_pace']);

export const fallingBehindItemSchema = z.object({
  person: personBriefSchema,
  enrollmentId: z.uuid(),
  programId: z.uuid(),
  programTitle: z.string(),
  progressPercent: z.number(),
  expectedPercent: z.number().nullable(),
  enrolledAt: isoDateTime,
  dueAt: isoDateTime.nullable(),
  lastActivityAt: isoDateTime.nullable(),
  daysInactive: z.int(),
  reasons: z.array(fallingBehindReasonSchema),
});
export type FallingBehindItem = z.infer<typeof fallingBehindItemSchema>;

export const attentionReasonSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('failed_assessment'),
    assessmentId: z.uuid(),
    title: z.string(),
    scorePercent: z.number(),
    passingPercent: z.number(),
    attempts: z.int(),
    at: isoDateTime,
  }),
  z.object({
    kind: z.literal('low_ai_score'),
    scenarioId: z.uuid(),
    title: z.string(),
    score: z.number(),
    passingScore: z.number(),
    at: isoDateTime,
  }),
]);
export type AttentionReason = z.infer<typeof attentionReasonSchema>;

export const attentionItemSchema = z.object({
  person: personBriefSchema,
  reasons: z.array(attentionReasonSchema),
  latestAt: isoDateTime,
});

export const expiringCertificateSchema = z.object({
  person: personBriefSchema,
  certificateId: z.uuid(),
  certificationId: z.uuid(),
  certificationName: z.string(),
  certificateNumber: z.string().nullable(),
  expiresAt: isoDateTime,
  daysRemaining: z.int(),
});

export const activityKindSchema = z.enum([
  'enrolled',
  'lesson_completed',
  'phase_completed',
  'program_completed',
  'assessment_passed',
  'assessment_failed',
  'ai_session_scored',
  'certificate_issued',
  'certificate_revoked',
  'certificate_expired',
]);
export type ActivityKind = z.infer<typeof activityKindSchema>;

export const activityItemSchema = z.object({
  id: z.uuid(),
  at: isoDateTime,
  kind: activityKindSchema,
  title: z.string(),
  score: z.number().nullable(),
  passed: z.boolean().nullable(),
  person: z.object({ id: z.uuid(), displayName: z.string() }),
});
export type ActivityItem = z.infer<typeof activityItemSchema>;

export const weakAiCategorySchema = z.object({
  key: z.string(),
  label: z.string(),
  averageScore: z.number(),
  sessions: z.int(),
});

export const weakQuestionCategorySchema = z.object({
  categoryId: z.uuid().nullable(),
  name: z.string(),
  answered: z.int(),
  incorrect: z.int(),
  missRatePercent: z.number(),
});

export const weakestAreasSchema = z.object({
  aiCategories: z.array(weakAiCategorySchema),
  questionCategories: z.array(weakQuestionCategorySchema),
});

const listOf = <T extends z.ZodType>(item: T) => z.object({ total: z.int(), items: z.array(item) });

export const dashboardMetaSchema = z.object({
  generatedAt: isoDateTime,
  scope: appliedScopeSchema,
  filters: analyticsFiltersSchema,
  timezone: z.string(),
});

// ------------------------------------------------------------------ team dashboard

export const teamDashboardSchema = z.object({
  meta: dashboardMetaSchema,
  kpis: teamKpisSchema,
  fallingBehind: listOf(fallingBehindItemSchema),
  requiringAttention: listOf(attentionItemSchema),
  expiringCertifications: z.object({
    within30Days: z.int(),
    within60Days: z.int(),
    within90Days: z.int(),
    items: z.array(expiringCertificateSchema),
  }),
  recentActivity: z.array(activityItemSchema),
  weakestAreas: weakestAreasSchema,
  /** Weekly (or requested interval) learning activity for the people in view. */
  activityTrend: z.object({
    lessonsCompleted: trendSchema,
    aiAverageScore: trendSchema,
  }),
});
export type TeamDashboard = z.infer<typeof teamDashboardSchema>;

// ------------------------------------------------------------------ company dashboard

export const companyKpisSchema = teamKpisSchema.extend({
  /** Completed ÷ enrollments that are completed or past their due date. */
  trainingCompletionRate: ratioSchema,
  averageCompletionDays: z.number().nullable(),
  overdueEnrollments: z.int(),
  quizFailureRate: ratioSchema,
  certificationConversion: ratioSchema,
  averageDaysToCertification: z.number().nullable(),
  medianDaysToCertification: z.number().nullable(),
});
export type CompanyKpis = z.infer<typeof companyKpisSchema>;

export const breakdownRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  headcount: z.int(),
  activeTrainees: z.int(),
  programCompletion: ratioSchema,
  averageProgressPercent: z.number().nullable(),
  averageAssessmentScore: z.number().nullable(),
  aiRolePlayAverage: z.number().nullable(),
  certifiedCount: z.int(),
  overdueEnrollments: z.int(),
});
export type BreakdownRow = z.infer<typeof breakdownRowSchema>;

export const dropOffLessonSchema = z.object({
  lessonId: z.uuid(),
  title: z.string(),
  lessonType: z.string().nullable(),
  phaseTitle: z.string().nullable(),
  position: z.int().nullable(),
  /** Average days learners spend on the lesson (since their previous completion), including those still on it. */
  averageDwellDays: z.number(),
  completions: z.int(),
  stalledLearners: z.int(),
  averageDaysStalled: z.number().nullable(),
});

export const hardQuestionSchema = z.object({
  questionId: z.uuid(),
  prompt: z.string().nullable(),
  assessmentId: z.uuid(),
  assessmentTitle: z.string(),
  categoryName: z.string().nullable(),
  answered: z.int(),
  incorrect: z.int(),
  missRatePercent: z.number(),
});

export const failedObjectionSchema = z.object({
  scenarioId: z.uuid(),
  title: z.string(),
  category: z.string(),
  difficulty: z.string(),
  sessions: z.int(),
  failed: z.int(),
  failureRatePercent: z.number(),
  averageScore: z.number(),
});

export const categoryTrendSchema = z.object({
  interval: trendIntervalSchema,
  from: isoDate,
  to: isoDate,
  series: z.array(z.object({ key: z.string(), label: z.string(), points: z.array(trendPointSchema) })),
});

export const companyDashboardSchema = z.object({
  meta: dashboardMetaSchema,
  kpis: companyKpisSchema,
  breakdowns: z.object({ byLocation: z.array(breakdownRowSchema), byTeam: z.array(breakdownRowSchema) }),
  dropOffLessons: z.array(dropOffLessonSchema),
  hardestQuestions: z.array(hardQuestionSchema),
  mostFailedObjections: z.array(failedObjectionSchema),
  weakestAreas: weakestAreasSchema,
  aiScoreTrend: trendSchema,
  aiCompetencyTrend: categoryTrendSchema,
  completionTrend: z.object({ lessonsCompleted: trendSchema, programsCompleted: trendSchema }),
  assessmentTrend: z.object({ averageScore: trendSchema, failureRate: trendSchema }),
});
export type CompanyDashboard = z.infer<typeof companyDashboardSchema>;

// ------------------------------------------------------------------ trends

export const trendMetricSchema = z.enum([
  'lessons_completed',
  'enrollments_started',
  'programs_completed',
  'assessment_attempts',
  'assessment_score',
  'assessment_failure_rate',
  'ai_sessions',
  'ai_score',
  'certificates_issued',
  'active_learners',
]);
export type TrendMetric = z.infer<typeof trendMetricSchema>;

export const trendResponseSchema = trendSchema.extend({ metric: trendMetricSchema });

// ------------------------------------------------------------------ learner summary

export const learnerSummaryQuerySchema = z.object({ programId: z.uuid().optional() });

export const learnerSummarySchema = z.object({
  generatedAt: isoDateTime,
  person: z.object({ id: z.uuid(), displayName: z.string() }),
  enrollments: z.array(
    z.object({
      enrollmentId: z.uuid(),
      programId: z.uuid(),
      programTitle: z.string(),
      status: z.enum(['active', 'completed', 'withdrawn']),
      progressPercent: z.number(),
      enrolledAt: isoDateTime,
      dueAt: isoDateTime.nullable(),
      completedAt: isoDateTime.nullable(),
      overdue: z.boolean(),
    }),
  ),
  progressTrend: z
    .object({
      enrollmentId: z.uuid(),
      programTitle: z.string(),
      requiredTotal: z.int().nullable(),
      points: z.array(z.object({ date: isoDate, completedLessons: z.int(), progressPercent: z.number().nullable() })),
    })
    .nullable(),
  quizScores: z.array(
    z.object({
      assessmentId: z.uuid(),
      title: z.string(),
      kind: z.string(),
      passingPercent: z.number(),
      bestScore: z.number(),
      passed: z.boolean(),
      attempts: z.array(z.object({ attemptNumber: z.int(), scorePercent: z.number(), passed: z.boolean(), gradedAt: isoDateTime })),
      /** Average of peers' best scores (anonymised); null when the cohort is too small. */
      cohortAverage: z.number().nullable(),
    }),
  ),
  aiScores: z.object({
    sessions: z.array(
      z.object({
        sessionId: z.uuid(),
        evaluatedAt: isoDateTime,
        scenarioTitle: z.string(),
        overallScore: z.number(),
        passed: z.boolean(),
      }),
    ),
    categories: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        myAverage: z.number(),
        cohortAverage: z.number().nullable(),
        points: z.array(z.object({ date: isoDate, score: z.number() })),
      }),
    ),
  }),
  comparisons: z.object({
    /** Number of peers (excluding you) in the same programs. Averages are hidden below the minimum size. */
    cohortSize: z.int(),
    minimumCohortSize: z.int(),
    progressPercent: z.object({ mine: z.number().nullable(), cohort: z.number().nullable() }),
    assessmentAverage: z.object({ mine: z.number().nullable(), cohort: z.number().nullable() }),
    aiAverage: z.object({ mine: z.number().nullable(), cohort: z.number().nullable() }),
  }),
});
export type LearnerSummary = z.infer<typeof learnerSummarySchema>;

// ------------------------------------------------------------------ settings

export const analyticsSettingsSchema = z.object({
  /** Days without learning activity before an active trainee counts as inactive. */
  inactivityDays: z.int().min(1).max(90),
  /** Percentage points below the expected pace before a trainee counts as behind. */
  paceTolerancePercent: z.number().min(0).max(100),
  /** AI role-play scores below this value require attention. */
  lowAiScore: z.number().min(0).max(100),
  /** Look-back window for "requires attention" when no date range is given. */
  attentionLookbackDays: z.int().min(1).max(365),
  /** Cohort averages are hidden for cohorts smaller than this, so individuals cannot be inferred. */
  minCohortSize: z.int().min(2).max(100),
  /** Questions need at least this many answers to appear in "hardest questions". */
  minQuestionSample: z.int().min(1).max(1000),
});
export type AnalyticsSettings = z.infer<typeof analyticsSettingsSchema>;

export const DEFAULT_ANALYTICS_SETTINGS: AnalyticsSettings = {
  inactivityDays: 7,
  paceTolerancePercent: 15,
  lowAiScore: 70,
  attentionLookbackDays: 30,
  minCohortSize: 3,
  minQuestionSample: 3,
};

export const updateAnalyticsSettingsRequestSchema = analyticsSettingsSchema.partial();
export const analyticsSettingsResponseSchema = z.object({
  settings: analyticsSettingsSchema,
  updatedAt: isoDateTime.nullable(),
});

// ------------------------------------------------------------------ rollups

export const refreshRollupsRequestSchema = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .superRefine(dateRangeIssues);
export const refreshRollupsResponseSchema = z.object({
  jobId: z.string(),
  from: isoDate,
  to: isoDate,
  status: z.literal('queued'),
});

// ------------------------------------------------------------------ reports

export const REPORT_KEYS = [
  'training-completion',
  'assessment-performance',
  'ai-coaching-performance',
  'certification-status',
  'overdue-training',
  'training-engagement',
  'course-effectiveness',
] as const;
export const reportKeySchema = z.enum(REPORT_KEYS);
export type ReportKey = z.infer<typeof reportKeySchema>;

export const reportColumnTypeSchema = z.enum(['string', 'integer', 'number', 'percent', 'date', 'datetime', 'boolean']);

export const reportColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: reportColumnTypeSchema,
  sortable: z.boolean(),
});
export type ReportColumn = z.infer<typeof reportColumnSchema>;

export const reportDefinitionSchema = z.object({
  key: reportKeySchema,
  title: z.string(),
  description: z.string(),
  columns: z.array(reportColumnSchema),
  defaultSort: z.string(),
});
export type ReportDefinitionDto = z.infer<typeof reportDefinitionSchema>;

export const reportListSchema = z.object({ items: z.array(reportDefinitionSchema) });

const sortSchema = z
  .string()
  .regex(/^-?[a-zA-Z]+$/, 'Use a column key, optionally prefixed with "-" for descending order')
  .optional();

export const reportQuerySchema = z
  .object({
    ...analyticsFilterShape,
    page: pageQuerySchema.shape.page,
    pageSize: pageQuerySchema.shape.pageSize,
    q: pageQuerySchema.shape.q,
    sort: sortSchema,
  })
  .superRefine(dateRangeIssues);
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const reportCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const reportRowSchema = z.record(z.string(), reportCellSchema);

export const reportPageSchema = z.object({
  report: reportKeySchema,
  title: z.string(),
  columns: z.array(reportColumnSchema),
  sort: z.string(),
  items: z.array(reportRowSchema),
  page: z.int(),
  pageSize: z.int(),
  total: z.int(),
  pageCount: z.int(),
});
export type ReportPage = z.infer<typeof reportPageSchema>;

// ------------------------------------------------------------------ exports

export const exportFormatSchema = z.enum(['csv', 'xlsx', 'pdf']);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

export const exportStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'expired']);

export const createExportRequestSchema = z.object({
  report: reportKeySchema,
  format: exportFormatSchema,
  filters: analyticsFiltersSchema.optional(),
  sort: sortSchema,
  q: pageQuerySchema.shape.q,
});
export type CreateExportRequest = z.infer<typeof createExportRequestSchema>;

export const exportJobSchema = z.object({
  id: z.uuid(),
  report: reportKeySchema,
  reportTitle: z.string(),
  format: exportFormatSchema,
  status: exportStatusSchema,
  filters: analyticsFiltersSchema,
  sort: z.string().nullable(),
  rowCount: z.int().nullable(),
  fileName: z.string().nullable(),
  fileSize: z.int().nullable(),
  error: z.string().nullable(),
  createdAt: isoDateTime,
  startedAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
  expiresAt: isoDateTime.nullable(),
});
export type ExportJob = z.infer<typeof exportJobSchema>;

export const exportListQuerySchema = z.object({
  page: pageQuerySchema.shape.page,
  pageSize: pageQuerySchema.shape.pageSize,
});
export const exportPageSchema = pageSchema(exportJobSchema);

export const exportDownloadSchema = z.object({
  url: z.string(),
  fileName: z.string(),
  expiresAt: isoDateTime,
});
export type ExportDownload = z.infer<typeof exportDownloadSchema>;
