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
    -- Immutable history: snapshots, template versions and the certificate timeline are insert-only.
    create or replace function reject_mutation() returns trigger as $$
    begin
      raise exception '% rows are immutable', tg_table_name using errcode = 'restrict_violation';
    end;
    $$ language plpgsql;

    create table certification_settings (
      organization_id uuid primary key,
      organization_code text check (organization_code ~ '^[A-Z0-9]{1,10}$'),
      verification_base_url text,
      recipient_name_display text not null default 'full_name'
        check (recipient_name_display in ('full_name', 'first_name_last_initial')),
      show_certificate_number boolean not null default true,
      show_expiration_date boolean not null default true,
      timezone text not null default 'America/Chicago',
      updated_at timestamptz not null default now(),
      updated_by uuid
    );

    create table certification_assets (
      id uuid primary key,
      organization_id uuid not null,
      purpose text not null check (purpose in ('signature', 'stamp', 'background', 'logo', 'badge')),
      storage_key text not null unique,
      content_type text not null check (content_type in ('image/png', 'image/jpeg')),
      byte_size integer not null check (byte_size > 0),
      width integer not null,
      height integer not null,
      sha256 text not null,
      original_filename text,
      created_at timestamptz not null default now(),
      created_by uuid,
      created_by_name text
    );
    create index certification_assets_org_idx on certification_assets (organization_id, purpose, created_at desc);

    create table certificate_templates (
      id uuid primary key,
      organization_id uuid not null,
      name text not null,
      description text,
      status text not null default 'active' check (status in ('active', 'archived')),
      is_default boolean not null default false,
      current_version integer not null default 0,
      cloned_from_id uuid references certificate_templates(id),
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      created_by_name text,
      updated_by uuid,
      updated_by_name text,
      check (not (is_default and status = 'archived'))
    );
    create unique index certificate_templates_org_name_uq on certificate_templates (organization_id, lower(name)) where status = 'active';
    create unique index certificate_templates_default_uq on certificate_templates (organization_id) where is_default;

    create table certificate_template_versions (
      id uuid primary key,
      template_id uuid not null references certificate_templates(id),
      version integer not null check (version > 0),
      design jsonb not null,
      change_note text,
      created_at timestamptz not null default now(),
      created_by uuid,
      created_by_name text,
      unique (template_id, version)
    );
    create trigger certificate_template_versions_immutable before update or delete on certificate_template_versions
      for each row execute function reject_mutation();

    create table signatories (
      id uuid primary key,
      organization_id uuid not null,
      user_id uuid,
      name text not null,
      title text not null,
      department text,
      active boolean not null default true,
      effective_from date,
      effective_to date,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      created_by_name text,
      updated_by uuid,
      updated_by_name text,
      check (effective_from is null or effective_to is null or effective_from <= effective_to)
    );
    create index signatories_org_idx on signatories (organization_id, active, name);

    create table signatory_signatures (
      id uuid primary key,
      signatory_id uuid not null references signatories(id),
      version integer not null check (version > 0),
      asset_id uuid not null references certification_assets(id),
      created_at timestamptz not null default now(),
      created_by uuid,
      created_by_name text,
      unique (signatory_id, version)
    );

    create table stamps (
      id uuid primary key,
      organization_id uuid not null,
      name text not null,
      kind text not null check (kind in ('company', 'certification', 'department')),
      department_name text,
      active boolean not null default true,
      effective_from date,
      effective_to date,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      created_by_name text,
      updated_by uuid,
      updated_by_name text,
      check (effective_from is null or effective_to is null or effective_from <= effective_to)
    );
    create index stamps_org_idx on stamps (organization_id, active, name);

    create table stamp_images (
      id uuid primary key,
      stamp_id uuid not null references stamps(id),
      version integer not null check (version > 0),
      asset_id uuid not null references certification_assets(id),
      created_at timestamptz not null default now(),
      created_by uuid,
      created_by_name text,
      unique (stamp_id, version)
    );

    create table certification_definitions (
      id uuid primary key,
      organization_id uuid not null,
      name text not null,
      code text not null,
      public_description text,
      status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
      validity_policy jsonb not null,
      renewal_policy jsonb not null,
      eligibility_rule jsonb not null,
      approval_policy text not null check (approval_policy in ('none', 'manager', 'trainer', 'manual_review')),
      automatic_issuance boolean not null default true,
      issuing_organization_name text not null,
      template_id uuid references certificate_templates(id),
      stamp_id uuid references stamps(id),
      badge jsonb not null,
      public_verification_enabled boolean not null default true,
      number_pattern text not null,
      custom_variables jsonb not null default '[]',
      revision integer not null default 1,
      activated_at timestamptz,
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      created_by_name text,
      updated_by uuid,
      updated_by_name text
    );
    create unique index certification_definitions_org_code_uq on certification_definitions (organization_id, lower(code));
    create index certification_definitions_org_status_idx on certification_definitions (organization_id, status);

    create table certification_programs (
      definition_id uuid not null references certification_definitions(id) on delete cascade,
      program_id uuid not null,
      primary key (definition_id, program_id)
    );
    create index certification_programs_program_idx on certification_programs (program_id);

    create table certification_signatory_slots (
      definition_id uuid not null references certification_definitions(id) on delete cascade,
      slot smallint not null check (slot in (1, 2)),
      signatory_id uuid not null references signatories(id),
      primary key (definition_id, slot),
      unique (definition_id, signatory_id)
    );

    create table signatory_certifications (
      signatory_id uuid not null references signatories(id) on delete cascade,
      definition_id uuid not null references certification_definitions(id) on delete cascade,
      primary key (signatory_id, definition_id)
    );

    create table stamp_certifications (
      stamp_id uuid not null references stamps(id) on delete cascade,
      definition_id uuid not null references certification_definitions(id) on delete cascade,
      primary key (stamp_id, definition_id)
    );

    -- Certificate numbers only grow: UPDATE ... RETURNING inside the issuance transaction.
    create table certificate_number_sequences (
      definition_id uuid primary key references certification_definitions(id),
      last_value bigint not null default 0 check (last_value >= 0),
      updated_at timestamptz not null default now()
    );

    -- Fact projections fed by learning, assessment and AI events.
    create table program_catalog (
      program_id uuid primary key,
      organization_id uuid,
      title text not null,
      version integer not null,
      phases jsonb not null default '[]',
      archived boolean not null default false,
      updated_at timestamptz not null default now()
    );

    create table program_assessments (
      program_id uuid not null,
      assessment_id uuid not null,
      lesson_id uuid,
      kind text not null check (kind in ('quiz', 'exam', 'final', 'practice')),
      required boolean not null,
      title text not null,
      primary key (program_id, assessment_id)
    );
    create index program_assessments_assessment_idx on program_assessments (assessment_id);

    create table learner_program_status (
      user_id uuid not null,
      program_id uuid not null,
      organization_id uuid not null,
      enrollment_id uuid,
      status text not null check (status in ('enrolled', 'completed', 'withdrawn')),
      progress_percent numeric(5, 2) not null default 0,
      enrolled_at timestamptz,
      completed_at timestamptz,
      source_occurred_at timestamptz not null,
      updated_at timestamptz not null default now(),
      primary key (user_id, program_id)
    );
    create index learner_program_status_program_idx on learner_program_status (program_id, status);

    create table learner_milestones (
      user_id uuid not null,
      kind text not null check (kind in ('lesson', 'phase')),
      ref_id uuid not null,
      program_id uuid,
      title text,
      completed_at timestamptz not null,
      primary key (user_id, kind, ref_id)
    );

    create table learner_assessment_results (
      attempt_id uuid primary key,
      user_id uuid not null,
      organization_id uuid not null,
      assessment_id uuid not null,
      kind text not null check (kind in ('quiz', 'exam', 'final', 'practice')),
      title text not null,
      score_percent numeric(5, 2) not null,
      passed boolean not null,
      program_id uuid,
      graded_at timestamptz not null
    );
    create index learner_assessment_results_user_idx on learner_assessment_results (user_id, assessment_id, graded_at);

    create table learner_ai_results (
      session_id uuid primary key,
      user_id uuid not null,
      organization_id uuid not null,
      scenario_id uuid not null,
      scenario_title text not null,
      overall_score numeric(5, 2) not null,
      passed boolean not null,
      program_id uuid,
      evaluated_at timestamptz not null
    );
    create index learner_ai_results_user_idx on learner_ai_results (user_id, evaluated_at desc);

    create table certification_candidates (
      id uuid primary key,
      organization_id uuid not null,
      definition_id uuid not null references certification_definitions(id),
      user_id uuid not null,
      status text not null default 'in_progress'
        check (status in ('in_progress', 'eligible', 'pending_approval', 'approved', 'rejected', 'issued')),
      purpose text not null default 'initial' check (purpose in ('initial', 'renewal')),
      cycle integer not null default 1,
      renewal_id uuid,
      requirements jsonb not null default '[]',
      met_count integer not null default 0,
      total_count integer not null default 0,
      auto_requirements_met boolean not null default false,
      evaluated_at timestamptz,
      eligible_at timestamptz,
      eligible_cycle integer,
      rejected_at timestamptz,
      hold_reason text,
      held_at timestamptz,
      issue_error text,
      certificate_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (definition_id, user_id)
    );
    create index certification_candidates_org_status_idx on certification_candidates (organization_id, status);
    create index certification_candidates_user_idx on certification_candidates (user_id);

    -- Transactional work list: (definition, user) pairs whose facts changed and need evaluation.
    create table eligibility_dirty (
      definition_id uuid not null,
      user_id uuid not null,
      organization_id uuid not null,
      marked_at timestamptz not null default clock_timestamp(),
      learner_activity boolean not null default false,
      primary key (definition_id, user_id)
    );
    create index eligibility_dirty_marked_idx on eligibility_dirty (marked_at);

    create table certificate_approvals (
      id uuid primary key,
      organization_id uuid not null,
      candidate_id uuid not null references certification_candidates(id),
      definition_id uuid not null references certification_definitions(id),
      user_id uuid not null,
      cycle integer not null,
      kind text not null check (kind in ('manager', 'trainer', 'manual_review')),
      status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
      requested_at timestamptz not null default now(),
      decided_at timestamptz,
      decided_by uuid,
      decided_by_name text,
      comment text,
      unique (candidate_id, cycle)
    );
    create index certificate_approvals_org_status_idx on certificate_approvals (organization_id, status, requested_at);
    create index certificate_approvals_user_idx on certificate_approvals (user_id);

    create table issued_certificates (
      id uuid primary key,
      organization_id uuid not null,
      definition_id uuid not null references certification_definitions(id),
      user_id uuid not null,
      candidate_id uuid references certification_candidates(id),
      certificate_number text not null,
      verification_token text not null check (length(verification_token) >= 32),
      status text not null check (status in ('issued', 'expired', 'revoked', 'superseded')),
      mode text not null check (mode in ('automatic', 'manual', 'approval', 'reissue', 'renewal')),
      issued_at timestamptz not null,
      expires_at timestamptz,
      issued_by uuid,
      issued_by_name text,
      override_reason text,
      template_id uuid not null references certificate_templates(id),
      template_version_id uuid not null references certificate_template_versions(id),
      pdf_status text not null default 'pending' check (pdf_status in ('pending', 'ready', 'failed')),
      pdf_storage_key text,
      pdf_sha256 text,
      pdf_byte_size integer,
      pdf_generated_at timestamptz,
      pdf_attempts integer not null default 0,
      pdf_error text,
      expired_at timestamptz,
      revoked_at timestamptz,
      superseded_at timestamptz,
      superseded_by_id uuid references issued_certificates(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (expires_at is null or expires_at > issued_at)
    );
    create unique index issued_certificates_number_uq on issued_certificates (certificate_number);
    create unique index issued_certificates_token_uq on issued_certificates (verification_token);
    -- One active certificate per person and certification.
    create unique index issued_certificates_one_active_uq on issued_certificates (definition_id, user_id) where status = 'issued';
    create index issued_certificates_expiry_idx on issued_certificates (expires_at) where status = 'issued';
    create index issued_certificates_user_idx on issued_certificates (user_id, issued_at desc);
    create index issued_certificates_org_idx on issued_certificates (organization_id, issued_at desc);
    create index issued_certificates_pdf_pending_idx on issued_certificates (created_at) where pdf_status = 'pending';

    create table certificate_snapshots (
      certificate_id uuid primary key references issued_certificates(id),
      schema_version integer not null,
      data jsonb not null,
      created_at timestamptz not null default now()
    );
    create trigger certificate_snapshots_immutable before update or delete on certificate_snapshots
      for each row execute function reject_mutation();

    create table certificate_revocations (
      id uuid primary key,
      certificate_id uuid not null unique references issued_certificates(id),
      reason text not null,
      public_note text,
      revoked_at timestamptz not null,
      revoked_by uuid,
      revoked_by_name text
    );
    create index certificate_revocations_time_idx on certificate_revocations (revoked_at desc);

    create table certificate_reissues (
      id uuid primary key,
      original_certificate_id uuid not null unique references issued_certificates(id),
      new_certificate_id uuid not null unique references issued_certificates(id),
      reason_code text not null check (reason_code in ('corrected_name', 'corrected_data', 'administrative')),
      note text not null,
      reissued_at timestamptz not null,
      reissued_by uuid,
      reissued_by_name text
    );

    create table certificate_renewals (
      id uuid primary key,
      organization_id uuid not null,
      certificate_id uuid not null unique references issued_certificates(id),
      definition_id uuid not null references certification_definitions(id),
      user_id uuid not null,
      status text not null check (status in ('open', 'completed', 'lapsed', 'cancelled')),
      window_opened_at timestamptz not null,
      due_at timestamptz,
      completed_at timestamptz,
      new_certificate_id uuid references issued_certificates(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index certificate_renewals_org_status_idx on certificate_renewals (organization_id, status, due_at);

    create table certificate_reminders (
      certificate_id uuid not null references issued_certificates(id),
      offset_days integer not null,
      days_remaining integer not null,
      sent boolean not null,
      created_at timestamptz not null default now(),
      primary key (certificate_id, offset_days)
    );

    create table certificate_events (
      id uuid primary key,
      organization_id uuid not null,
      certificate_id uuid not null references issued_certificates(id),
      type text not null,
      actor_id uuid,
      actor_name text,
      data jsonb not null default '{}',
      occurred_at timestamptz not null default now()
    );
    create index certificate_events_certificate_idx on certificate_events (certificate_id, occurred_at);
    create trigger certificate_events_immutable before update or delete on certificate_events
      for each row execute function reject_mutation();
  `.execute(db);

  for (const table of [
    'certification_settings',
    'certificate_templates',
    'signatories',
    'stamps',
    'certification_definitions',
    'certificate_number_sequences',
    'program_catalog',
    'learner_program_status',
    'certification_candidates',
    'issued_certificates',
    'certificate_renewals',
  ]) {
    await addUpdatedAtTrigger(db, table);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists certificate_events, certificate_reminders, certificate_renewals, certificate_reissues,
      certificate_revocations, certificate_snapshots, issued_certificates, certificate_approvals, eligibility_dirty,
      certification_candidates, learner_ai_results, learner_assessment_results, learner_milestones,
      learner_program_status, program_assessments, program_catalog, certificate_number_sequences,
      stamp_certifications, signatory_certifications, certification_signatory_slots, certification_programs,
      certification_definitions, stamp_images, stamps, signatory_signatures, signatories,
      certificate_template_versions, certificate_templates, certification_assets, certification_settings,
      outbox_events, inbox_events cascade;
    drop function if exists reject_mutation();
    drop function if exists set_updated_at();
  `.execute(db);
  await dropDirectoryTables(db);
}
