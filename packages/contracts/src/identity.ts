import { z } from 'zod';
import { DATA_SCOPES, PERMISSION_KEYS, type PermissionKey } from '@a5/permissions';
import { isoDateTime, nameString, optionalText, pageQuerySchema, pageSchema, queryList } from './common.js';
import type { FeatureFlagState } from './feature-flags.js';

const permissionKeySchema = z.enum(PERMISSION_KEYS as [PermissionKey, ...PermissionKey[]]);
export const dataScopeSchema = z.enum(DATA_SCOPES);

export const emailSchema = z
  .email('Enter a valid email address')
  .trim()
  .max(254)
  .transform((v) => v.toLowerCase());

/** Contract-level bounds. The organization's password policy is enforced server side. */
export const passwordSchema = z.string().min(8, 'Use at least 8 characters').max(128);

// ------------------------------------------------------------------ auth

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const sessionUserSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  organizationName: z.string(),
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  displayName: z.string(),
  jobTitle: z.string().nullable(),
  roles: z.array(z.object({ id: z.uuid(), key: z.string(), name: z.string() })),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const tokenResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.int(),
  sessionId: z.string(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export const loginResponseSchema = tokenResponseSchema.extend({ user: sessionUserSchema });
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const forgotPasswordRequestSchema = z.object({ email: emailSchema });
export const resetPasswordRequestSchema = z.object({
  token: z.string().min(16).max(200),
  password: passwordSchema,
});
export const activateAccountRequestSchema = resetPasswordRequestSchema;
export const changePasswordRequestSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ['newPassword'],
    message: 'Choose a password different from your current one',
  });
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const tokenInfoSchema = z.object({
  purpose: z.enum(['activation', 'password_reset']),
  email: z.string(),
  displayName: z.string(),
  passwordPolicy: z.object({ minLength: z.int() }),
});
export type TokenInfo = z.infer<typeof tokenInfoSchema>;

/** Session bootstrap for the web app (permissions are evaluated per request, this is for UI). */
export interface MeResponse {
  user: SessionUser;
  permissions: Partial<Record<PermissionKey, (typeof DATA_SCOPES)[number]>>;
  featureFlags: FeatureFlagState;
  managedTeamIds: string[];
}

export const sessionSchema = z.object({
  id: z.uuid(),
  createdAt: isoDateTime,
  lastSeenAt: isoDateTime,
  expiresAt: isoDateTime,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof sessionSchema>;

export const loginHistoryEntrySchema = z.object({
  id: z.uuid(),
  occurredAt: isoDateTime,
  success: z.boolean(),
  reason: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type LoginHistoryEntry = z.infer<typeof loginHistoryEntrySchema>;

// ------------------------------------------------------------------ users

export const USER_STATUSES = ['invited', 'active', 'deactivated', 'locked'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

const refSchema = z.object({ id: z.uuid(), name: z.string() });
const personRef = z.object({ id: z.uuid(), displayName: z.string() });

export const userSummarySchema = z.object({
  id: z.uuid(),
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  displayName: z.string(),
  employeeId: z.string().nullable(),
  jobTitle: z.string().nullable(),
  status: userStatusSchema,
  location: refSchema.nullable(),
  department: refSchema.nullable(),
  teams: z.array(refSchema),
  roles: z.array(z.object({ id: z.uuid(), key: z.string(), name: z.string() })),
  lastLoginAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type UserSummary = z.infer<typeof userSummarySchema>;

export const userDetailSchema = userSummarySchema.extend({
  phone: z.string().nullable(),
  hiredAt: z.iso.date().nullable(),
  managers: z.array(personRef),
  trainers: z.array(personRef),
  directReports: z.array(personRef),
  managedTeams: z.array(refSchema),
  activatedAt: isoDateTime.nullable(),
  deactivatedAt: isoDateTime.nullable(),
  deactivationReason: z.string().nullable(),
});
export type UserDetail = z.infer<typeof userDetailSchema>;

const phoneSchema = z
  .string()
  .trim()
  .max(32)
  .regex(/^[+0-9 ().-]*$/, 'Use digits, spaces and + ( ) - only')
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

const userFields = {
  firstName: nameString(80),
  lastName: nameString(80),
  employeeId: optionalText(40),
  jobTitle: optionalText(120),
  phone: phoneSchema,
  hiredAt: z.iso.date().nullable().optional(),
  locationId: z.uuid().nullable().optional(),
  departmentId: z.uuid().nullable().optional(),
  teamIds: z.array(z.uuid()).max(20).default([]),
  managerIds: z.array(z.uuid()).max(10).default([]),
  trainerIds: z.array(z.uuid()).max(10).default([]),
};

export const createUserRequestSchema = z.object({
  email: emailSchema,
  ...userFields,
  roleIds: z.array(z.uuid()).min(1, 'Assign at least one role').max(10),
  sendInvitation: z.boolean().default(true),
});
export type CreateUserRequest = z.input<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z
  .object({
    email: emailSchema,
    ...userFields,
    teamIds: z.array(z.uuid()).max(20),
    managerIds: z.array(z.uuid()).max(10),
    trainerIds: z.array(z.uuid()).max(10),
  })
  .partial();
export type UpdateUserRequest = z.input<typeof updateUserRequestSchema>;

export const setUserRolesRequestSchema = z.object({
  roleIds: z.array(z.uuid()).min(1, 'Keep at least one role').max(10),
});

export const deactivateUserRequestSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason').max(500),
});

export const listUsersQuerySchema = pageQuerySchema.extend({
  status: queryList(userStatusSchema),
  roleId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  ids: queryList(z.uuid()),
});
export type ListUsersQuery = z.input<typeof listUsersQuerySchema>;

export const userPageSchema = pageSchema(userSummarySchema);

export const invitationResultSchema = z.object({
  user: userDetailSchema,
  /** Returned only outside production so administrators can test activation without email. */
  activationUrl: z.string().nullable(),
});

// ------------------------------------------------------------------ roles & permissions

export const roleSummarySchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  locked: z.boolean(),
  dataScope: dataScopeSchema,
  userCount: z.int(),
  permissionCount: z.int(),
  archived: z.boolean(),
  /** System roles whose permissions differ from the shipped defaults. */
  modifiedFromDefault: z.boolean(),
});
export type RoleSummary = z.infer<typeof roleSummarySchema>;

export const roleDetailSchema = roleSummarySchema.extend({
  permissions: z.array(permissionKeySchema),
});
export type RoleDetail = z.infer<typeof roleDetailSchema>;

export const createRoleRequestSchema = z.object({
  name: nameString(80),
  description: optionalText(500),
  dataScope: dataScopeSchema.exclude(['platform']),
  permissions: z.array(permissionKeySchema).default([]),
  cloneFromRoleId: z.uuid().optional(),
});
export type CreateRoleRequest = z.input<typeof createRoleRequestSchema>;

export const updateRoleRequestSchema = z
  .object({
    name: nameString(80),
    description: optionalText(500),
    dataScope: dataScopeSchema.exclude(['platform']),
  })
  .partial();

export const setRolePermissionsRequestSchema = z.object({
  permissions: z.array(permissionKeySchema),
  reason: optionalText(500),
});

export const permissionCatalogSchema = z.object({
  modules: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      permissions: z.array(
        z.object({
          key: permissionKeySchema,
          label: z.string(),
          description: z.string(),
          scoped: z.boolean(),
          platform: z.boolean(),
        }),
      ),
    }),
  ),
});
export type PermissionCatalog = z.infer<typeof permissionCatalogSchema>;

