/**
 * Permission catalog.
 *
 * Permissions are `resource.action` keys. They are defined in code because enforcement lives in
 * code; identity-service syncs this catalog into its database so the admin matrix can render it.
 *
 * `scoped` permissions are evaluated together with the granting role's data scope
 * (own / managed / organization / platform). Non-scoped permissions are simply granted or not.
 * `platform` permissions can only be granted by someone holding platform scope.
 */
export interface PermissionDefinition {
  readonly key: string;
  readonly module: PermissionModuleKey;
  readonly label: string;
  readonly description: string;
  readonly scoped?: boolean;
  readonly platform?: boolean;
}

export const PERMISSION_MODULES = [
  { key: 'people', label: 'People & access' },
  { key: 'organization', label: 'Organization' },
  { key: 'training', label: 'Training programs' },
  { key: 'media', label: 'Media library' },
  { key: 'assessments', label: 'Assessments' },
  { key: 'ai', label: 'AI coaching' },
  { key: 'certifications', label: 'Certifications' },
  { key: 'reporting', label: 'Reporting & analytics' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'self', label: 'Self-service learning' },
  { key: 'platform', label: 'Platform' },
] as const;

export type PermissionModuleKey = (typeof PERMISSION_MODULES)[number]['key'];

const definitions = [
  // People & access
  {
    key: 'users.view',
    module: 'people',
    label: 'View users',
    description: 'View user profiles and account status.',
    scoped: true,
  },
  {
    key: 'users.create',
    module: 'people',
    label: 'Create users',
    description: 'Invite and create user accounts.',
  },
  {
    key: 'users.update',
    module: 'people',
    label: 'Update users',
    description: 'Edit profile, placement and manager relationships.',
    scoped: true,
  },
  {
    key: 'users.disable',
    module: 'people',
    label: 'Disable users',
    description: 'Deactivate and reactivate accounts.',
    scoped: true,
  },
  {
    key: 'users.delete',
    module: 'people',
    label: 'Delete users',
    description: 'Permanently remove users who have no training history.',
  },
  {
    key: 'sessions.view',
    module: 'people',
    label: 'View sessions',
    description: 'View active sessions and login history of other users.',
    scoped: true,
  },
  {
    key: 'sessions.revoke',
    module: 'people',
    label: 'Revoke sessions',
    description: 'Sign other users out of active sessions.',
    scoped: true,
  },
  {
    key: 'roles.view',
    module: 'people',
    label: 'View roles',
    description: 'View roles and their permissions.',
  },
  {
    key: 'roles.create',
    module: 'people',
    label: 'Create roles',
    description: 'Create and clone custom roles.',
  },
  {
    key: 'roles.update',
    module: 'people',
    label: 'Update roles',
    description: 'Rename, archive or reset roles.',
  },
  {
    key: 'roles.assign',
    module: 'people',
    label: 'Assign roles',
    description: 'Assign and remove roles on users.',
  },
  {
    key: 'permissions.manage',
    module: 'people',
    label: 'Manage permissions',
    description: 'Change which permissions a role grants.',
  },

  // Organization
  {
    key: 'organization.view',
    module: 'organization',
    label: 'View organization',
    description: 'View organization profile and structure.',
  },
  {
    key: 'organization.update',
    module: 'organization',
    label: 'Update organization',
    description: 'Edit organization profile and branding.',
  },
  {
    key: 'locations.manage',
    module: 'organization',
    label: 'Manage locations',
    description: 'Create, edit and archive locations.',
  },
  {
    key: 'departments.manage',
    module: 'organization',
    label: 'Manage departments',
    description: 'Create, edit and archive departments.',
  },
  {
    key: 'teams.view',
    module: 'organization',
    label: 'View teams',
    description: 'View teams, members and managers.',
    scoped: true,
  },
  {
    key: 'teams.manage',
    module: 'organization',
    label: 'Manage teams',
    description: 'Create teams and change members and managers.',
  },
  {
    key: 'settings.view',
    module: 'organization',
    label: 'View settings',
    description: 'View platform configuration.',
  },
  {
    key: 'settings.update',
    module: 'organization',
    label: 'Update settings',
    description: 'Change training, quiz, certificate and media defaults.',
  },
  {
    key: 'feature_flags.manage',
    module: 'organization',
    label: 'Manage feature flags',
    description: 'Turn product capabilities on or off.',
  },
  {
    key: 'security_settings.manage',
    module: 'organization',
    label: 'Manage security settings',
    description: 'Change password, session and lockout policy.',
  },

  // Training programs
  {
    key: 'programs.view',
    module: 'training',
    label: 'View programs',
    description: 'View program catalog and structure in the admin area.',
  },
  {
    key: 'programs.create',
    module: 'training',
    label: 'Create programs',
    description: 'Create and duplicate training programs.',
  },
  {
    key: 'programs.update',
    module: 'training',
    label: 'Update programs',
    description: 'Edit program settings and structure.',
  },
  {
    key: 'programs.publish',
    module: 'training',
    label: 'Publish programs',
    description: 'Publish program changes to learners.',
  },
  {
    key: 'programs.archive',
    module: 'training',
    label: 'Archive programs',
    description: 'Archive and restore programs.',
  },
  {
    key: 'programs.assign',
    module: 'training',
    label: 'Assign programs',
    description: 'Enroll users in programs and set due dates.',
    scoped: true,
  },
  {
    key: 'lessons.create',
    module: 'training',
    label: 'Create lessons',
    description: 'Add phases, modules and lessons.',
  },
  {
    key: 'lessons.update',
    module: 'training',
    label: 'Update lessons',
    description: 'Edit, reorder and archive lessons.',
  },
  {
    key: 'lessons.delete',
    module: 'training',
    label: 'Delete lessons',
    description: 'Delete draft lessons that have no learner activity.',
  },
  {
    key: 'enrollments.view',
    module: 'training',
    label: 'View enrollments',
    description: 'View enrollments and learner progress.',
    scoped: true,
  },
  {
    key: 'enrollments.manage',
    module: 'training',
    label: 'Manage enrollments',
    description: 'Withdraw learners, change due dates, mark lessons complete.',
    scoped: true,
  },
  {
    key: 'approvals.decide',
    module: 'training',
    label: 'Decide approvals',
    description: 'Approve or reject manager-approval lessons.',
    scoped: true,
  },

  // Media
  {
    key: 'media.view',
    module: 'media',
    label: 'View media library',
    description: 'Browse uploaded videos, documents and images.',
  },
  {
    key: 'media.upload',
    module: 'media',
    label: 'Upload media',
    description: 'Upload videos, documents, captions and images.',
  },
  {
    key: 'media.delete',
    module: 'media',
    label: 'Delete media',
    description: 'Delete media that is not used by published lessons.',
  },

  // Assessments
  {
    key: 'assessments.view',
    module: 'assessments',
    label: 'View assessments',
    description: 'View question banks and assessment configuration.',
  },
  {
    key: 'assessments.create',
    module: 'assessments',
    label: 'Create assessments',
    description: 'Create assessments, question banks and questions.',
  },
  {
    key: 'assessments.update',
    module: 'assessments',
    label: 'Update assessments',
    description: 'Edit assessments and question versions.',
  },
  {
    key: 'assessment_attempts.view',
    module: 'assessments',
    label: 'View attempts',
    description: 'View learner attempts and answers.',
    scoped: true,
  },
  {
    key: 'assessment_attempts.grade',
    module: 'assessments',
    label: 'Grade attempts',
    description: 'Review and grade open-ended answers.',
    scoped: true,
  },
  {
    key: 'assessment_scores.override',
    module: 'assessments',
    label: 'Override scores',
    description: 'Override a graded score with a recorded reason.',
    scoped: true,
  },

  // AI coaching
  {
    key: 'ai_scenarios.view',
    module: 'ai',
    label: 'View AI scenarios',
    description: 'View scenarios, personas and rubrics.',
  },
  {
    key: 'ai_scenarios.create',
    module: 'ai',
    label: 'Create AI scenarios',
    description: 'Create scenarios, personas and rubrics.',
  },
  {
    key: 'ai_scenarios.update',
    module: 'ai',
    label: 'Update AI scenarios',
    description: 'Edit scenarios, which creates a new prompt version.',
  },
  {
    key: 'ai_sessions.view',
    module: 'ai',
    label: 'View AI sessions',
    description: 'Read role-play transcripts and scorecards of others.',
    scoped: true,
  },
  {
    key: 'ai_sessions.review',
    module: 'ai',
    label: 'Review AI sessions',
    description: 'Leave coaching feedback on role-play sessions.',
    scoped: true,
  },
  {
    key: 'ai_settings.manage',
    module: 'ai',
    label: 'Manage AI settings',
    description: 'Choose providers, models and usage limits.',
  },
  {
    key: 'ai_usage.view',
    module: 'ai',
    label: 'View AI usage',
    description: 'View token usage and cost analytics.',
  },

  // Certifications
  {
    key: 'certifications.view',
    module: 'certifications',
    label: 'View certifications',
    description: 'View certification definitions and requirements.',
  },
  {
    key: 'certifications.create',
    module: 'certifications',
    label: 'Create certifications',
    description: 'Create certification definitions.',
  },
  {
    key: 'certifications.update',
    module: 'certifications',
    label: 'Update certifications',
    description: 'Edit requirements, validity and issuance settings.',
  },
  {
    key: 'certificates.view',
    module: 'certifications',
    label: 'View issued certificates',
    description: 'View certificates issued to other people.',
    scoped: true,
  },
  {
    key: 'certificates.issue',
    module: 'certifications',
    label: 'Issue certificates',
    description: 'Issue certificates manually to eligible people.',
    scoped: true,
  },
  {
    key: 'certificates.reissue',
    module: 'certifications',
    label: 'Reissue certificates',
    description: 'Reissue a certificate with corrected details.',
  },
  {
    key: 'certificates.revoke',
    module: 'certifications',
    label: 'Revoke certificates',
    description: 'Revoke an issued certificate with a reason.',
  },
  {
    key: 'certificate_approvals.decide',
    module: 'certifications',
    label: 'Approve certifications',
    description: 'Approve or reject certification requests.',
    scoped: true,
  },
  {
    key: 'certificate_templates.view',
    module: 'certifications',
    label: 'View templates',
    description: 'View certificate templates.',
  },
  {
    key: 'certificate_templates.create',
    module: 'certifications',
    label: 'Create templates',
    description: 'Create and clone certificate templates.',
  },
  {
    key: 'certificate_templates.update',
    module: 'certifications',
    label: 'Update templates',
    description: 'Edit, publish and archive certificate templates.',
  },
  {
    key: 'signatures.manage',
    module: 'certifications',
    label: 'Manage signatures',
    description: 'Manage authorized signatories and signature images.',
  },
  {
    key: 'stamps.manage',
    module: 'certifications',
    label: 'Manage stamps',
    description: 'Manage company stamps and seals.',
  },

  // Reporting
  {
    key: 'analytics.view',
    module: 'reporting',
    label: 'View analytics',
    description: 'View dashboards and training analytics.',
    scoped: true,
  },
  {
    key: 'reports.view',
    module: 'reporting',
    label: 'View reports',
    description: 'Run reports.',
    scoped: true,
  },
  {
    key: 'reports.export',
    module: 'reporting',
    label: 'Export reports',
    description: 'Export report data to files.',
    scoped: true,
  },
  {
    key: 'audit_logs.view',
    module: 'reporting',
    label: 'View audit log',
    description: 'View the immutable audit trail.',
  },

  // Notifications
  {
    key: 'notifications.manage',
    module: 'notifications',
    label: 'Manage notifications',
    description: 'Edit notification templates and reminder rules.',
  },

  // Self-service
  {
    key: 'training.participate',
    module: 'self',
    label: 'Take training',
    description: 'Access assigned programs and lessons.',
  },
  {
    key: 'assessments.take',
    module: 'self',
    label: 'Take assessments',
    description: 'Start and submit assessment attempts.',
  },
  {
    key: 'ai_practice.use',
    module: 'self',
    label: 'Use AI trainer',
    description: 'Practice role-play conversations with the AI homeowner.',
  },
  {
    key: 'certificates.view_own',
    module: 'self',
    label: 'View own certificates',
    description: 'View and download own certificates.',
  },

  // Platform
  {
    key: 'organizations.manage',
    module: 'platform',
    label: 'Manage organizations',
    description: 'Create and administer organizations.',
    platform: true,
  },
  {
    key: 'platform.configure',
    module: 'platform',
    label: 'Configure platform',
    description: 'Change platform-wide configuration.',
    platform: true,
  },
] as const satisfies readonly PermissionDefinition[];

export type PermissionKey = (typeof definitions)[number]['key'];

export const PERMISSIONS: readonly (PermissionDefinition & { key: PermissionKey })[] = definitions;

export const PERMISSION_KEYS: readonly PermissionKey[] = definitions.map((d) => d.key);

const byKey = new Map<string, PermissionDefinition>(definitions.map((d) => [d.key, d]));

export function isPermissionKey(value: string): value is PermissionKey {
  return byKey.has(value);
}

export function getPermission(key: PermissionKey): PermissionDefinition {
  const def = byKey.get(key);
  if (!def) throw new Error(`Unknown permission ${key}`);
  return def;
}

export function permissionsByModule(): Array<{
  module: (typeof PERMISSION_MODULES)[number];
  permissions: PermissionDefinition[];
}> {
  return PERMISSION_MODULES.map((module) => ({
    module,
    permissions: definitions.filter((d) => d.module === module.key),
  }));
}
