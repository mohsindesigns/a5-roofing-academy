import {
  addUpdatedAtTrigger,
  createInboxTable,
  createOutboxTable,
  createUpdatedAtFunction,
  sql,
  type Kysely,
} from '@a5/database';
import { createDirectoryTables, dropDirectoryTables } from '@a5/directory';

/**
 * Custom SQLSTATE codes raised by the integrity triggers below (mapped to API errors in
 * `common/db-errors.ts`):
 * - A5I01: row of an insert-only table cannot change
 * - A5A01: answers of an attempt that left `in_progress` cannot change
 * - A5A02: a graded attempt (or its grading) is final
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await createUpdatedAtFunction(db);
  await createOutboxTable(db);
  await createInboxTable(db);
  await createDirectoryTables(db);

  await sql`
    create table question_banks (
      id uuid primary key,
      organization_id uuid not null,
      title text not null,
      description text,
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      updated_by uuid
    );
    create unique index question_banks_org_title_uq on question_banks (organization_id, lower(title));

    create table question_categories (
      id uuid primary key,
      organization_id uuid not null,
      bank_id uuid not null references question_banks(id) on delete cascade,
      name text not null,
      description text,
      position integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index question_categories_bank_name_uq on question_categories (bank_id, lower(name));

    create table competencies (
      id uuid primary key,
      organization_id uuid not null,
      bank_id uuid not null references question_banks(id) on delete cascade,
      name text not null,
      description text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index competencies_bank_name_uq on competencies (bank_id, lower(name));

    create table questions (
      id uuid primary key,
      organization_id uuid not null,
      bank_id uuid not null references question_banks(id),
      status text not null default 'active' check (status in ('active', 'archived')),
      current_version_id uuid not null,
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      updated_by uuid,
      check ((status = 'archived') = (archived_at is not null))
    );
    create index questions_bank_status_idx on questions (bank_id, status);
    create index questions_org_updated_idx on questions (organization_id, updated_at desc);

    create table question_versions (
      id uuid primary key,
      question_id uuid not null references questions(id),
      organization_id uuid not null,
      version integer not null check (version >= 1),
      type text not null check (type in ('multiple_choice', 'multiple_select', 'true_false', 'short_answer',
        'long_answer', 'scenario', 'ordering', 'matching')),
      prompt text not null,
      config jsonb not null,
      explanation text,
      points numeric(7, 2) not null check (points > 0),
      difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
      category_id uuid references question_categories(id),
      competency_ids uuid[] not null default '{}',
      tags text[] not null default '{}',
      change_note text,
      created_at timestamptz not null default now(),
      created_by uuid,
      unique (question_id, version),
      unique (id, question_id)
    );
    create index question_versions_category_idx on question_versions (category_id);
    create index question_versions_tags_idx on question_versions using gin (tags);
    create index question_versions_competencies_idx on question_versions using gin (competency_ids);

    -- The current version must be a version of the same question. Deferred so a question and its
    -- first version can be inserted in one transaction.
    alter table questions add constraint questions_current_version_fk
      foreign key (current_version_id, id) references question_versions (id, question_id)
      deferrable initially deferred;

    create table assessments (
      id uuid primary key,
      organization_id uuid not null,
      title text not null,
      description text,
      kind text not null check (kind in ('quiz', 'exam', 'final', 'practice')),
      status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
      config jsonb not null,
      revision integer not null default 1,
      published_at timestamptz,
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      updated_by uuid
    );
    create index assessments_org_status_idx on assessments (organization_id, status, updated_at desc);

    create table assessment_items (
      id uuid primary key,
      assessment_id uuid not null references assessments(id) on delete cascade,
      position integer not null check (position >= 1),
      kind text not null check (kind in ('question', 'pool')),
      question_id uuid references questions(id),
      pool_bank_id uuid references question_banks(id),
      pool_category_id uuid references question_categories(id),
      pool_difficulty text check (pool_difficulty in ('easy', 'medium', 'hard')),
      pool_tags text[] not null default '{}',
      pool_count integer check (pool_count >= 1),
      points numeric(7, 2) check (points > 0),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint assessment_items_position_uq unique (assessment_id, position) deferrable initially deferred,
      constraint assessment_items_shape_ck check (
        (kind = 'question' and question_id is not null and pool_bank_id is null and pool_category_id is null
          and pool_difficulty is null and pool_count is null and cardinality(pool_tags) = 0)
        or (kind = 'pool' and question_id is null and pool_bank_id is not null and pool_count is not null)
      )
    );
    create unique index assessment_items_question_uq on assessment_items (assessment_id, question_id)
      where question_id is not null;
    create index assessment_items_question_idx on assessment_items (question_id) where question_id is not null;
    create index assessment_items_pool_bank_idx on assessment_items (pool_bank_id) where pool_bank_id is not null;
    create index assessment_items_pool_category_idx on assessment_items (pool_category_id)
      where pool_category_id is not null;

    create table attempts (
      id uuid primary key,
      organization_id uuid not null,
      assessment_id uuid not null references assessments(id),
      user_id uuid not null,
      attempt_number integer not null check (attempt_number >= 1),
      status text not null check (status in ('in_progress', 'submitted', 'pending_review', 'graded', 'expired')),
      context jsonb not null default '{}',
      config jsonb not null,
      started_at timestamptz not null,
      expires_at timestamptz,
      submitted_at timestamptz,
      graded_at timestamptz,
      auto_submitted boolean not null default false,
      max_points numeric(9, 2) not null check (max_points > 0),
      score_points numeric(9, 2),
      score_percent numeric(5, 2) check (score_percent between 0 and 100),
      passed boolean,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint attempts_number_uq unique (assessment_id, user_id, attempt_number),
      constraint attempts_submitted_ck check (status = 'in_progress' or submitted_at is not null),
      constraint attempts_graded_ck check (
        status <> 'graded' or (graded_at is not null and score_points is not null and score_percent is not null
          and passed is not null)
      ),
      check (expires_at is null or expires_at > started_at)
    );
    -- At most one open attempt per learner and assessment (resume instead of starting another).
    create unique index attempts_one_open_uq on attempts (assessment_id, user_id) where status = 'in_progress';
    create index attempts_user_idx on attempts (user_id, assessment_id, attempt_number desc);
    create index attempts_org_submitted_idx on attempts (organization_id, submitted_at desc);
    create index attempts_assessment_status_idx on attempts (assessment_id, status);
    create index attempts_expiry_idx on attempts (expires_at) where status = 'in_progress' and expires_at is not null;
    create index attempts_ungraded_idx on attempts (submitted_at) where status in ('submitted', 'expired');
    create index attempts_pending_review_idx on attempts (organization_id, submitted_at) where status = 'pending_review';

    create table attempt_questions (
      id uuid primary key,
      attempt_id uuid not null references attempts(id),
      position integer not null check (position >= 1),
      item_id uuid,
      question_id uuid not null references questions(id),
      question_version_id uuid not null,
      option_order jsonb not null default '{}',
      points numeric(7, 2) not null check (points > 0),
      unique (attempt_id, position),
      unique (attempt_id, question_id),
      foreign key (question_version_id, question_id) references question_versions (id, question_id)
    );
    create index attempt_questions_question_idx on attempt_questions (question_id);
    create index attempt_questions_version_idx on attempt_questions (question_version_id);

    create table attempt_answers (
      id uuid primary key,
      attempt_id uuid not null references attempts(id),
      attempt_question_id uuid not null unique references attempt_questions(id),
      response jsonb,
      saved_at timestamptz,
      client_sequence bigint,
      needs_review boolean not null default false,
      is_correct boolean,
      awarded_points numeric(7, 2) check (awarded_points >= 0),
      feedback text,
      graded_by uuid,
      graded_by_name text,
      graded_at timestamptz
    );
    create index attempt_answers_attempt_idx on attempt_answers (attempt_id);
    create index attempt_answers_open_review_idx on attempt_answers (attempt_id) where needs_review and graded_at is null;

    create table score_overrides (
      id uuid primary key,
      organization_id uuid not null,
      attempt_id uuid not null references attempts(id),
      previous_score_percent numeric(5, 2) not null,
      previous_passed boolean not null,
      new_score_percent numeric(5, 2) not null check (new_score_percent between 0 and 100),
      new_passed boolean not null,
      reason text not null check (length(reason) >= 10),
      actor_id uuid not null,
      actor_name text not null,
      created_at timestamptz not null default now()
    );
    create index score_overrides_attempt_idx on score_overrides (attempt_id, created_at desc, id desc);
  `.execute(db);

  for (const table of [
    'question_banks',
    'question_categories',
    'competencies',
    'questions',
    'assessments',
    'assessment_items',
    'attempts',
  ]) {
    await addUpdatedAtTrigger(db, table);
  }

  // ---------------------------------------------------------------- integrity triggers
  await sql`
    create function reject_row_change() returns trigger as $$
    begin
      raise exception '% rows are immutable', tg_table_name using errcode = 'A5I01';
    end;
    $$ language plpgsql;

    create trigger question_versions_immutable before update or delete on question_versions
      for each row execute function reject_row_change();
    create trigger attempt_questions_immutable before update or delete on attempt_questions
      for each row execute function reject_row_change();
    create trigger score_overrides_immutable before update or delete on score_overrides
      for each row execute function reject_row_change();

    -- Answers can change only while the attempt is in progress. Afterwards only grading fields may
    -- change (automatic grading and manual review), and once the attempt is graded nothing may.
    create function guard_attempt_answers() returns trigger as $$
    declare
      attempt_status text;
    begin
      if tg_op = 'DELETE' then
        raise exception 'attempt answers are permanent records' using errcode = 'A5I01';
      end if;
      select status into attempt_status from attempts where id = new.attempt_id;
      if tg_op = 'INSERT' then
        if attempt_status is distinct from 'in_progress' then
          raise exception 'answers cannot be added to an attempt that is %', attempt_status using errcode = 'A5A01';
        end if;
        return new;
      end if;
      if new.attempt_id <> old.attempt_id or new.attempt_question_id <> old.attempt_question_id or new.id <> old.id then
        raise exception 'answers cannot move between attempts or questions' using errcode = 'A5I01';
      end if;
      if attempt_status = 'in_progress' then
        if new.needs_review is distinct from old.needs_review or new.is_correct is distinct from old.is_correct
          or new.awarded_points is distinct from old.awarded_points or new.feedback is distinct from old.feedback
          or new.graded_by is distinct from old.graded_by or new.graded_at is distinct from old.graded_at then
          raise exception 'answers cannot be graded before the attempt is submitted' using errcode = 'A5A01';
        end if;
        return new;
      end if;
      if new.response is distinct from old.response or new.saved_at is distinct from old.saved_at
        or new.client_sequence is distinct from old.client_sequence then
        raise exception 'answers of a % attempt cannot be changed', attempt_status using errcode = 'A5A01';
      end if;
      if attempt_status = 'graded' then
        raise exception 'grading of a graded attempt is final; record a score override instead' using errcode = 'A5A02';
      end if;
      return new;
    end;
    $$ language plpgsql;

    create trigger attempt_answers_guard before insert or update or delete on attempt_answers
      for each row execute function guard_attempt_answers();

    -- Attempts are permanent; identity never changes, a closed attempt never reopens and a graded
    -- attempt's result is final (overrides are separate rows).
    create function guard_attempts() returns trigger as $$
    begin
      if tg_op = 'DELETE' then
        raise exception 'attempts are permanent records' using errcode = 'A5I01';
      end if;
      if new.id <> old.id or new.organization_id <> old.organization_id or new.assessment_id <> old.assessment_id
        or new.user_id <> old.user_id or new.attempt_number <> old.attempt_number or new.started_at <> old.started_at
        or new.config <> old.config or new.context <> old.context or new.max_points <> old.max_points then
        raise exception 'attempt identity and snapshot cannot change' using errcode = 'A5I01';
      end if;
      if old.status <> 'in_progress' and new.status = 'in_progress' then
        raise exception 'a closed attempt cannot be reopened' using errcode = 'A5A01';
      end if;
      if old.status = 'graded' and (new.status, new.submitted_at, new.graded_at, new.score_points, new.score_percent,
          new.passed, new.auto_submitted, new.expires_at)
          is distinct from (old.status, old.submitted_at, old.graded_at, old.score_points, old.score_percent,
          old.passed, old.auto_submitted, old.expires_at) then
        raise exception 'a graded attempt is final; record a score override instead' using errcode = 'A5A02';
      end if;
      return new;
    end;
    $$ language plpgsql;

    create trigger attempts_guard before update or delete on attempts
      for each row execute function guard_attempts();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists score_overrides, attempt_answers, attempt_questions, attempts, assessment_items,
      assessments cascade;
    alter table if exists questions drop constraint if exists questions_current_version_fk;
    drop table if exists question_versions, questions, competencies, question_categories, question_banks cascade;
    drop function if exists guard_attempts();
    drop function if exists guard_attempt_answers();
    drop function if exists reject_row_change();
    drop table if exists inbox_events, outbox_events cascade;
    drop function if exists set_updated_at();
  `.execute(db);
  await dropDirectoryTables(db);
}
