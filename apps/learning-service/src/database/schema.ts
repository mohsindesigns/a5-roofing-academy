import type { ColumnType, Generated, InboxSchema, OutboxSchema } from '@a5/database';
import type { DirectorySchema } from '@a5/directory';
import type { learning } from '@a5/contracts';
import type { Rule } from '@a5/rules';

/** JSONB column: objects are serialized by the driver (never store top-level arrays). */
type Json<T> = ColumnType<T, T, T>;

export interface ProgramsTable {
  id: string;
  organization_id: string;
  slug: string;
  title: string;
  summary: string | null;
  description: string | null;
  cover_media_asset_id: string | null;
  category: string | null;
  owner_user_id: string | null;
  status: learning.ProgramStatus;
  phase_label: string;
  settings: Json<learning.ProgramSettings>;
  estimated_minutes: number | null;
  duration_days: number | null;
  availability_starts_at: Date | null;
  availability_ends_at: Date | null;
  tags: string[];
  /** Incremented on every change to the working copy (structure, content, settings). */
  revision: Generated<number>;
  /** Working-copy revision captured by the latest publish. */
  published_revision: number | null;
  published_version: Generated<number>;
  published_at: Date | null;
  archived_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
}

export interface ProgramAudiencesTable {
  program_id: string;
  kind: learning.AudienceKind;
  ref: string;
  created_at: Generated<Date>;
}

export interface ProgramPrerequisitesTable {
  program_id: string;
  required_program_id: string;
  created_at: Generated<Date>;
}

interface NodeColumns {
  status: learning.NodeStatus;
  /** True when the working copy of this node differs from what learners currently see. */
  unpublished_changes: Generated<boolean>;
  first_published_at: Date | null;
  archived_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
}

export interface ProgramPhasesTable extends NodeColumns {
  id: string;
  program_id: string;
  position: number;
  title: string;
  summary: string | null;
  unlock_rule: Json<Rule> | null;
}

export interface ProgramModulesTable extends NodeColumns {
  id: string;
  program_id: string;
  phase_id: string;
  position: number;
  title: string;
  summary: string | null;
  unlock_rule: Json<Rule> | null;
}

export interface LessonsTable extends NodeColumns {
  id: string;
  organization_id: string;
  program_id: string;
  module_id: string;
  position: number;
  type: learning.LessonType;
  title: string;
  summary: string | null;
  body: string | null;
  config: Json<Record<string, unknown>>;
  is_required: boolean;
  estimated_minutes: number;
  unlock_rule: Json<Rule> | null;
}

export interface LessonResourcesTable {
  id: string;
  lesson_id: string;
  position: number;
  title: string;
  description: string | null;
  kind: 'link' | 'media';
  url: string | null;
  media_asset_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
}

export interface ProgramVersionsTable {
  id: string;
  program_id: string;
  version: number;
  change_note: string;
  snapshot: Json<Record<string, unknown>>;
  stats: Json<learning.ProgramVersion['stats']>;
  published_by: string | null;
  published_by_name: string | null;
  published_at: Generated<Date>;
}

