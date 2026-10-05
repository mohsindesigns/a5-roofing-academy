import type { ColumnType, Generated, InboxSchema, OutboxSchema } from '@a5/database';
import type { DirectorySchema } from '@a5/directory';

/** JSON columns: written as JSON text, read back as parsed values. */
type Json<T> = ColumnType<T, string, string>;

export type ProviderName = 'anthropic' | 'openai' | 'dev_simulator';
export type ProviderPreference = 'auto' | ProviderName;
export type ScenarioStatus = 'draft' | 'published' | 'archived';
export type Difficulty = 'beginner' | 'intermediate' | 'advanced' | 'expert';
export type SessionStatus =
  'active' | 'ended' | 'evaluating' | 'evaluated' | 'evaluation_failed' | 'abandoned';
export type EndReason =
  'rep_ended' | 'objective_reached' | 'homeowner_ended' | 'max_turns' | 'timeout';
export type Modality = 'text' | 'voice';
export type MessageRole = 'homeowner' | 'rep';
export type UsagePurpose = 'conversation' | 'evaluation';

export interface RubricCategoryRecord {
  key: string;
  label: string;
  description: string;
  weight: number;
  guidance: string;
}

export interface ModelSettingsRecord {
  temperature?: number;
  maxOutputTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  evaluationEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface SessionContextRecord {
  programId?: string;
  enrollmentId?: string;
  lessonId?: string;
}

export interface EvidenceRecord {
  seq: number;
  quote: string;
}

export interface CategoryScoreRecord {
  key: string;
  label: string;
  weight: number;
  score: number;
  rationale: string;
  evidence: EvidenceRecord[];
}

export interface AiSettingsTable {
  organization_id: string;
  default_provider: ProviderPreference;
  conversation_model: string | null;
  evaluation_model: string | null;
  max_sessions_per_learner_per_day: number | null;
  transcript_retention_days: number | null;
  timezone: string;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

export interface AiPersonasTable {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  temperament: string;
  speaking_style: string;
  background: string;
  traits: Json<string[]>;
  archived_at: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
}

export interface AiRubricsTable {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  current_version_id: string;
  archived_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
}

export interface AiRubricVersionsTable {
  id: string;
  rubric_id: string;
  version: number;
  categories: Json<RubricCategoryRecord[]>;
  passing_score: number;
  change_note: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface AiScenariosTable {
  id: string;
  organization_id: string;
  title: string;
  category: string;
  difficulty: Difficulty;
  persona_id: string;
  objection: string;
  rep_brief: string;
  background: string;
  property_context: string;
  trigger: string;
  hidden_concern: string;
  expected_behaviors: string[];
  required_talking_points: string[];
  forbidden_claims: string[];
  ai_instructions: string;
  opening_line: string;
  passing_score: number;
  rubric_id: string;
  max_turns: number;
  provider: ProviderName | null;
  model: string | null;
  evaluation_model: string | null;
  model_settings: Json<ModelSettingsRecord>;
  status: ScenarioStatus;
  current_prompt_version_id: string | null;
  published_at: Date | null;
  archived_at: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
}

export interface AiPromptVersionsTable {
  id: string;
  organization_id: string;
  scenario_id: string;
  version: number;
  homeowner_system_prompt: string;
  evaluator_system_prompt: string;
  persona_snapshot: Json<Record<string, unknown>>;
  scenario_snapshot: Json<Record<string, unknown>>;
  provider: ProviderName | null;
  model: string | null;
  model_settings: Json<ModelSettingsRecord>;
  evaluation_model: string | null;
  rubric_version_id: string;
  content_hash: string;
  change_note: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface AiSessionsTable {
  id: string;
  organization_id: string;
  user_id: string;
  scenario_id: string;
  prompt_version_id: string;
  rubric_version_id: string;
  mode: 'practice' | 'assigned';
  is_test: boolean;
  context: Json<SessionContextRecord>;
  modality: Modality;
  status: SessionStatus;
  end_reason: EndReason | null;
  provider: ProviderName;
  model: string;
  max_turns: number;
  turn_count: Generated<number>;
  started_at: Generated<Date>;
  ended_at: Date | null;
  last_activity_at: Generated<Date>;
  evaluation_attempts: Generated<number>;
  evaluation_error: string | null;
  transcript_purged_at: Date | null;
  updated_at: Generated<Date>;
}

export interface AiMessagesTable {
  id: string;
  session_id: string;
  organization_id: string;
  seq: number;
  role: MessageRole;
  content: string;
  modality: Modality;
  audio_ref: string | null;
  client_message_id: string | null;
  provider: ProviderName | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  created_at: Generated<Date>;
}

export interface AiEvaluationsTable {
  id: string;
  session_id: string;
  organization_id: string;
  user_id: string;
  scenario_id: string;
  is_test: boolean;
  overall_score: number;
  passed: boolean;
  passing_score: number;
  category_scores: Json<CategoryScoreRecord[]>;
  strengths: Json<Array<{ point: string; evidence: EvidenceRecord[] }>>;
  missed_opportunities: Json<
    Array<{ point: string; seq: number | null; quote: string | null; betterApproach: string }>
  >;
  questions_to_ask: Json<Array<{ question: string; why: string }>>;
  risky_statements: Json<
    Array<{ seq: number; quote: string; issue: string; saferAlternative: string }>
  >;
  recommended_responses: Json<
    Array<{ seq: number | null; repSaid: string | null; betterResponse: string; why: string }>
  >;
  next_goal: string;
  summary: string;
  provider: ProviderName;
  model: string;
  prompt_version_id: string;
  rubric_version_id: string;
  raw: Json<unknown>;
  created_at: Generated<Date>;
}

export interface AiEvaluationScoresTable {
  evaluation_id: string;
  session_id: string;
  organization_id: string;
  user_id: string;
  scenario_id: string;
  category_key: string;
  category_label: string;
  score: number;
  weight: number;
  is_test: boolean;
  evaluated_at: Date;
}

export interface AiSessionReviewsTable {
  id: string;
  session_id: string;
  organization_id: string;
  reviewer_id: string;
  comment: string;
  recommendation: 'ready' | 'practice_again' | 'retrain';
  created_at: Generated<Date>;
}

export interface AiUsageTable {
  id: string;
  organization_id: string;
  user_id: string | null;
  session_id: string | null;
  scenario_id: string | null;
  purpose: UsagePurpose;
  is_test: boolean;
  provider: ProviderName;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  estimated_cost_usd: number;
  priced: boolean;
  latency_ms: number;
  success: boolean;
  error_code: string | null;
  created_at: Generated<Date>;
}

export interface AiDatabase extends OutboxSchema, InboxSchema, DirectorySchema {
  ai_settings: AiSettingsTable;
  ai_personas: AiPersonasTable;
  ai_rubrics: AiRubricsTable;
  ai_rubric_versions: AiRubricVersionsTable;
  ai_scenarios: AiScenariosTable;
  ai_prompt_versions: AiPromptVersionsTable;
  ai_sessions: AiSessionsTable;
  ai_messages: AiMessagesTable;
  ai_evaluations: AiEvaluationsTable;
  ai_evaluation_scores: AiEvaluationScoresTable;
  ai_session_reviews: AiSessionReviewsTable;
  ai_usage: AiUsageTable;
}
