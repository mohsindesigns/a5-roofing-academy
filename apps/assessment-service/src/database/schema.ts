import type { assessment } from '@a5/contracts';
import type { Generated, InboxSchema, OutboxSchema } from '@a5/database';
import type { DirectorySchema } from '@a5/directory';

export interface QuestionBanksTable {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  archived_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
}

export interface QuestionCategoriesTable {
  id: string;
  organization_id: string;
  bank_id: string;
  name: string;
  description: string | null;
  position: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CompetenciesTable {
  id: string;
  organization_id: string;
  bank_id: string;
  name: string;
  description: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface QuestionsTable {
  id: string;
  organization_id: string;
  bank_id: string;
  status: assessment.QuestionStatus;
  /** Always points at a version of this question (deferred composite foreign key). */
  current_version_id: string;
  archived_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
}

/** Insert-only; a trigger rejects updates and deletes. */
export interface QuestionVersionsTable {
  id: string;
  question_id: string;
  organization_id: string;
  version: number;
  type: assessment.QuestionType;
  prompt: string;
  config: assessment.QuestionDefinition['config'];
  explanation: string | null;
  points: number;
  difficulty: assessment.Difficulty;
  category_id: string | null;
  competency_ids: string[];
  tags: string[];
  change_note: string | null;
  created_at: Generated<Date>;
  created_by: string | null;
}

export interface AssessmentsTable {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  kind: assessment.AssessmentKind;
  status: assessment.AssessmentStatus;
  config: assessment.AssessmentConfig;
  revision: Generated<number>;
  published_at: Date | null;
  archived_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
}

export type AssessmentItemKind = 'question' | 'pool';

export interface AssessmentItemsTable {
  id: string;
  assessment_id: string;
  position: number;
  kind: AssessmentItemKind;
  question_id: string | null;
  pool_bank_id: string | null;
  pool_category_id: string | null;
  pool_difficulty: assessment.Difficulty | null;
  pool_tags: string[];
  pool_count: number | null;
  points: number | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AttemptsTable {
  id: string;
  organization_id: string;
  assessment_id: string;
  user_id: string;
  attempt_number: number;
  status: assessment.AttemptStatus;
  context: assessment.AttemptContext;
  config: assessment.AttemptConfigSnapshot;
  started_at: Date;
  expires_at: Date | null;
  submitted_at: Date | null;
  graded_at: Date | null;
  auto_submitted: boolean;
  max_points: number;
  score_points: number | null;
  score_percent: number | null;
  passed: boolean | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Drawn question snapshot; insert-only. */
export interface AttemptQuestionsTable {
  id: string;
  attempt_id: string;
  position: number;
  /** Assessment item that produced the question (historical reference, no foreign key). */
  item_id: string | null;
  question_id: string;
  question_version_id: string;
  option_order: assessment.OptionOrder;
  points: number;
}

/** One row per drawn question; frozen by trigger once the attempt leaves `in_progress`. */
export interface AttemptAnswersTable {
  id: string;
  attempt_id: string;
  attempt_question_id: string;
  response: assessment.AnswerResponse | null;
  saved_at: Date | null;
  client_sequence: number | null;
  needs_review: Generated<boolean>;
  is_correct: boolean | null;
  awarded_points: number | null;
  feedback: string | null;
  graded_by: string | null;
  graded_by_name: string | null;
  graded_at: Date | null;
}

/** Insert-only; the effective score of an attempt is its latest override. */
export interface ScoreOverridesTable {
  id: string;
  organization_id: string;
  attempt_id: string;
  previous_score_percent: number;
  previous_passed: boolean;
  new_score_percent: number;
  new_passed: boolean;
  reason: string;
  actor_id: string;
  actor_name: string;
  created_at: Generated<Date>;
}

export interface AssessmentDatabase extends OutboxSchema, InboxSchema, DirectorySchema {
  question_banks: QuestionBanksTable;
  question_categories: QuestionCategoriesTable;
  competencies: CompetenciesTable;
  questions: QuestionsTable;
  question_versions: QuestionVersionsTable;
  assessments: AssessmentsTable;
  assessment_items: AssessmentItemsTable;
  attempts: AttemptsTable;
  attempt_questions: AttemptQuestionsTable;
  attempt_answers: AttemptAnswersTable;
  score_overrides: ScoreOverridesTable;
}
