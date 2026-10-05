import {
  addUpdatedAtTrigger,
  createInboxTable,
  createOutboxTable,
  createUpdatedAtFunction,
  sql,
  type Kysely,
} from '@a5/database';
import { createDirectoryTables, dropDirectoryTables } from '@a5/directory';

const UPDATED_AT_TABLES = [
  'dim_programs',
  'dim_lessons',
  'dim_assessments',
  'dim_questions',
  'dim_scenarios',
  'dim_certifications',
  'fact_enrollments',
  'fact_assessment_attempts',
  'fact_ai_sessions',
  'fact_certificates',
  'fact_certification_candidates',
  'report_jobs',
  'analytics_settings',
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await createUpdatedAtFunction(db);
  await createOutboxTable(db);
  await createInboxTable(db);
  await createDirectoryTables(db);

  // ---------------------------------------------------------------- dimensions
  await sql`
    create table dim_programs (
      id uuid primary key,
      organization_id uuid not null,
      title text not null,
      version integer not null default 0,
      required_lesson_count integer,
      archived boolean not null default false,
      published_at timestamptz,
      updated_at timestamptz not null default now()
    );
    create index dim_programs_org_idx on dim_programs (organization_id);

    create table dim_phases (
      id uuid primary key,
      organization_id uuid not null,
      program_id uuid not null,
      title text not null,
      position integer
    );
    create index dim_phases_program_idx on dim_phases (program_id, position);

    create table dim_lessons (
      id uuid primary key,
      organization_id uuid not null,
      program_id uuid not null,
      phase_id uuid,
      module_id uuid,
      title text,
      lesson_type text,
      position integer,
      required boolean,
      in_program boolean not null default true,
      updated_at timestamptz not null default now()
    );
    create index dim_lessons_program_idx on dim_lessons (program_id, position) where in_program;

    create table dim_assessments (
      id uuid primary key,
      organization_id uuid not null,
      program_id uuid,
      lesson_id uuid,
      title text not null,
      kind text not null,
      required boolean,
      passing_percent numeric(6,2),
      updated_at timestamptz not null default now()
    );
    create index dim_assessments_program_idx on dim_assessments (program_id);

    create table dim_question_categories (
      id uuid primary key,
      organization_id uuid not null,
      name text not null
    );

    create table dim_questions (
      id uuid primary key,
      organization_id uuid not null,
      assessment_id uuid not null,
      category_id uuid,
      prompt text,
      updated_at timestamptz not null default now()
    );
    create index dim_questions_assessment_idx on dim_questions (assessment_id);

    create table dim_scenarios (
      id uuid primary key,
      organization_id uuid not null,
      title text,
      category text,
      difficulty text,
      passing_score numeric(6,2),
      program_id uuid,
      lesson_id uuid,
      min_score numeric(6,2),
      updated_at timestamptz not null default now()
    );

    create table dim_certifications (
      id uuid primary key,
      organization_id uuid not null,
      name text not null,
      updated_at timestamptz not null default now()
    );
  `.execute(db);

  // ---------------------------------------------------------------- facts
  await sql`
    create table fact_enrollments (
      enrollment_id uuid primary key,
      organization_id uuid not null,
      user_id uuid not null,
      program_id uuid not null,
      program_title text,
      source text,
      assigned_by uuid,
      status text not null default 'active' check (status in ('active', 'completed', 'withdrawn')),
      status_at timestamptz,
      enrolled_at timestamptz,
      first_seen_at timestamptz not null,
      due_at timestamptz,
      progress_percent numeric(6,2) not null default 0,
      required_completed integer not null default 0,
      required_total integer,
      current_phase_id uuid,
      progress_at timestamptz,
      completed_at timestamptz,
      withdrawn_at timestamptz,
      overdue boolean not null default false,
      overdue_at timestamptz,
      last_activity_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index fact_enrollments_org_user_idx on fact_enrollments (organization_id, user_id);
    create index fact_enrollments_user_idx on fact_enrollments (user_id);
    create index fact_enrollments_org_program_status_idx on fact_enrollments (organization_id, program_id, status);
    create index fact_enrollments_active_due_idx on fact_enrollments (organization_id, due_at) where status = 'active';
    create index fact_enrollments_completed_idx on fact_enrollments (organization_id, completed_at) where completed_at is not null;

    create table fact_lesson_events (
      enrollment_id uuid not null,
      lesson_id uuid not null,
      organization_id uuid not null,
      user_id uuid not null,
      program_id uuid not null,
      phase_id uuid,
      module_id uuid,
      lesson_type text,
      required boolean,
      started_at timestamptz,
      completed_at timestamptz,
      completion_source text,
      primary key (enrollment_id, lesson_id)
    );
    create index fact_lesson_events_org_completed_idx on fact_lesson_events (organization_id, completed_at);
    create index fact_lesson_events_enrollment_completed_idx on fact_lesson_events (enrollment_id, completed_at);
    create index fact_lesson_events_user_idx on fact_lesson_events (user_id, completed_at);
    create index fact_lesson_events_lesson_idx on fact_lesson_events (lesson_id);

    create table fact_phase_completions (
      enrollment_id uuid not null,
      phase_id uuid not null,
      organization_id uuid not null,
      user_id uuid not null,
      program_id uuid not null,
      phase_title text not null,
      completed_at timestamptz not null,
      primary key (enrollment_id, phase_id)
    );
    create index fact_phase_completions_org_idx on fact_phase_completions (organization_id, completed_at);

    create table fact_assessment_attempts (
      attempt_id uuid primary key,
      organization_id uuid not null,
      user_id uuid not null,
      assessment_id uuid not null,
      assessment_title text not null,
      kind text not null,
      attempt_number integer not null,
      score_percent numeric(6,2) not null,
      passed boolean not null,
      passing_percent numeric(6,2) not null,
      overridden boolean not null default false,
      graded_at timestamptz not null,
      program_id uuid,
      enrollment_id uuid,
      lesson_id uuid,
      updated_at timestamptz not null default now()
    );
    create index fact_attempts_org_graded_idx on fact_assessment_attempts (organization_id, graded_at);
    create index fact_attempts_user_assessment_idx on fact_assessment_attempts (user_id, assessment_id, graded_at desc);
    create index fact_attempts_assessment_idx on fact_assessment_attempts (assessment_id);

    create table fact_question_results (
      attempt_id uuid not null,
      question_id uuid not null,
      organization_id uuid not null,
      user_id uuid not null,
      assessment_id uuid not null,
      question_version_id uuid not null,
      category_id uuid,
      correct boolean,
      awarded_points numeric(10,2) not null,
      possible_points numeric(10,2) not null,
      graded_at timestamptz not null,
      primary key (attempt_id, question_id)
    );
    create index fact_question_results_org_graded_idx on fact_question_results (organization_id, graded_at);
    create index fact_question_results_question_idx on fact_question_results (question_id);
    create index fact_question_results_category_idx on fact_question_results (category_id);

    create table fact_ai_sessions (
      session_id uuid primary key,
      organization_id uuid not null,
      user_id uuid not null,
      scenario_id uuid not null,
      scenario_title text not null,
      scenario_category text not null,
      difficulty text not null,
      overall_score numeric(6,2) not null,
      passed boolean not null,
      passing_score numeric(6,2) not null,
      evaluated_at timestamptz not null,
      program_id uuid,
      enrollment_id uuid,
      lesson_id uuid,
      prompt_version_id uuid not null,
      rubric_version_id uuid not null,
      updated_at timestamptz not null default now()
    );
    create index fact_ai_sessions_org_evaluated_idx on fact_ai_sessions (organization_id, evaluated_at);
    create index fact_ai_sessions_user_idx on fact_ai_sessions (user_id, evaluated_at desc);
    create index fact_ai_sessions_scenario_idx on fact_ai_sessions (scenario_id);

    create table fact_ai_category_scores (
      session_id uuid not null,
      category_key text not null,
      organization_id uuid not null,
      user_id uuid not null,
      category_label text not null,
      score numeric(6,2) not null,
      evaluated_at timestamptz not null,
      primary key (session_id, category_key)
    );
    create index fact_ai_category_org_idx on fact_ai_category_scores (organization_id, evaluated_at);
    create index fact_ai_category_user_idx on fact_ai_category_scores (user_id, category_key, evaluated_at);

    create table fact_certificates (
      certificate_id uuid primary key,
      organization_id uuid not null,
      user_id uuid not null,
      definition_id uuid not null,
      definition_name text not null,
      certificate_number text,
      mode text,
      status text not null check (status in ('issued', 'revoked', 'expired', 'superseded')),
      status_at timestamptz not null,
      issued_at timestamptz,
      expires_at timestamptz,
      revoked_at timestamptz,
      revoke_reason text,
      expired_at timestamptz,
      superseded_at timestamptz,
      replaces_certificate_id uuid,
      updated_at timestamptz not null default now()
    );
    create index fact_certificates_org_status_idx on fact_certificates (organization_id, status, expires_at);
    create index fact_certificates_user_idx on fact_certificates (user_id);
    create index fact_certificates_definition_idx on fact_certificates (definition_id, user_id);

    create table fact_certification_candidates (
      definition_id uuid not null,
      user_id uuid not null,
      organization_id uuid not null,
      definition_name text not null,
      eligible_at timestamptz,
      requires_approval boolean,
      approval_requested_at timestamptz,
      first_issued_at timestamptz,
      updated_at timestamptz not null default now(),
      primary key (definition_id, user_id)
    );
    create index fact_cert_candidates_org_idx on fact_certification_candidates (organization_id, eligible_at);
    create index fact_cert_candidates_user_idx on fact_certification_candidates (user_id);

    create table fact_activity (
      id uuid primary key,
      organization_id uuid not null,
      user_id uuid not null,
      occurred_at timestamptz not null,
      kind text not null,
      title text not null,
      program_id uuid,
      score numeric(6,2),
      passed boolean
    );
    create index fact_activity_org_time_idx on fact_activity (organization_id, occurred_at desc);
    create index fact_activity_user_time_idx on fact_activity (user_id, occurred_at desc);

    create table learner_activity (
      user_id uuid primary key,
      organization_id uuid not null,
      first_activity_at timestamptz not null,
      last_activity_at timestamptz not null
    );
    create index learner_activity_org_idx on learner_activity (organization_id, last_activity_at);
  `.execute(db);

  // ---------------------------------------------------------------- rollups, reports, settings
  await sql`
    create table daily_rollups (
      organization_id uuid not null,
      date date not null,
      metric text not null,
      dimension_type text not null check (dimension_type in ('organization', 'team', 'location', 'department', 'user')),
      dimension_id text not null,
      value numeric not null,
      sample_count integer not null,
      computed_at timestamptz not null default now(),
      primary key (organization_id, metric, dimension_type, dimension_id, date)
    );
    create index daily_rollups_org_date_idx on daily_rollups (organization_id, date);

    create table rollup_dirty_days (
      organization_id uuid not null,
      date date not null,
      marked_at timestamptz not null default now(),
      primary key (organization_id, date)
    );

    create table report_jobs (
      id uuid primary key,
      organization_id uuid not null,
      requested_by uuid not null,
      report text not null,
      format text not null check (format in ('csv', 'xlsx', 'pdf')),
      filters jsonb not null default '{}',
      sort text,
      search text,
      scope jsonb not null,
      status text not null check (status in ('queued', 'running', 'completed', 'failed', 'expired')),
      row_count integer,
      file_key text,
      file_name text,
      file_size bigint,
      content_type text,
      error text,
      attempts integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      started_at timestamptz,
      completed_at timestamptz,
      expires_at timestamptz
    );
    create index report_jobs_requester_idx on report_jobs (organization_id, requested_by, created_at desc);
    create index report_jobs_expiry_idx on report_jobs (expires_at) where status = 'completed';
    create index report_jobs_pending_idx on report_jobs (created_at) where status in ('queued', 'running');

    create table analytics_settings (
      organization_id uuid primary key,
      config jsonb not null,
      updated_at timestamptz not null default now(),
      updated_by uuid
    );
  `.execute(db);

  for (const table of UPDATED_AT_TABLES) await addUpdatedAtTrigger(db, table);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists
      analytics_settings, report_jobs, rollup_dirty_days, daily_rollups,
      learner_activity, fact_activity, fact_certification_candidates, fact_certificates,
      fact_ai_category_scores, fact_ai_sessions, fact_question_results, fact_assessment_attempts,
      fact_phase_completions, fact_lesson_events, fact_enrollments,
      dim_certifications, dim_scenarios, dim_questions, dim_question_categories, dim_assessments,
      dim_lessons, dim_phases, dim_programs,
      inbox_events, outbox_events
  `.execute(db);
  await dropDirectoryTables(db);
  await sql`drop function if exists set_updated_at()`.execute(db);
}
