import {
  addUpdatedAtTrigger,
  createInboxTable,
  createOutboxTable,
  createUpdatedAtFunction,
  sql,
  type Kysely,
} from '@a5/database';
import { createDirectoryTables, dropDirectoryTables } from '@a5/directory';

export async function up(db: Kysely<unknown>): Promise<void> {
  await createUpdatedAtFunction(db);
  await createOutboxTable(db);
  await createInboxTable(db);
  await createDirectoryTables(db);

  await sql`
    -- Insert-only history (prompt versions, rubric versions, transcripts, scorecards, reviews).
    create or replace function ai_reject_mutation() returns trigger as $$
    begin
      raise exception '% rows are immutable; write a new row instead', tg_table_name
        using errcode = 'restrict_violation';
    end;
    $$ language plpgsql;

    create table ai_settings (
      organization_id uuid primary key,
      default_provider text not null default 'auto'
        check (default_provider in ('auto', 'anthropic', 'openai', 'dev_simulator')),
      conversation_model text,
      evaluation_model text,
      max_sessions_per_learner_per_day integer check (max_sessions_per_learner_per_day > 0),
      transcript_retention_days integer check (transcript_retention_days >= 30),
      timezone text not null default 'America/Chicago',
      updated_at timestamptz not null default now(),
      updated_by uuid
    );

    create table ai_personas (
      id uuid primary key,
      organization_id uuid not null,
      name text not null,
      description text not null,
      temperament text not null,
      speaking_style text not null,
      background text not null,
      traits jsonb not null default '[]',
      archived_at timestamptz,
      revision integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      updated_by uuid
    );
    create unique index ai_personas_org_name_uq on ai_personas (organization_id, lower(name)) where archived_at is null;

    create table ai_rubrics (
      id uuid primary key,
      organization_id uuid not null,
      title text not null,
      description text,
      current_version_id uuid not null,
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      updated_by uuid
    );
    create unique index ai_rubrics_org_title_uq on ai_rubrics (organization_id, lower(title)) where archived_at is null;

    create table ai_rubric_versions (
      id uuid primary key,
      rubric_id uuid not null references ai_rubrics(id),
      version integer not null,
      categories jsonb not null,
      passing_score integer not null check (passing_score between 0 and 100),
      change_note text,
      created_by uuid,
      created_at timestamptz not null default now(),
      unique (rubric_id, version)
    );
    alter table ai_rubrics add constraint ai_rubrics_current_version_fk
      foreign key (current_version_id) references ai_rubric_versions(id) deferrable initially deferred;

    create table ai_scenarios (
      id uuid primary key,
      organization_id uuid not null,
      title text not null,
      category text not null,
      difficulty text not null check (difficulty in ('beginner', 'intermediate', 'advanced', 'expert')),
      persona_id uuid not null references ai_personas(id),
      objection text not null,
      rep_brief text not null,
      background text not null,
      property_context text not null,
      trigger text not null,
      hidden_concern text not null,
      expected_behaviors text[] not null default '{}',
      required_talking_points text[] not null default '{}',
      forbidden_claims text[] not null default '{}',
      ai_instructions text not null default '',
      opening_line text not null,
      passing_score integer not null check (passing_score between 0 and 100),
      rubric_id uuid not null references ai_rubrics(id),
      max_turns integer not null check (max_turns between 2 and 60),
      provider text check (provider in ('anthropic', 'openai', 'dev_simulator')),
      model text,
      evaluation_model text,
      model_settings jsonb not null default '{}',
      status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
      current_prompt_version_id uuid,
      published_at timestamptz,
      archived_at timestamptz,
      revision integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      updated_by uuid
    );
    create unique index ai_scenarios_org_title_uq on ai_scenarios (organization_id, lower(title)) where status <> 'archived';
    create index ai_scenarios_catalog_idx on ai_scenarios (organization_id, status, category, difficulty);
    create index ai_scenarios_persona_idx on ai_scenarios (persona_id);
    create index ai_scenarios_rubric_idx on ai_scenarios (rubric_id);

    create table ai_prompt_versions (
      id uuid primary key,
      organization_id uuid not null,
      scenario_id uuid not null references ai_scenarios(id),
      version integer not null,
      homeowner_system_prompt text not null,
      evaluator_system_prompt text not null,
      persona_snapshot jsonb not null,
      scenario_snapshot jsonb not null,
      provider text check (provider in ('anthropic', 'openai', 'dev_simulator')),
      model text,
      model_settings jsonb not null default '{}',
      evaluation_model text,
      rubric_version_id uuid not null references ai_rubric_versions(id),
      content_hash text not null,
      change_note text,
      created_by uuid,
      created_at timestamptz not null default now(),
      unique (scenario_id, version)
    );
    alter table ai_scenarios add constraint ai_scenarios_current_prompt_version_fk
      foreign key (current_prompt_version_id) references ai_prompt_versions(id) deferrable initially deferred;

    create table ai_sessions (
      id uuid primary key,
      organization_id uuid not null,
      user_id uuid not null,
      scenario_id uuid not null references ai_scenarios(id),
      prompt_version_id uuid not null references ai_prompt_versions(id),
      rubric_version_id uuid not null references ai_rubric_versions(id),
      mode text not null check (mode in ('practice', 'assigned')),
      is_test boolean not null default false,
      context jsonb not null default '{}',
      modality text not null default 'text' check (modality in ('text', 'voice')),
      status text not null default 'active'
        check (status in ('active', 'ended', 'evaluating', 'evaluated', 'evaluation_failed', 'abandoned')),
      end_reason text check (end_reason in ('rep_ended', 'objective_reached', 'homeowner_ended', 'max_turns', 'timeout')),
      provider text not null check (provider in ('anthropic', 'openai', 'dev_simulator')),
      model text not null,
      max_turns integer not null check (max_turns > 0),
      turn_count integer not null default 0,
      started_at timestamptz not null default now(),
      ended_at timestamptz,
      last_activity_at timestamptz not null default now(),
      evaluation_attempts integer not null default 0,
      evaluation_error text,
      transcript_purged_at timestamptz,
      updated_at timestamptz not null default now(),
      check ((status = 'active') = (ended_at is null))
    );
    create index ai_sessions_user_started_idx on ai_sessions (user_id, started_at desc);
    create index ai_sessions_org_started_idx on ai_sessions (organization_id, started_at desc);
    create index ai_sessions_scenario_idx on ai_sessions (scenario_id, started_at desc);
    create index ai_sessions_prompt_version_idx on ai_sessions (prompt_version_id);
    create index ai_sessions_active_idx on ai_sessions (last_activity_at) where status = 'active';
    create index ai_sessions_pending_evaluation_idx on ai_sessions (ended_at) where status in ('ended', 'evaluating');

    create table ai_messages (
      id uuid primary key,
      session_id uuid not null references ai_sessions(id),
      organization_id uuid not null,
      seq integer not null check (seq > 0),
      role text not null check (role in ('homeowner', 'rep')),
      content text not null,
      modality text not null default 'text' check (modality in ('text', 'voice')),
      audio_ref text,
      client_message_id uuid,
      provider text,
      model text,
      input_tokens integer,
      output_tokens integer,
      latency_ms integer,
      created_at timestamptz not null default now(),
      unique (session_id, seq)
    );
    create unique index ai_messages_client_message_uq on ai_messages (session_id, client_message_id)
      where client_message_id is not null;

    create table ai_evaluations (
      id uuid primary key,
      session_id uuid not null unique references ai_sessions(id),
      organization_id uuid not null,
      user_id uuid not null,
      scenario_id uuid not null,
      is_test boolean not null default false,
      overall_score integer not null check (overall_score between 0 and 100),
      passed boolean not null,
      passing_score integer not null,
      category_scores jsonb not null,
      strengths jsonb not null,
      missed_opportunities jsonb not null,
      questions_to_ask jsonb not null,
      risky_statements jsonb not null,
      recommended_responses jsonb not null,
      next_goal text not null,
      summary text not null,
      provider text not null,
      model text not null,
      prompt_version_id uuid not null references ai_prompt_versions(id),
      rubric_version_id uuid not null references ai_rubric_versions(id),
      raw jsonb not null,
      created_at timestamptz not null default now()
    );
    create index ai_evaluations_org_created_idx on ai_evaluations (organization_id, created_at desc);
    create index ai_evaluations_user_idx on ai_evaluations (user_id, created_at desc);
    create index ai_evaluations_scenario_idx on ai_evaluations (scenario_id, overall_score);

    create table ai_evaluation_scores (
      evaluation_id uuid not null references ai_evaluations(id),
      session_id uuid not null,
      organization_id uuid not null,
      user_id uuid not null,
      scenario_id uuid not null,
      category_key text not null,
      category_label text not null,
      score integer not null check (score between 0 and 100),
      weight numeric(6, 2) not null,
      is_test boolean not null default false,
      evaluated_at timestamptz not null,
      primary key (evaluation_id, category_key)
    );
    create index ai_evaluation_scores_category_idx on ai_evaluation_scores (organization_id, category_key, evaluated_at);
    create index ai_evaluation_scores_user_idx on ai_evaluation_scores (user_id, category_key);

    create table ai_session_reviews (
      id uuid primary key,
      session_id uuid not null references ai_sessions(id),
      organization_id uuid not null,
      reviewer_id uuid not null,
      comment text not null,
      recommendation text not null check (recommendation in ('ready', 'practice_again', 'retrain')),
      created_at timestamptz not null default now()
    );
    create index ai_session_reviews_session_idx on ai_session_reviews (session_id, created_at);
    create index ai_session_reviews_reviewer_idx on ai_session_reviews (reviewer_id, created_at desc);

    create table ai_usage (
      id uuid primary key,
      organization_id uuid not null,
      user_id uuid,
      session_id uuid,
      scenario_id uuid,
      purpose text not null check (purpose in ('conversation', 'evaluation')),
      is_test boolean not null default false,
      provider text not null,
      model text not null,
      input_tokens integer not null default 0,
      output_tokens integer not null default 0,
      cache_read_tokens integer not null default 0,
      cache_write_tokens integer not null default 0,
      estimated_cost_usd numeric(14, 6) not null default 0,
      priced boolean not null default true,
      latency_ms integer not null default 0,
      success boolean not null,
      error_code text,
      created_at timestamptz not null default now()
    );
    create index ai_usage_org_created_idx on ai_usage (organization_id, created_at);
    create index ai_usage_session_idx on ai_usage (session_id);

    create trigger ai_rubric_versions_immutable before update or delete on ai_rubric_versions
      for each row execute function ai_reject_mutation();
    create trigger ai_prompt_versions_immutable before update or delete on ai_prompt_versions
      for each row execute function ai_reject_mutation();
    -- Messages may be deleted by the transcript retention policy, never edited.
    create trigger ai_messages_immutable before update on ai_messages
      for each row execute function ai_reject_mutation();
    create trigger ai_evaluations_immutable before update or delete on ai_evaluations
      for each row execute function ai_reject_mutation();
    create trigger ai_evaluation_scores_immutable before update or delete on ai_evaluation_scores
      for each row execute function ai_reject_mutation();
    create trigger ai_session_reviews_immutable before update or delete on ai_session_reviews
      for each row execute function ai_reject_mutation();
  `.execute(db);

  for (const table of ['ai_settings', 'ai_personas', 'ai_rubrics', 'ai_scenarios', 'ai_sessions']) {
    await addUpdatedAtTrigger(db, table);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists ai_usage, ai_session_reviews, ai_evaluation_scores, ai_evaluations, ai_messages, ai_sessions,
      ai_prompt_versions, ai_scenarios, ai_rubric_versions, ai_rubrics, ai_personas, ai_settings cascade;
    drop function if exists ai_reject_mutation();
  `.execute(db);
  await dropDirectoryTables(db);
  await sql`
    drop table if exists inbox_events, outbox_events cascade;
    drop function if exists set_updated_at();
  `.execute(db);
}
