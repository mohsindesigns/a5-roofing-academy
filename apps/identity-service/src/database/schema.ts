import type { Generated, OutboxSchema } from '@a5/database';
import type { DataScope } from '@a5/permissions';

export interface OrganizationsTable {
  id: string;
  slug: string;
  name: string;
  legal_name: string | null;
  timezone: string;
  support_email: string | null;
  branding: { primaryColor: string | null; accentColor: string | null; logoUrl: string | null };
  security: {
    passwordMinLength: number;
    lockoutThreshold: number;
    lockoutMinutes: number;
    sessionIdleMinutes: number;
    sessionMaxHours: number;
  };
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LocationsTable {
  id: string;
  organization_id: string;
  name: string;
  code: string | null;
  city: string | null;
  state: string | null;
  timezone: string;
  archived_at: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DepartmentsTable {
  id: string;
  organization_id: string;
  name: string;
  code: string | null;
  archived_at: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TeamsTable {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  location_id: string | null;
  department_id: string | null;
  archived_at: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
}

export interface TeamMembersTable {
  team_id: string;
  user_id: string;
  added_at: Generated<Date>;
}

export interface TeamManagersTable {
  team_id: string;
  user_id: string;
  added_at: Generated<Date>;
}

export type UserStatus = 'invited' | 'active' | 'deactivated' | 'locked';

export interface UsersTable {
  id: string;
  organization_id: string;
  email: string;
  first_name: string;
  last_name: string;
  employee_id: string | null;
  job_title: string | null;
  phone: string | null;
  location_id: string | null;
  department_id: string | null;
  hired_at: string | null;
  status: UserStatus;
  activated_at: Date | null;
  deactivated_at: Date | null;
  deactivation_reason: string | null;
  last_login_at: Date | null;
  failed_login_count: Generated<number>;
  locked_until: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
}

export interface UserRelationshipsTable {
  user_id: string;
  supervisor_id: string;
  kind: 'manager' | 'trainer';
  created_at: Generated<Date>;
}

export interface CredentialsTable {
  user_id: string;
  password_hash: string;
  password_changed_at: Generated<Date>;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  organization_id: string;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  expires_at: Date;
  ip: string | null;
  user_agent: string | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
}

export interface RefreshTokensTable {
  id: string;
  session_id: string;
  token_hash: string;
  created_at: Generated<Date>;
  expires_at: Date;
  rotated_at: Date | null;
}

export interface LoginAttemptsTable {
  id: string;
  user_id: string | null;
  email: string;
  ip: string | null;
  user_agent: string | null;
  success: boolean;
  reason: string | null;
  occurred_at: Generated<Date>;
}

export type OneTimeTokenPurpose = 'activation' | 'password_reset';

export interface OneTimeTokensTable {
  id: string;
  user_id: string;
  purpose: OneTimeTokenPurpose;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Generated<Date>;
  created_by: string | null;
}

export interface MfaFactorsTable {
  id: string;
  user_id: string;
  type: 'totp' | 'webauthn';
  label: string;
  secret_encrypted: string;
  created_at: Generated<Date>;
  last_used_at: Date | null;
  disabled_at: Date | null;
}

export interface PermissionsTable {
  key: string;
  module: string;
  label: string;
  description: string;
  scoped: boolean;
  platform: boolean;
  updated_at: Generated<Date>;
}

export interface RolesTable {
  id: string;
  organization_id: string;
  key: string;
  name: string;
  description: string | null;
  is_system: boolean;
  locked: boolean;
  data_scope: DataScope;
  archived_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  updated_by: string | null;
}

export interface RolePermissionsTable {
  role_id: string;
  permission_key: string;
  granted_at: Generated<Date>;
  granted_by: string | null;
}

export interface UserRolesTable {
  user_id: string;
  role_id: string;
  assigned_at: Generated<Date>;
  assigned_by: string | null;
}

export interface FeatureFlagsTable {
  organization_id: string;
  key: string;
  enabled: boolean;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

export interface IdentityDatabase extends OutboxSchema {
  organizations: OrganizationsTable;
  locations: LocationsTable;
  departments: DepartmentsTable;
  teams: TeamsTable;
  team_members: TeamMembersTable;
  team_managers: TeamManagersTable;
  users: UsersTable;
  user_relationships: UserRelationshipsTable;
  credentials: CredentialsTable;
  sessions: SessionsTable;
  refresh_tokens: RefreshTokensTable;
  login_attempts: LoginAttemptsTable;
  one_time_tokens: OneTimeTokensTable;
  mfa_factors: MfaFactorsTable;
  permissions: PermissionsTable;
  roles: RolesTable;
  role_permissions: RolePermissionsTable;
  user_roles: UserRolesTable;
  feature_flags: FeatureFlagsTable;
}
