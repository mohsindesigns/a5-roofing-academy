import { addUpdatedAtTrigger, createOutboxTable, createUpdatedAtFunction, sql, type Kysely } from '@a5/database';

export async function up(db: Kysely<unknown>): Promise<void> {
  await createUpdatedAtFunction(db);
  await createOutboxTable(db);

  await sql`
    create table organizations (
      id uuid primary key,
      slug text not null unique,
      name text not null,
      legal_name text,
      timezone text not null default 'America/Chicago',
      support_email text,
      branding jsonb not null default '{"primaryColor":null,"accentColor":null,"logoUrl":null}',
      security jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table locations (
      id uuid primary key,
      organization_id uuid not null references organizations(id),
      name text not null,
      code text,
      city text,
      state text,
      timezone text not null,
      archived_at timestamptz,
      revision bigint not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index locations_org_name_uq on locations (organization_id, lower(name));

    create table departments (
      id uuid primary key,
      organization_id uuid not null references organizations(id),
      name text not null,
      code text,
      archived_at timestamptz,
      revision bigint not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index departments_org_name_uq on departments (organization_id, lower(name));

    create table teams (
      id uuid primary key,
      organization_id uuid not null references organizations(id),
      name text not null,
      description text,
      location_id uuid references locations(id),
      department_id uuid references departments(id),
      archived_at timestamptz,
      revision bigint not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid
    );
    create unique index teams_org_name_uq on teams (organization_id, lower(name)) where archived_at is null;
    create index teams_location_idx on teams (location_id);
    create index teams_department_idx on teams (department_id);

    create table users (
      id uuid primary key,
      organization_id uuid not null references organizations(id),
      email text not null,
      first_name text not null,
      last_name text not null,
      employee_id text,
      job_title text,
      phone text,
      location_id uuid references locations(id),
      department_id uuid references departments(id),
      hired_at date,
      status text not null check (status in ('invited', 'active', 'deactivated', 'locked')),
      activated_at timestamptz,
      deactivated_at timestamptz,
      deactivation_reason text,
      last_login_at timestamptz,
      failed_login_count integer not null default 0,
      locked_until timestamptz,
      revision bigint not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      updated_by uuid
    );
    -- Email is the login identifier, unique across the platform.
    create unique index users_email_uq on users (lower(email));
    create unique index users_org_employee_uq on users (organization_id, employee_id) where employee_id is not null;
    create index users_org_status_idx on users (organization_id, status);
    create index users_org_name_idx on users (organization_id, last_name, first_name);
    create index users_location_idx on users (location_id);
    create index users_department_idx on users (department_id);

    create table team_members (
      team_id uuid not null references teams(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      added_at timestamptz not null default now(),
      primary key (team_id, user_id)
    );
    create index team_members_user_idx on team_members (user_id);

    create table team_managers (
      team_id uuid not null references teams(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      added_at timestamptz not null default now(),
      primary key (team_id, user_id)
    );
    create index team_managers_user_idx on team_managers (user_id);

    create table user_relationships (
      user_id uuid not null references users(id) on delete cascade,
      supervisor_id uuid not null references users(id) on delete cascade,
      kind text not null check (kind in ('manager', 'trainer')),
      created_at timestamptz not null default now(),
      primary key (user_id, supervisor_id, kind),
      check (user_id <> supervisor_id)
    );
    create index user_relationships_supervisor_idx on user_relationships (supervisor_id, kind);

    create table credentials (
      user_id uuid primary key references users(id) on delete cascade,
      password_hash text not null,
      password_changed_at timestamptz not null default now()
    );

    create table sessions (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      organization_id uuid not null,
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      expires_at timestamptz not null,
      ip text,
      user_agent text,
      revoked_at timestamptz,
      revoked_reason text
    );
    create index sessions_user_active_idx on sessions (user_id, created_at desc) where revoked_at is null;

    create table refresh_tokens (
      id uuid primary key,
      session_id uuid not null references sessions(id) on delete cascade,
      token_hash text not null unique,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      rotated_at timestamptz
    );
    create index refresh_tokens_session_idx on refresh_tokens (session_id);

    create table login_attempts (
      id uuid primary key,
      user_id uuid references users(id) on delete set null,
      email text not null,
      ip text,
      user_agent text,
      success boolean not null,
      reason text,
      occurred_at timestamptz not null default now()
    );
    create index login_attempts_user_idx on login_attempts (user_id, occurred_at desc);
    create index login_attempts_time_idx on login_attempts (occurred_at);

    create table one_time_tokens (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      purpose text not null check (purpose in ('activation', 'password_reset')),
      token_hash text not null unique,
      expires_at timestamptz not null,
      used_at timestamptz,
      created_at timestamptz not null default now(),
      created_by uuid
    );
    create index one_time_tokens_user_idx on one_time_tokens (user_id, purpose);

    create table mfa_factors (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      type text not null check (type in ('totp', 'webauthn')),
      label text not null,
      secret_encrypted text not null,
      created_at timestamptz not null default now(),
      last_used_at timestamptz,
      disabled_at timestamptz
    );
    create index mfa_factors_user_idx on mfa_factors (user_id);

    create table permissions (
      key text primary key,
      module text not null,
      label text not null,
      description text not null,
      scoped boolean not null default false,
      platform boolean not null default false,
      updated_at timestamptz not null default now()
    );

    create table roles (
      id uuid primary key,
      organization_id uuid not null references organizations(id),
      key text not null,
      name text not null,
      description text,
      is_system boolean not null default false,
      locked boolean not null default false,
      data_scope text not null check (data_scope in ('own', 'managed', 'organization', 'platform')),
      archived_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by uuid,
      updated_by uuid,
      unique (organization_id, key)
    );
    create unique index roles_org_name_uq on roles (organization_id, lower(name)) where archived_at is null;

    create table role_permissions (
      role_id uuid not null references roles(id) on delete cascade,
      permission_key text not null references permissions(key) on delete cascade,
      granted_at timestamptz not null default now(),
      granted_by uuid,
      primary key (role_id, permission_key)
    );

    create table user_roles (
      user_id uuid not null references users(id) on delete cascade,
      role_id uuid not null references roles(id),
      assigned_at timestamptz not null default now(),
      assigned_by uuid,
      primary key (user_id, role_id)
    );
    create index user_roles_role_idx on user_roles (role_id);

    create table feature_flags (
      organization_id uuid not null references organizations(id),
      key text not null,
      enabled boolean not null,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      primary key (organization_id, key)
    );
  `.execute(db);

  for (const table of ['organizations', 'locations', 'departments', 'teams', 'users', 'roles']) {
    await addUpdatedAtTrigger(db, table);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists feature_flags, user_roles, role_permissions, roles, permissions, mfa_factors,
      one_time_tokens, login_attempts, refresh_tokens, sessions, credentials, user_relationships,
      team_managers, team_members, users, teams, departments, locations, organizations, outbox_events cascade;
    drop function if exists set_updated_at();
  `.execute(db);
}
