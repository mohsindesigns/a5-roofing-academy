import { createInboxTable, sql, type Kysely } from '@a5/database';

/**
 * The audit trail: one table, range-partitioned by month on `occurred_at`, with a default
 * partition for anything outside the created ranges.
 *
 * Immutability is enforced in the database: row triggers reject UPDATE and DELETE (on the parent
 * and, through trigger cloning, on every partition), statement triggers reject TRUNCATE (added to
 * each partition explicitly, because statement triggers are not inherited). Retention is an
 * operator decision made by detaching or dropping whole partitions, never by deleting rows.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await createInboxTable(db);

  await sql`
    create function audit_logs_reject_change() returns trigger language plpgsql as $$
    begin
      raise exception 'audit_logs is append-only: % is not allowed', tg_op
        using errcode = '55000', hint = 'Audit entries are immutable. Record a new entry instead.';
    end;
    $$;

    create function audit_logs_reject_truncate() returns trigger language plpgsql as $$
    begin
      raise exception 'audit_logs is append-only: TRUNCATE is not allowed'
        using errcode = '55000', hint = 'Audit entries are immutable.';
    end;
    $$;

    create table audit_logs (
      id uuid not null,
      organization_id uuid,
      occurred_at timestamptz not null,
      actor_type text not null check (actor_type in ('user', 'service', 'system')),
      actor_id text,
      actor_display text,
      action text not null check (length(action) between 1 and 100),
      resource_type text not null check (length(resource_type) between 1 and 100),
      resource_id text,
      before jsonb,
      after jsonb,
      reason text,
      ip text,
      user_agent text,
      request_id text,
      correlation_id text,
      service text not null,
      metadata jsonb not null default '{}',
      recorded_at timestamptz not null default now(),
      primary key (id, occurred_at)
    ) partition by range (occurred_at);

    create index audit_logs_org_time_idx on audit_logs (organization_id, occurred_at desc, id desc);
    create index audit_logs_resource_idx on audit_logs (resource_type, resource_id, occurred_at desc, id desc);
    create index audit_logs_actor_idx on audit_logs (actor_id, occurred_at desc, id desc);
    create index audit_logs_action_idx on audit_logs (action text_pattern_ops, occurred_at desc);

    create trigger audit_logs_immutable before update or delete on audit_logs
      for each row execute function audit_logs_reject_change();
    create trigger audit_logs_no_truncate before truncate on audit_logs
      for each statement execute function audit_logs_reject_truncate();

    create table audit_logs_default partition of audit_logs default;
    create trigger audit_logs_no_truncate before truncate on audit_logs_default
      for each statement execute function audit_logs_reject_truncate();

    -- Creates the partition for the month containing month_start (UTC) and returns its name, or
    -- null when it already exists. Rows that were collected in the default partition for that month
    -- are moved without any DELETE: the default partition is swapped for an empty one, the month
    -- partition is created, the old rows are re-inserted (and routed) and the old table is dropped.
    create function audit_logs_ensure_partition(month_start date) returns text language plpgsql as $$
    declare
      from_ts timestamptz := (date_trunc('month', month_start)::timestamp at time zone 'UTC');
      to_ts timestamptz := ((date_trunc('month', month_start) + interval '1 month')::timestamp at time zone 'UTC');
      part text := format('audit_logs_y%sm%s', to_char(month_start, 'YYYY'), to_char(month_start, 'MM'));
      has_rows boolean;
    begin
      if to_regclass(part) is not null then
        return null;
      end if;
      perform pg_advisory_xact_lock(hashtext('audit_logs_partitions'));
      if to_regclass(part) is not null then
        return null;
      end if;

      select exists (
        select 1 from audit_logs_default where occurred_at >= from_ts and occurred_at < to_ts
      ) into has_rows;

      if has_rows then
        alter table audit_logs detach partition audit_logs_default;
        alter table audit_logs_default rename to audit_logs_default_moving;
        create table audit_logs_default partition of audit_logs default;
        create trigger audit_logs_no_truncate before truncate on audit_logs_default
          for each statement execute function audit_logs_reject_truncate();
      end if;

      execute format('create table %I partition of audit_logs for values from (%L) to (%L)', part, from_ts, to_ts);
      execute format(
        'create trigger audit_logs_no_truncate before truncate on %I for each statement execute function audit_logs_reject_truncate()',
        part
      );

      if has_rows then
        insert into audit_logs select * from audit_logs_default_moving;
        drop table audit_logs_default_moving;
      end if;
      return part;
    end;
    $$;

    -- The current month and the next three exist from the first day.
    do $$
    declare
      first_month date := date_trunc('month', now() at time zone 'UTC')::date;
      i integer;
    begin
      for i in 0..3 loop
        perform audit_logs_ensure_partition((first_month + make_interval(months => i))::date);
      end loop;
    end;
    $$;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists audit_logs cascade;
    drop table if exists audit_logs_default_moving cascade;
    drop function if exists audit_logs_ensure_partition(date);
    drop function if exists audit_logs_reject_truncate();
    drop function if exists audit_logs_reject_change();
    drop table if exists inbox_events;
  `.execute(db);
}
