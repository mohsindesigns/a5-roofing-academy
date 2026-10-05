import {
  addUpdatedAtTrigger,
  createInboxTable,
  createOutboxTable,
  createUpdatedAtFunction,
  sql,
  type Kysely,
} from '@a5/database';
import { createDirectoryTables } from '@a5/directory';

export async function up(db: Kysely<unknown>): Promise<void> {
  await createUpdatedAtFunction(db);
  await createOutboxTable(db);
  await createInboxTable(db);
  await createDirectoryTables(db);

  await sql`
    -- Rows that must never change once written (published snapshots, signed acknowledgments).
    create or replace function reject_mutation() returns trigger as $$
    begin
      raise exception '% rows are immutable', tg_table_name using errcode = 'restrict_violation';
    end;
    $$ language plpgsql;

    create table programs (
      id uuid primary key,
      organization_id uuid not null,
      slug text not null,
      title text not null,
      summary text,
      description text,
      cover_media_asset_id uuid,
      category text,
      owner_user_id uuid,
      status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
      phase_label text not null default 'Week',
      settings jsonb not null default '{}',
      estimated_minutes integer check (estimated_minutes >= 0),
      duration_days integer check (duration_days > 0),
      availability_starts_at timestamptz,
      availability_ends_at timestamptz,
      tags text[] not null default '{}',
      revision bigint not null default 1,
      published_revision bigint,
      published_version integer not null default 0,
      published_at timestamptz,
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      updated_by uuid,
      check (availability_ends_at is null or availability_starts_at is null or availability_ends_at > availability_starts_at)
    );
    create unique index programs_org_slug_uq on programs (organization_id, lower(slug));
    create index programs_org_status_idx on programs (organization_id, status, lower(title));

    create table program_audiences (
      program_id uuid not null references programs(id) on delete cascade,
      kind text not null check (kind in ('role', 'team', 'department', 'location')),
      ref text not null,
      created_at timestamptz not null default now(),
      primary key (program_id, kind, ref)
    );
    -- Auto-enrollment looks up programs by audience.
    create index program_audiences_ref_idx on program_audiences (kind, ref);

    create table program_prerequisites (
      program_id uuid not null references programs(id) on delete cascade,
      required_program_id uuid not null references programs(id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (program_id, required_program_id),
      check (program_id <> required_program_id)
    );
    create index program_prerequisites_required_idx on program_prerequisites (required_program_id);

    create table program_phases (
      id uuid primary key,
      program_id uuid not null references programs(id) on delete cascade,
      position integer not null check (position > 0),
      title text not null,
      summary text,
      unlock_rule jsonb,
      status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
      unpublished_changes boolean not null default true,
      first_published_at timestamptz,
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      updated_by uuid
    );
    create index program_phases_program_idx on program_phases (program_id, position);

    create table program_modules (
      id uuid primary key,
      program_id uuid not null references programs(id) on delete cascade,
      phase_id uuid not null references program_phases(id) on delete cascade,
      position integer not null check (position > 0),
      title text not null,
      summary text,
      unlock_rule jsonb,
      status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
      unpublished_changes boolean not null default true,
      first_published_at timestamptz,
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      updated_by uuid
    );
    create index program_modules_phase_idx on program_modules (phase_id, position);
    create index program_modules_program_idx on program_modules (program_id);

    -- The lesson type is validated by the application's lesson type registry, so adding a type
    -- does not require a migration.
    create table lessons (
      id uuid primary key,
      organization_id uuid not null,
      program_id uuid not null references programs(id) on delete cascade,
      module_id uuid not null references program_modules(id) on delete cascade,
      position integer not null check (position > 0),
      type text not null,
      title text not null,
      summary text,
      body text,
      config jsonb not null default '{}',
      is_required boolean not null default true,
      estimated_minutes integer not null default 0 check (estimated_minutes >= 0),
      unlock_rule jsonb,
      status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
      unpublished_changes boolean not null default true,
      first_published_at timestamptz,
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      updated_by uuid
    );
    create index lessons_module_idx on lessons (module_id, position);
    create index lessons_program_idx on lessons (program_id, status);
    create index lessons_org_title_idx on lessons (organization_id, lower(title));
    -- Lookups by referenced assessment / scenario / media asset.
    create index lessons_assessment_idx on lessons ((config->>'assessmentId')) where type in ('quiz', 'final_assessment');
    create index lessons_scenario_idx on lessons ((config->>'scenarioId')) where type in ('ai_simulation', 'scenario');
    create index lessons_media_idx on lessons ((config->>'mediaAssetId')) where config ? 'mediaAssetId';

    create table lesson_resources (
      id uuid primary key,
      lesson_id uuid not null references lessons(id) on delete cascade,
      position integer not null check (position > 0),
      title text not null,
      description text,
      kind text not null check (kind in ('link', 'media')),
      url text,
      media_asset_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      check ((kind = 'link' and url is not null) or (kind = 'media' and media_asset_id is not null))
    );
    create index lesson_resources_lesson_idx on lesson_resources (lesson_id, position);

    -- Immutable published snapshots; learners always see the latest one.
    create table program_versions (
      id uuid primary key,
      program_id uuid not null references programs(id),
      version integer not null check (version > 0),
      change_note text not null,
      snapshot jsonb not null,
      stats jsonb not null,
      published_by uuid,
      published_by_name text,
      published_at timestamptz not null default now(),
      unique (program_id, version)
    );
    create trigger program_versions_immutable before update or delete on program_versions
      for each row execute function reject_mutation();

    create table enrollments (
      id uuid primary key,
      organization_id uuid not null,
      program_id uuid not null references programs(id),
      user_id uuid not null,
      status text not null check (status in ('active', 'completed', 'withdrawn')),
      source text not null check (source in ('manual', 'rule', 'self')),
      assigned_by uuid,
      enrolled_at timestamptz not null,
      due_at timestamptz,
      started_at timestamptz,
      completed_at timestamptz,
      withdrawn_at timestamptz,
      withdrawn_by uuid,
      withdrawal_reason text,
      progress_percent numeric(5, 2) not null default 0 check (progress_percent between 0 and 100),
      required_total integer not null default 0,
      required_completed integer not null default 0,
      current_lesson_id uuid references lessons(id) on delete set null,
      current_phase_id uuid references program_phases(id) on delete set null,
      last_activity_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (program_id, user_id),
      check (status <> 'completed' or completed_at is not null),
      check (status <> 'withdrawn' or withdrawn_at is not null)
    );
    -- "My enrollments", team progress, org dashboards and the overdue sweep.
    create index enrollments_user_status_idx on enrollments (user_id, status);
    create index enrollments_program_status_idx on enrollments (program_id, status);
    create index enrollments_org_activity_idx on enrollments (organization_id, status, last_activity_at);
    create index enrollments_due_idx on enrollments (due_at) where status = 'active' and due_at is not null;

    create table lesson_progress (
      id uuid primary key,
      enrollment_id uuid not null references enrollments(id) on delete cascade,
      lesson_id uuid not null references lessons(id),
      user_id uuid not null,
      status text not null check (status in ('not_started', 'in_progress', 'completed')),
      percent numeric(5, 2) not null default 0 check (percent between 0 and 100),
      started_at timestamptz,
      completed_at timestamptz,
      completion_source text,
      completed_by uuid,
      data jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (enrollment_id, lesson_id),
      check (status <> 'completed' or (completed_at is not null and completion_source is not null))
    );
    create index lesson_progress_lesson_idx on lesson_progress (lesson_id, status);
    create index lesson_progress_user_idx on lesson_progress (user_id);

    -- One row per phase a learner completed: makes phase.completed exactly-once.
    create table phase_completions (
      enrollment_id uuid not null references enrollments(id) on delete cascade,
      phase_id uuid not null references program_phases(id),
      completed_at timestamptz not null,
      primary key (enrollment_id, phase_id)
    );

    create table lesson_notes (
      id uuid primary key,
      organization_id uuid not null,
      user_id uuid not null,
      lesson_id uuid not null references lessons(id),
      body text not null,
      video_timestamp_seconds integer check (video_timestamp_seconds >= 0),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index lesson_notes_user_lesson_idx on lesson_notes (user_id, lesson_id, created_at);
    create index lesson_notes_lesson_idx on lesson_notes (lesson_id);

    create table assignment_submissions (
      id uuid primary key,
      organization_id uuid not null,
      user_id uuid not null,
      enrollment_id uuid not null references enrollments(id) on delete cascade,
      lesson_id uuid not null references lessons(id),
      body text not null,
      word_count integer not null check (word_count >= 0),
      status text not null check (status in ('submitted', 'approved', 'rejected')),
      submitted_at timestamptz not null default now(),
      reviewed_by uuid,
      reviewed_by_name text,
      reviewed_at timestamptz,
      feedback text
    );
    create index assignment_submissions_enrollment_idx on assignment_submissions (enrollment_id, lesson_id, submitted_at desc);
    create index assignment_submissions_lesson_idx on assignment_submissions (lesson_id);

    create table approval_requests (
      id uuid primary key,
      organization_id uuid not null,
      kind text not null check (kind in ('manager_approval', 'assignment_review')),
      status text not null check (status in ('pending', 'approved', 'rejected')),
      enrollment_id uuid not null references enrollments(id) on delete cascade,
      program_id uuid not null references programs(id),
      lesson_id uuid not null references lessons(id),
      user_id uuid not null,
      submission_id uuid references assignment_submissions(id),
      request_note text,
      requested_at timestamptz not null default now(),
      decided_by uuid,
      decided_by_name text,
      decided_at timestamptz,
      comment text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check ((status = 'pending') = (decided_at is null)),
      check (kind <> 'assignment_review' or submission_id is not null)
    );
    -- At most one open request per learner and lesson.
    create unique index approval_requests_one_pending_uq on approval_requests (enrollment_id, lesson_id) where status = 'pending';
    create index approval_requests_queue_idx on approval_requests (organization_id, status, requested_at);
    create index approval_requests_user_idx on approval_requests (user_id, status);
    create index approval_requests_lesson_idx on approval_requests (lesson_id);

    create table acknowledgments (
      id uuid primary key,
      organization_id uuid not null,
      user_id uuid not null,
      enrollment_id uuid not null references enrollments(id),
      lesson_id uuid not null references lessons(id),
      statement_hash text not null,
      statement_text text not null,
      typed_name text not null,
      ip text,
      user_agent text,
      acknowledged_at timestamptz not null default now(),
      unique (enrollment_id, lesson_id)
    );
    create index acknowledgments_lesson_idx on acknowledgments (lesson_id);
    create trigger acknowledgments_immutable before update or delete on acknowledgments
      for each row execute function reject_mutation();

    -- Score projections fed by assessment-service and ai-coaching-service events. Per-attempt and
    -- per-session rows make redelivered or re-graded events idempotent; the score tables aggregate them.
    create table learner_assessment_attempts (
      attempt_id uuid primary key,
      organization_id uuid,
      user_id uuid not null,
      assessment_id uuid not null,
      assessment_title text not null,
      kind text not null,
      attempt_number integer not null,
      score_percent numeric(5, 2) not null,
      passed boolean not null,
      passing_percent numeric(5, 2) not null,
      lesson_id uuid,
      graded_at timestamptz not null,
      updated_at timestamptz not null default now()
    );
    create index learner_assessment_attempts_user_idx on learner_assessment_attempts (user_id, assessment_id);

    create table learner_assessment_scores (
      user_id uuid not null,
      assessment_id uuid not null,
      organization_id uuid,
      assessment_title text not null,
      kind text not null,
      best_score numeric(5, 2) not null,
      last_score numeric(5, 2) not null,
      passed boolean not null,
      attempts integer not null,
      last_attempt_at timestamptz not null,
      updated_at timestamptz not null default now(),
      primary key (user_id, assessment_id)
    );

    create table learner_ai_sessions (
      session_id uuid primary key,
      organization_id uuid,
      user_id uuid not null,
      scenario_id uuid not null,
      scenario_title text not null,
      score numeric(5, 2) not null,
      passed boolean not null,
      passing_score numeric(5, 2) not null,
      lesson_id uuid,
      evaluated_at timestamptz not null,
      updated_at timestamptz not null default now()
    );
    create index learner_ai_sessions_user_idx on learner_ai_sessions (user_id, evaluated_at desc);

    create table learner_ai_scores (
      user_id uuid not null,
      scenario_id uuid not null,
      organization_id uuid,
      scenario_title text not null,
      best_score numeric(5, 2) not null,
      last_score numeric(5, 2) not null,
      passed boolean not null,
      sessions integer not null,
      last_session_at timestamptz not null,
      updated_at timestamptz not null default now(),
      primary key (user_id, scenario_id)
    );

    -- Makes the daily enrollment.overdue notice idempotent per enrollment and day.
    create table enrollment_overdue_notices (
      enrollment_id uuid not null references enrollments(id) on delete cascade,
      notice_date date not null,
      created_at timestamptz not null default now(),
      primary key (enrollment_id, notice_date)
    );
  `.execute(db);

  for (const table of [
    'programs',
    'program_phases',
    'program_modules',
    'lessons',
    'lesson_resources',
    'enrollments',
    'lesson_progress',
    'lesson_notes',
    'approval_requests',
    'learner_assessment_attempts',
    'learner_assessment_scores',
    'learner_ai_sessions',
    'learner_ai_scores',
  ]) {
    await addUpdatedAtTrigger(db, table);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists enrollment_overdue_notices, learner_ai_scores, learner_ai_sessions,
      learner_assessment_scores, learner_assessment_attempts, acknowledgments, approval_requests,
      assignment_submissions, lesson_notes, phase_completions, lesson_progress, enrollments,
      program_versions, lesson_resources, lessons, program_modules, program_phases,
      program_prerequisites, program_audiences, programs,
      dir_units, dir_team_managers, dir_teams, dir_user_supervisors, dir_user_teams, dir_users,
      inbox_events, outbox_events cascade;
    drop function if exists reject_mutation();
    drop function if exists set_updated_at();
  `.execute(db);
}
