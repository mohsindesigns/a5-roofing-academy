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
    create table notification_templates (
      id uuid primary key,
      organization_id uuid not null,
      type text not null,
      channel text not null check (channel in ('in_app', 'email')),
      subject text not null check (length(subject) between 1 and 200),
      body text not null check (length(body) between 1 and 5000),
      enabled boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      updated_by uuid,
      constraint notification_templates_type_channel_uq unique (organization_id, type, channel)
    );

    create table notification_rules (
      id uuid primary key,
      organization_id uuid not null,
      key text not null,
      event_type text not null,
      notification_type text not null,
      recipients text[] not null check (cardinality(recipients) between 1 and 10),
      channels text[] not null check (cardinality(channels) between 1 and 2 and channels <@ array['in_app', 'email']),
      conditions jsonb not null default '{}' check (jsonb_typeof(conditions) = 'object'),
      delay_minutes integer not null default 0 check (delay_minutes between 0 and 10080),
      priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
      enabled boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      updated_by uuid,
      constraint notification_rules_key_uq unique (organization_id, key)
    );
    create index notification_rules_event_idx on notification_rules (organization_id, event_type) where enabled;

    create table notifications (
      id uuid primary key,
      organization_id uuid not null,
      user_id uuid not null,
      type text not null,
      title text not null,
      body text not null,
      link text,
      data jsonb not null default '{}',
      priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
      source_event_id uuid,
      available_at timestamptz not null default now(),
      read_at timestamptz,
      created_at timestamptz not null default now(),
      -- One notification of a type per person per event, however often the event is delivered.
      constraint notifications_source_uq unique (source_event_id, user_id, type)
    );
    create index notifications_inbox_idx on notifications (user_id, available_at desc, id desc);
    create index notifications_unread_idx on notifications (user_id, available_at) where read_at is null;
    create index notifications_retention_idx on notifications (read_at) where read_at is not null;

    create table email_deliveries (
      id uuid primary key,
      organization_id uuid not null,
      user_id uuid not null,
      notification_type text not null,
      source_event_id uuid,
      to_address text not null,
      to_name text,
      subject text not null,
      body_text text,
      body_html text,
      sealed_content text,
      sensitive boolean not null default false,
      status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
      attempts integer not null default 0,
      provider_message_id text,
      last_error text,
      scheduled_at timestamptz not null default now(),
      last_attempt_at timestamptz,
      sent_at timestamptz,
      failed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint email_deliveries_source_uq unique (source_event_id, user_id, notification_type),
      -- Security emails never keep readable content.
      constraint email_deliveries_sensitive_body_chk check (not sensitive or (body_text is null and body_html is null)),
      -- Sealed content only lives until the message is sent or abandoned.
      constraint email_deliveries_sealed_chk check (sealed_content is null or status = 'queued')
    );
    create index email_deliveries_queued_idx on email_deliveries (scheduled_at) where status = 'queued';
    create index email_deliveries_org_created_idx on email_deliveries (organization_id, created_at desc);
    create index email_deliveries_user_idx on email_deliveries (user_id, created_at desc);

    create table notification_preferences (
      user_id uuid not null,
      organization_id uuid not null,
      type text not null,
      channel text not null check (channel in ('in_app', 'email')),
      enabled boolean not null,
      updated_at timestamptz not null default now(),
      primary key (user_id, type, channel)
    );

    create table program_learners (
      program_id uuid not null,
      user_id uuid not null,
      organization_id uuid not null,
      enrollment_id uuid not null,
      enrolled_at timestamptz not null,
      withdrawn_at timestamptz,
      event_at timestamptz not null,
      primary key (program_id, user_id)
    );
    create index program_learners_active_idx on program_learners (program_id) where withdrawn_at is null;
  `.execute(db);

  for (const table of ['notification_templates', 'notification_rules', 'email_deliveries']) {
    await addUpdatedAtTrigger(db, table);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists program_learners, notification_preferences, email_deliveries, notifications,
      notification_rules, notification_templates, inbox_events, outbox_events cascade;
  `.execute(db);
  await dropDirectoryTables(db);
  await sql`drop function if exists set_updated_at()`.execute(db);
}
