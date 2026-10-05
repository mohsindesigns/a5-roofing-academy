import { sql, type Generated, type Kysely } from '@a5/database';

export interface DirUsersTable {
  id: string;
  organization_id: string;
  first_name: string;
  last_name: string;
  display_name: string;
  email: string;
  employee_id: string | null;
  job_title: string | null;
  status: string;
  location_id: string | null;
  department_id: string | null;
  role_keys: string[];
  hired_at: Date | null;
  revision: number;
  updated_at: Generated<Date>;
}

export interface DirUserTeamsTable {
  user_id: string;
  team_id: string;
}

export interface DirUserSupervisorsTable {
  user_id: string;
  supervisor_id: string;
  kind: 'manager' | 'trainer';
}

export interface DirTeamsTable {
  id: string;
  organization_id: string;
  name: string;
  location_id: string | null;
  department_id: string | null;
  archived: boolean;
  revision: number;
}

export interface DirTeamManagersTable {
  team_id: string;
  user_id: string;
}

export interface DirUnitsTable {
  id: string;
  organization_id: string;
  kind: 'location' | 'department';
  name: string;
  archived: boolean;
  revision: number;
}

/** Read model of people and org structure, fed by identity-service directory events. */
export interface DirectorySchema {
  dir_users: DirUsersTable;
  dir_user_teams: DirUserTeamsTable;
  dir_user_supervisors: DirUserSupervisorsTable;
  dir_teams: DirTeamsTable;
  dir_team_managers: DirTeamManagersTable;
  dir_units: DirUnitsTable;
}

export async function createDirectoryTables(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table dir_users (
      id uuid primary key,
      organization_id uuid not null,
      first_name text not null,
      last_name text not null,
      display_name text not null,
      email text not null,
      employee_id text,
      job_title text,
      status text not null,
      location_id uuid,
      department_id uuid,
      role_keys text[] not null default '{}',
      hired_at timestamptz,
      revision bigint not null,
      updated_at timestamptz not null default now()
    );
    create index dir_users_org_name_idx on dir_users (organization_id, display_name);
    create index dir_users_location_idx on dir_users (location_id);
    create index dir_users_department_idx on dir_users (department_id);

    create table dir_user_teams (
      user_id uuid not null,
      team_id uuid not null,
      primary key (user_id, team_id)
    );
    create index dir_user_teams_team_idx on dir_user_teams (team_id);

    create table dir_user_supervisors (
      user_id uuid not null,
      supervisor_id uuid not null,
      kind text not null check (kind in ('manager', 'trainer')),
      primary key (user_id, supervisor_id, kind)
    );
    create index dir_user_supervisors_supervisor_idx on dir_user_supervisors (supervisor_id);

    create table dir_teams (
      id uuid primary key,
      organization_id uuid not null,
      name text not null,
      location_id uuid,
      department_id uuid,
      archived boolean not null default false,
      revision bigint not null
    );
    create index dir_teams_org_idx on dir_teams (organization_id);

    create table dir_team_managers (
      team_id uuid not null,
      user_id uuid not null,
      primary key (team_id, user_id)
    );
    create index dir_team_managers_user_idx on dir_team_managers (user_id);

    create table dir_units (
      id uuid primary key,
      organization_id uuid not null,
      kind text not null check (kind in ('location', 'department')),
      name text not null,
      archived boolean not null default false,
      revision bigint not null
    );
  `.execute(db);
}

export async function dropDirectoryTables(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table if exists dir_units, dir_team_managers, dir_teams, dir_user_supervisors, dir_user_teams, dir_users
  `.execute(db);
}
