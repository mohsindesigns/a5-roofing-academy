import type { Generated, InboxSchema, OutboxSchema } from '@a5/database';
import type { DirectorySchema } from '@a5/directory';

// ------------------------------------------------------------------ dimensions

export interface DimProgramsTable {
  id: string;
  organization_id: string;
  title: string;
  /** Published version applied last; structure updates only apply for newer versions. */
  version: number;
  required_lesson_count: number | null;
  archived: boolean;
  published_at: Date | null;
  updated_at: Generated<Date>;
}

export interface DimPhasesTable {
  id: string;
  organization_id: string;
  program_id: string;
  title: string;
  position: number | null;
}

export interface DimLessonsTable {
  id: string;
  organization_id: string;
  program_id: string;
  phase_id: string | null;
  module_id: string | null;
  title: string | null;
  lesson_type: string | null;
  position: number | null;
  required: boolean | null;
  /** False when the lesson is no longer part of the latest published outline. */
  in_program: boolean;
  updated_at: Generated<Date>;
}

export interface DimAssessmentsTable {
  id: string;
  organization_id: string;
  program_id: string | null;
  lesson_id: string | null;
  title: string;
  kind: string;
  required: boolean | null;
  passing_percent: number | null;
  updated_at: Generated<Date>;
}

export interface DimQuestionsTable {
  id: string;
  organization_id: string;
  assessment_id: string;
  category_id: string | null;
  prompt: string | null;
  updated_at: Generated<Date>;
}

export interface DimQuestionCategoriesTable {
  id: string;
  organization_id: string;
  name: string;
}

export interface DimScenariosTable {
  id: string;
  organization_id: string;
  title: string | null;
  category: string | null;
  difficulty: string | null;
  passing_score: number | null;
  program_id: string | null;
  lesson_id: string | null;
  min_score: number | null;
  updated_at: Generated<Date>;
}

export interface DimCertificationsTable {
  id: string;
  organization_id: string;
  name: string;
  updated_at: Generated<Date>;
}

// ------------------------------------------------------------------ facts

export type EnrollmentStatus = 'active' | 'completed' | 'withdrawn';

