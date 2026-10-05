import { PERMISSIONS, type PermissionKey } from './catalog.js';
import type { DataScope } from './scopes.js';

export interface DefaultRoleDefinition {
  readonly key: SystemRoleKey;
  readonly name: string;
  readonly description: string;
  readonly dataScope: DataScope;
  /** Immutable roles cannot be edited or reset (super administrator). */
  readonly locked: boolean;
  readonly permissions: readonly PermissionKey[];
}

export const SYSTEM_ROLE_KEYS = [
  'super_admin',
  'admin',
  'training_admin',
  'manager',
  'trainer',
  'sales_rep',
  'auditor',
] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

const allPermissions = PERMISSIONS.map((p) => p.key);
const nonPlatform = PERMISSIONS.filter((p) => !p.platform).map((p) => p.key);

const selfService: PermissionKey[] = [
  'training.participate',
  'assessments.take',
  'ai_practice.use',
  'certificates.view_own',
];

const adminExcluded = new Set<PermissionKey>([
  'roles.create',
  'roles.update',
  'permissions.manage',
  'security_settings.manage',
  'feature_flags.manage',
  'users.delete',
]);

export const DEFAULT_ROLES: readonly DefaultRoleDefinition[] = [
  {
    key: 'super_admin',
    name: 'Super Administrator',
    description: 'Full access to every organization, configuration and record.',
    dataScope: 'platform',
    locked: true,
    permissions: allPermissions,
  },
  {
    key: 'admin',
    name: 'Administrator',
    description:
      'Manages people, training, AI scenarios, certifications and reports. Cannot change role permissions or security policy.',
    dataScope: 'organization',
    locked: false,
    permissions: nonPlatform.filter((p) => !adminExcluded.has(p)),
  },
  {
    key: 'training_admin',
    name: 'Training Administrator',
    description: 'Builds programs, lessons, assessments, AI scenarios and certifications.',
    dataScope: 'organization',
    locked: false,
    permissions: [
      'users.view',
      'teams.view',
      'organization.view',
      'settings.view',
      'programs.view',
      'programs.create',
      'programs.update',
      'programs.publish',
      'programs.archive',
      'programs.assign',
      'lessons.create',
      'lessons.update',
      'lessons.delete',
      'enrollments.view',
      'enrollments.manage',
      'media.view',
      'media.upload',
      'media.delete',
      'assessments.view',
      'assessments.create',
      'assessments.update',
      'assessment_attempts.view',
      'assessment_attempts.grade',
      'ai_scenarios.view',
      'ai_scenarios.create',
      'ai_scenarios.update',
      'ai_sessions.view',
      'ai_sessions.review',
      'certifications.view',
      'certifications.create',
      'certifications.update',
      'certificates.view',
      'certificate_templates.view',
      'certificate_templates.create',
      'certificate_templates.update',
      'analytics.view',
      'reports.view',
      'reports.export',
      ...selfService,
    ],
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Follows team progress, reviews readiness and approves certifications.',
    dataScope: 'managed',
    locked: false,
    permissions: [
      'users.view',
      'teams.view',
      'organization.view',
      'programs.view',
      'programs.assign',
      'enrollments.view',
      'approvals.decide',
      'assessment_attempts.view',
      'ai_scenarios.view',
      'ai_sessions.view',
      'ai_sessions.review',
      'certifications.view',
      'certificates.view',
      'certificate_approvals.decide',
      'analytics.view',
      'reports.view',
      'reports.export',
      ...selfService,
    ],
  },
  {
    key: 'trainer',
    name: 'Trainer / Coach',
    description: 'Coaches assigned trainees, grades open answers and reviews AI role-plays.',
    dataScope: 'managed',
    locked: false,
    permissions: [
      'users.view',
      'teams.view',
      'programs.view',
      'enrollments.view',
      'assessments.view',
      'assessment_attempts.view',
      'assessment_attempts.grade',
      'ai_scenarios.view',
      'ai_sessions.view',
      'ai_sessions.review',
      'certifications.view',
      'certificates.view',
      'analytics.view',
      ...selfService,
    ],
  },
  {
    key: 'sales_rep',
    name: 'Sales Representative',
    description: 'Completes assigned training, assessments and AI practice.',
    dataScope: 'own',
    locked: false,
    permissions: selfService,
  },
  {
    key: 'auditor',
    name: 'Auditor / Viewer',
    description: 'Read-only access to training records, certificates, reports and the audit log.',
    dataScope: 'organization',
    locked: false,
    permissions: [
      'users.view',
      'teams.view',
      'organization.view',
      'roles.view',
      'settings.view',
      'programs.view',
      'enrollments.view',
      'assessments.view',
      'assessment_attempts.view',
      'ai_scenarios.view',
      'ai_sessions.view',
      'certifications.view',
      'certificates.view',
      'certificate_templates.view',
      'analytics.view',
      'reports.view',
      'audit_logs.view',
    ],
  },
];

export function getDefaultRole(key: SystemRoleKey): DefaultRoleDefinition {
  const role = DEFAULT_ROLES.find((r) => r.key === key);
  if (!role) throw new Error(`Unknown system role ${key}`);
  return role;
}

export function isSystemRoleKey(value: string): value is SystemRoleKey {
  return (SYSTEM_ROLE_KEYS as readonly string[]).includes(value);
}