export const permissionMatrixSchema = z.object({
  catalog: permissionCatalogSchema,
  roles: z.array(roleDetailSchema),
});
export type PermissionMatrix = z.infer<typeof permissionMatrixSchema>;

// ------------------------------------------------------------------ organization

export const locationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  timezone: z.string(),
  archived: z.boolean(),
  userCount: z.int(),
});
export type Location = z.infer<typeof locationSchema>;

export const upsertLocationRequestSchema = z.object({
  name: nameString(120),
  code: optionalText(20),
  city: optionalText(120),
  state: optionalText(60),
  timezone: z.string().trim().min(1).max(64).default('America/Chicago'),
});

export const departmentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string().nullable(),
  archived: z.boolean(),
  userCount: z.int(),
});
export type Department = z.infer<typeof departmentSchema>;

export const upsertDepartmentRequestSchema = z.object({
  name: nameString(120),
  code: optionalText(20),
});

export const teamSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  location: refSchema.nullable(),
  department: refSchema.nullable(),
  managers: z.array(personRef),
  memberCount: z.int(),
  archived: z.boolean(),
});
export type TeamSummary = z.infer<typeof teamSummarySchema>;

export const teamDetailSchema = teamSummarySchema.extend({
  members: z.array(
    personRef.extend({ email: z.string(), jobTitle: z.string().nullable(), status: userStatusSchema }),
  ),
});
export type TeamDetail = z.infer<typeof teamDetailSchema>;

export const upsertTeamRequestSchema = z.object({
  name: nameString(120),
  description: optionalText(500),
  locationId: z.uuid().nullable().optional(),
  departmentId: z.uuid().nullable().optional(),
  managerIds: z.array(z.uuid()).max(10).default([]),
});
export type UpsertTeamRequest = z.input<typeof upsertTeamRequestSchema>;

export const setTeamMembersRequestSchema = z.object({
  memberIds: z.array(z.uuid()).max(500),
});

export const listTeamsQuerySchema = pageQuerySchema.extend({
  locationId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const orgStructureSchema = z.object({
  organization: z.object({ id: z.uuid(), name: z.string() }),
  locations: z.array(locationSchema),
  departments: z.array(departmentSchema),
  teams: z.array(teamSummarySchema),
});
export type OrgStructure = z.infer<typeof orgStructureSchema>;

// ------------------------------------------------------------------ settings

export const securitySettingsSchema = z.object({
  passwordMinLength: z.int().min(8).max(64),
  lockoutThreshold: z.int().min(3).max(20),
  lockoutMinutes: z.int().min(1).max(24 * 60),
  sessionIdleMinutes: z.int().min(5).max(7 * 24 * 60),
  sessionMaxHours: z.int().min(1).max(24 * 90),
});
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;

export const organizationSettingsSchema = z.object({
  name: nameString(160),
  legalName: optionalText(200),
  timezone: z.string().min(1).max(64),
  supportEmail: z.email().nullable().optional(),
  branding: z.object({
    primaryColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable(),
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable(),
    logoUrl: z.string().nullable(),
  }),
});
export type OrganizationSettings = z.infer<typeof organizationSettingsSchema>;

export const featureFlagEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  updatedAt: isoDateTime.nullable(),
});
export type FeatureFlagEntry = z.infer<typeof featureFlagEntrySchema>;

export const setFeatureFlagRequestSchema = z.object({ enabled: z.boolean() });