export interface FactEnrollmentsTable {
  enrollment_id: string;
  organization_id: string;
  user_id: string;
  program_id: string;
  program_title: string | null;
  source: string | null;
  assigned_by: string | null;
  status: EnrollmentStatus;
  /** Time of the event that set the status (order guard). */
  status_at: Date | null;
  enrolled_at: Date | null;
  /** Earliest event seen for the enrollment; stands in for enrolled_at until program.enrolled arrives. */
  first_seen_at: Date;
  due_at: Date | null;
  progress_percent: number;
  required_completed: number;
  required_total: number | null;
  current_phase_id: string | null;
  progress_at: Date | null;
  completed_at: Date | null;
  withdrawn_at: Date | null;
  overdue: boolean;
  overdue_at: Date | null;
  last_activity_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** One row per learner and lesson within an enrollment: first start and first completion. */
export interface FactLessonEventsTable {
  enrollment_id: string;
  lesson_id: string;
  organization_id: string;
  user_id: string;
  program_id: string;
  phase_id: string | null;
  module_id: string | null;
  lesson_type: string | null;
  required: boolean | null;
  started_at: Date | null;
  completed_at: Date | null;
  completion_source: string | null;
}

export interface FactPhaseCompletionsTable {
  enrollment_id: string;
  phase_id: string;
  organization_id: string;
  user_id: string;
  program_id: string;
  phase_title: string;
  completed_at: Date;
}

export interface FactAssessmentAttemptsTable {
  attempt_id: string;
  organization_id: string;
  user_id: string;
  assessment_id: string;
  assessment_title: string;
  kind: string;
  attempt_number: number;
  score_percent: number;
  passed: boolean;
  passing_percent: number;
  overridden: boolean;
  graded_at: Date;
  program_id: string | null;
  enrollment_id: string | null;
  lesson_id: string | null;
  updated_at: Generated<Date>;
}

export interface FactQuestionResultsTable {
  attempt_id: string;
  question_id: string;
  organization_id: string;
  user_id: string;
  assessment_id: string;
  question_version_id: string;
  category_id: string | null;
  correct: boolean | null;
  awarded_points: number;
  possible_points: number;
  graded_at: Date;
}

export interface FactAiSessionsTable {
  session_id: string;
  organization_id: string;
  user_id: string;
  scenario_id: string;
  scenario_title: string;
  scenario_category: string;
  difficulty: string;
  overall_score: number;
  passed: boolean;
  passing_score: number;
  evaluated_at: Date;
  program_id: string | null;
  enrollment_id: string | null;
  lesson_id: string | null;
  prompt_version_id: string;
  rubric_version_id: string;
  updated_at: Generated<Date>;
}

export interface FactAiCategoryScoresTable {
  session_id: string;
  category_key: string;
  organization_id: string;
  user_id: string;
  category_label: string;
  score: number;
  evaluated_at: Date;
}

export type CertificateStatus = 'issued' | 'revoked' | 'expired' | 'superseded';

export interface FactCertificatesTable {
  certificate_id: string;
  organization_id: string;
  user_id: string;
  definition_id: string;
  definition_name: string;
  certificate_number: string | null;
  mode: string | null;
  status: CertificateStatus;
  status_at: Date;
  issued_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  expired_at: Date | null;
  superseded_at: Date | null;
  replaces_certificate_id: string | null;
  updated_at: Generated<Date>;
}

export interface FactCertificationCandidatesTable {
  definition_id: string;
  user_id: string;
  organization_id: string;
  definition_name: string;
  eligible_at: Date | null;
  requires_approval: boolean | null;
  approval_requested_at: Date | null;
  first_issued_at: Date | null;
  updated_at: Generated<Date>;
}

/** Learning feed entries, one per source event. */
export interface FactActivityTable {
  id: string;
  organization_id: string;
  user_id: string;
  occurred_at: Date;
  kind: string;
  title: string;
  program_id: string | null;
  score: number | null;
  passed: boolean | null;
}

/** Latest learner-initiated activity per user (lesson, assessment or AI practice). */
export interface LearnerActivityTable {
  user_id: string;
  organization_id: string;
  first_activity_at: Date;
  last_activity_at: Date;
}

// ------------------------------------------------------------------ rollups, reports, settings

export interface DailyRollupsTable {
  organization_id: string;
  date: string;
  metric: string;
  dimension_type: string;
  dimension_id: string;
  value: number;
  sample_count: number;
  computed_at: Generated<Date>;
}

export interface RollupDirtyDaysTable {
  organization_id: string;
  date: string;
  marked_at: Generated<Date>;
}

export type ReportJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'expired';

export interface ReportJobsTable {
  id: string;
  organization_id: string;
  requested_by: string;
  report: string;
  format: string;
  filters: Record<string, unknown>;
  sort: string | null;
  search: string | null;
  scope: Record<string, unknown>;
  status: ReportJobStatus;
  row_count: number | null;
  file_key: string | null;
  file_name: string | null;
  file_size: number | null;
  content_type: string | null;
  error: string | null;
  attempts: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  started_at: Date | null;
  completed_at: Date | null;
  expires_at: Date | null;
}

export interface AnalyticsSettingsTable {
  organization_id: string;
  config: Record<string, unknown>;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

export interface AnalyticsDatabase extends OutboxSchema, InboxSchema, DirectorySchema {
  dim_programs: DimProgramsTable;
  dim_phases: DimPhasesTable;
  dim_lessons: DimLessonsTable;
  dim_assessments: DimAssessmentsTable;
  dim_questions: DimQuestionsTable;
  dim_question_categories: DimQuestionCategoriesTable;
  dim_scenarios: DimScenariosTable;
  dim_certifications: DimCertificationsTable;
  fact_enrollments: FactEnrollmentsTable;
  fact_lesson_events: FactLessonEventsTable;
  fact_phase_completions: FactPhaseCompletionsTable;
  fact_assessment_attempts: FactAssessmentAttemptsTable;
  fact_question_results: FactQuestionResultsTable;
  fact_ai_sessions: FactAiSessionsTable;
  fact_ai_category_scores: FactAiCategoryScoresTable;
  fact_certificates: FactCertificatesTable;
  fact_certification_candidates: FactCertificationCandidatesTable;
  fact_activity: FactActivityTable;
  learner_activity: LearnerActivityTable;
  daily_rollups: DailyRollupsTable;
  rollup_dirty_days: RollupDirtyDaysTable;
  report_jobs: ReportJobsTable;
  analytics_settings: AnalyticsSettingsTable;
}