export interface EnrollmentsTable {
  id: string;
  organization_id: string;
  program_id: string;
  user_id: string;
  status: learning.EnrollmentStatus;
  source: learning.EnrollmentSource;
  assigned_by: string | null;
  enrolled_at: Date;
  due_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  withdrawn_at: Date | null;
  withdrawn_by: string | null;
  withdrawal_reason: string | null;
  progress_percent: Generated<number>;
  required_total: Generated<number>;
  required_completed: Generated<number>;
  current_lesson_id: string | null;
  current_phase_id: string | null;
  last_activity_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LessonProgressData {
  watchedPercent?: number;
  bestScore?: number;
  lastScore?: number;
  attemptId?: string;
  sessionId?: string;
  overrideReason?: string;
  [key: string]: unknown;
}

export interface LessonProgressTable {
  id: string;
  enrollment_id: string;
  lesson_id: string;
  user_id: string;
  status: learning.LessonProgressStatus;
  percent: Generated<number>;
  started_at: Date | null;
  completed_at: Date | null;
  completion_source: learning.CompletionSource | null;
  completed_by: string | null;
  data: Json<LessonProgressData>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PhaseCompletionsTable {
  enrollment_id: string;
  phase_id: string;
  completed_at: Date;
}

export interface LessonNotesTable {
  id: string;
  organization_id: string;
  user_id: string;
  lesson_id: string;
  body: string;
  video_timestamp_seconds: number | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ApprovalRequestsTable {
  id: string;
  organization_id: string;
  kind: learning.ApprovalKind;
  status: learning.ApprovalStatus;
  enrollment_id: string;
  program_id: string;
  lesson_id: string;
  user_id: string;
  submission_id: string | null;
  request_note: string | null;
  requested_at: Generated<Date>;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: Date | null;
  comment: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AcknowledgmentsTable {
  id: string;
  organization_id: string;
  user_id: string;
  enrollment_id: string;
  lesson_id: string;
  statement_hash: string;
  statement_text: string;
  typed_name: string;
  ip: string | null;
  user_agent: string | null;
  acknowledged_at: Generated<Date>;
}

export interface AssignmentSubmissionsTable {
  id: string;
  organization_id: string;
  user_id: string;
  enrollment_id: string;
  lesson_id: string;
  body: string;
  word_count: number;
  status: 'submitted' | 'approved' | 'rejected';
  submitted_at: Generated<Date>;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: Date | null;
  feedback: string | null;
}

export interface LearnerAssessmentAttemptsTable {
  attempt_id: string;
  organization_id: string | null;
  user_id: string;
  assessment_id: string;
  assessment_title: string;
  kind: string;
  attempt_number: number;
  score_percent: number;
  passed: boolean;
  passing_percent: number;
  lesson_id: string | null;
  graded_at: Date;
  updated_at: Generated<Date>;
}

export interface LearnerAssessmentScoresTable {
  user_id: string;
  assessment_id: string;
  organization_id: string | null;
  assessment_title: string;
  kind: string;
  best_score: number;
  last_score: number;
  passed: boolean;
  attempts: number;
  last_attempt_at: Date;
  updated_at: Generated<Date>;
}

export interface LearnerAiSessionsTable {
  session_id: string;
  organization_id: string | null;
  user_id: string;
  scenario_id: string;
  scenario_title: string;
  score: number;
  passed: boolean;
  passing_score: number;
  lesson_id: string | null;
  evaluated_at: Date;
  updated_at: Generated<Date>;
}

export interface LearnerAiScoresTable {
  user_id: string;
  scenario_id: string;
  organization_id: string | null;
  scenario_title: string;
  best_score: number;
  last_score: number;
  passed: boolean;
  sessions: number;
  last_session_at: Date;
  updated_at: Generated<Date>;
}

export interface EnrollmentOverdueNoticesTable {
  enrollment_id: string;
  notice_date: string;
  created_at: Generated<Date>;
}

export interface LearningDatabase extends OutboxSchema, InboxSchema, DirectorySchema {
  programs: ProgramsTable;
  program_audiences: ProgramAudiencesTable;
  program_prerequisites: ProgramPrerequisitesTable;
  program_phases: ProgramPhasesTable;
  program_modules: ProgramModulesTable;
  lessons: LessonsTable;
  lesson_resources: LessonResourcesTable;
  program_versions: ProgramVersionsTable;
  enrollments: EnrollmentsTable;
  lesson_progress: LessonProgressTable;
  phase_completions: PhaseCompletionsTable;
  lesson_notes: LessonNotesTable;
  approval_requests: ApprovalRequestsTable;
  acknowledgments: AcknowledgmentsTable;
  assignment_submissions: AssignmentSubmissionsTable;
  learner_assessment_attempts: LearnerAssessmentAttemptsTable;
  learner_assessment_scores: LearnerAssessmentScoresTable;
  learner_ai_sessions: LearnerAiSessionsTable;
  learner_ai_scores: LearnerAiScoresTable;
  enrollment_overdue_notices: EnrollmentOverdueNoticesTable;
}
