import type { PermissionSet } from '@a5/permissions';

export interface CenterNavItem {
  to: string;
  label: string;
  /** Match the path exactly (the overview) instead of by prefix. */
  end?: boolean;
  visible: (p: PermissionSet) => boolean;
}

export const CENTER_ROOT = '/certification-center';

/**
 * Sub-navigation of the certification center. Entries appear only when the user holds the
 * permission the page's API needs; each page also checks on its own and the API enforces it.
 */
export const CENTER_NAV: CenterNavItem[] = [
  { to: CENTER_ROOT, label: 'Overview', end: true, visible: (p) => p.has('certificates.view') },
  { to: `${CENTER_ROOT}/team`, label: 'Team', visible: (p) => p.has('certificates.view') },
  {
    to: `${CENTER_ROOT}/approvals`,
    label: 'Approvals',
    visible: (p) => p.has('certificate_approvals.decide'),
  },
  { to: `${CENTER_ROOT}/issued`, label: 'Issued', visible: (p) => p.has('certificates.view') },
  {
    to: `${CENTER_ROOT}/renewals`,
    label: 'Expiry and renewals',
    visible: (p) => p.has('certificates.view'),
  },
  {
    to: `${CENTER_ROOT}/certifications`,
    label: 'Certifications',
    visible: (p) => p.has('certifications.view'),
  },
  {
    to: `${CENTER_ROOT}/templates`,
    label: 'Templates',
    visible: (p) => p.has('certificate_templates.view'),
  },
  {
    to: `${CENTER_ROOT}/signatories`,
    label: 'Signatories',
    visible: (p) => p.has('signatures.manage'),
  },
  { to: `${CENTER_ROOT}/stamps`, label: 'Stamps', visible: (p) => p.has('stamps.manage') },
  {
    to: `${CENTER_ROOT}/settings`,
    label: 'Numbering and settings',
    visible: (p) => p.hasAny(['certifications.view', 'settings.view']),
  },
];

export function visibleCenterNav(p: PermissionSet): CenterNavItem[] {
  return CENTER_NAV.filter((i) => i.visible(p));
}
