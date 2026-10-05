import type { certification as c } from '@a5/contracts';
import type { Tone } from '@/components/ui';
import { formatDate } from '@/lib/format';
import type {
  Approval,
  CandidateStatus,
  CertificateSummary,
  CertificationStatus,
  MyCertificationState,
  ReissueReason,
  TeamState,
} from './types';

export interface StatusInfo {
  label: string;
  tone: Tone;
}

/** Certificate lifecycle as shown to people. `superseded` means a newer certificate replaced it. */
export const CERTIFICATE_STATUS: Record<CertificateSummary['effectiveStatus'], StatusInfo> = {
  issued: { label: 'Active', tone: 'success' },
  expired: { label: 'Expired', tone: 'danger' },
  revoked: { label: 'Revoked', tone: 'danger' },
  superseded: { label: 'Replaced', tone: 'neutral' },
};

/** Trainee-facing state of a certification (certificate and progress combined). */
export const MY_STATE: Record<MyCertificationState, StatusInfo & { hint: string }> = {
  active: { label: 'Active', tone: 'success', hint: 'Your certificate is current.' },
  expiring: {
    label: 'Expiring soon',
    tone: 'warning',
    hint: 'Your certificate is still valid but will expire soon.',
  },
  renewal_required: {
    label: 'Renewal required',
    tone: 'warning',
    hint: 'Complete the renewal requirements before your certificate expires.',
  },
  pending_approval: {
    label: 'Pending approval',
    tone: 'information',
    hint: 'You met every requirement. An approver is reviewing your results.',
  },
  eligible: {
    label: 'Requirements met',
    tone: 'information',
    hint: 'You met every requirement. Your certificate is being issued.',
  },
  in_progress: {
    label: 'In progress',
    tone: 'neutral',
    hint: 'Finish the remaining requirements to earn this certification.',
  },
  expired: { label: 'Expired', tone: 'danger', hint: 'This certificate is no longer valid.' },
  revoked: { label: 'Revoked', tone: 'danger', hint: 'This certificate is no longer valid.' },
};

export const TEAM_STATE: Record<TeamState, StatusInfo> = {
  certified: { label: 'Certified', tone: 'success' },
  expiring: { label: 'Expiring soon', tone: 'warning' },
  renewal_required: { label: 'Renewal due', tone: 'warning' },
  expired: { label: 'Expired', tone: 'danger' },
  revoked: { label: 'Revoked', tone: 'danger' },
  pending_approval: { label: 'Pending approval', tone: 'information' },
  eligible: { label: 'Ready to issue', tone: 'information' },
  in_progress: { label: 'In progress', tone: 'neutral' },
};

export const CANDIDATE_STATUS: Record<CandidateStatus, StatusInfo> = {
  in_progress: { label: 'In progress', tone: 'neutral' },
  eligible: { label: 'Ready to issue', tone: 'information' },
  pending_approval: { label: 'Pending approval', tone: 'information' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Not approved', tone: 'danger' },
  issued: { label: 'Issued', tone: 'success' },
};

export const APPROVAL_STATUS: Record<Approval['status'], StatusInfo> = {
  pending: { label: 'Waiting for a decision', tone: 'information' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Not approved', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const APPROVAL_KIND: Record<Approval['kind'], string> = {
  manager: 'Manager approval',
  trainer: 'Trainer approval',
  manual_review: 'Manual review',
};

export const APPROVAL_POLICY_LABEL: Record<c.ApprovalPolicy, string> = {
  none: 'No approval needed',
  manager: "The person's manager approves",
  trainer: "The person's trainer approves",
  manual_review: 'An administrator reviews',
};

export const PDF_STATUS: Record<CertificateSummary['pdfStatus'], StatusInfo> = {
  ready: { label: 'Ready', tone: 'success' },
  pending: { label: 'Preparing', tone: 'information' },
  failed: { label: 'Failed', tone: 'danger' },
};

export const ISSUE_MODE: Record<CertificateSummary['mode'], string> = {
  automatic: 'Issued automatically',
  manual: 'Issued by an administrator',
  approval: 'Issued after approval',
  reissue: 'Reissued',
  renewal: 'Renewal',
};

export const REISSUE_REASONS: Array<{ value: ReissueReason; label: string }> = [
  { value: 'corrected_name', label: 'Correct the recipient name' },
  { value: 'corrected_data', label: 'Correct other details' },
  { value: 'administrative', label: 'Administrative change' },
];

export const CERTIFICATION_STATUS: Record<CertificationStatus, StatusInfo> = {
  draft: { label: 'Draft', tone: 'neutral' },
  active: { label: 'Active', tone: 'success' },
  archived: { label: 'Archived', tone: 'neutral' },
};

const DAY_MS = 86_400_000;

/** Whole days from `now` until `value` (negative when past). */
export function daysUntil(value: string, now = Date.now()): number {
  return Math.ceil((new Date(value).getTime() - now) / DAY_MS);
}

/** "Expires Mar 3, 2028 (in 14 days)" or "No expiration date". */
export function expiryText(expiresAt: string | null, now = Date.now()): string {
  if (!expiresAt) return 'No expiration date';
  const days = daysUntil(expiresAt, now);
  const date = formatDate(expiresAt);
  if (days < 0) return `Expired ${date}`;
  if (days === 0) return `Expires today (${date})`;
  if (days <= 90) return `Expires ${date} (in ${days} ${days === 1 ? 'day' : 'days'})`;
  return `Expires ${date}`;
}

export function describeValidity(v: c.ValidityPolicy): string {
  switch (v.kind) {
    case 'none':
      return 'Never expires';
    case 'months':
      return `${v.months} ${v.months === 1 ? 'month' : 'months'} from issue`;
    case 'years':
      return `${v.years} ${v.years === 1 ? 'year' : 'years'} from issue`;
    case 'fixed_date':
      return `Expires ${formatDate(v.date)}`;
  }
}
