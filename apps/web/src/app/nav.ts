import type { LucideIcon } from 'lucide-react';
import {
  Award,
  BarChart3,
  BookOpenCheck,
  Building2,
  ClipboardList,
  GraduationCap,
  LayoutDashboard,
  MessagesSquare,
  Settings,
  ShieldCheck,
  Users,
  UsersRound,
} from 'lucide-react';
import type { PermissionSet } from '@a5/permissions';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the phone bottom bar (max four primary items). */
  mobile?: boolean;
  visible: (p: PermissionSet) => boolean;
  /** Paths that also mark this item active. */
  match?: string[];
  /** Hidden until the feature ships (never show navigation to unbuilt screens). */
  ready?: boolean;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

/**
 * Navigation adapts to permissions. Hidden items are only a convenience: every page and API
 * enforces authorization on its own.
 */
export const NAV: NavSection[] = [
  {
    items: [
      { to: '/', label: 'Home', icon: LayoutDashboard, mobile: true, visible: () => true },
      {
        to: '/training',
        label: 'Training',
        icon: GraduationCap,
        mobile: true,
        visible: (p) => p.has('training.participate'),
      },
      {
        to: '/ai-coach',
        ready: false,
        label: 'AI Coach',
        icon: MessagesSquare,
        mobile: true,
        visible: (p) => p.has('ai_practice.use'),
      },
      {
        to: '/certifications',
        ready: false,
        label: 'Certifications',
        icon: Award,
        mobile: true,
        visible: (p) => p.has('certificates.view_own'),
      },
    ],
  },
  {
    label: 'Manage',
    items: [
      {
        to: '/team',
        label: 'Team',
        icon: UsersRound,
        visible: (p) =>
          p.hasAny(['enrollments.view', 'certificates.view']) &&
          p.scope('enrollments.view') !== 'own',
      },
      { to: '/people', label: 'People', icon: Users, visible: (p) => p.has('users.view') },
      {
        to: '/reports',
        label: 'Reports',
        icon: BarChart3,
        visible: (p) => p.hasAny(['reports.view', 'analytics.view']),
      },
    ],
  },
  {
    label: 'Build',
    items: [
      {
        to: '/content/programs',
        ready: false,
        label: 'Programs',
        icon: BookOpenCheck,
        visible: (p) => p.has('programs.view'),
        match: ['/content/programs'],
      },
      {
        to: '/content/assessments',
        ready: false,
        label: 'Assessments',
        icon: ClipboardList,
        visible: (p) => p.has('assessments.view'),
        match: ['/content/assessments', '/content/questions'],
      },
      {
        to: '/content/ai-scenarios',
        ready: false,
        label: 'AI scenarios',
        icon: MessagesSquare,
        visible: (p) => p.has('ai_scenarios.view'),
      },
      {
        to: '/certification-center',
        ready: false,
        label: 'Certification center',
        icon: ShieldCheck,
        visible: (p) => p.hasAny(['certifications.view', 'certificate_templates.view']),
      },
    ],
  },
  {
    label: 'Administration',
    items: [
      {
        to: '/admin/organization',
        label: 'Organization',
        icon: Building2,
        visible: (p) => p.hasAny(['organization.view', 'teams.manage', 'locations.manage']),
      },
      {
        to: '/admin/roles',
        label: 'Roles & permissions',
        icon: ShieldCheck,
        visible: (p) => p.has('roles.view'),
        match: ['/admin/roles', '/admin/permissions'],
      },
      {
        to: '/admin/settings',
        label: 'Settings',
        icon: Settings,
        visible: (p) =>
          p.hasAny(['settings.view', 'feature_flags.manage', 'security_settings.manage']),
      },
    ],
  },
];

export function visibleNav(p: PermissionSet): NavSection[] {
  return NAV.map((s) => ({
    ...s,
    items: s.items.filter((i) => i.ready !== false && i.visible(p)),
  })).filter((s) => s.items.length > 0);
}
