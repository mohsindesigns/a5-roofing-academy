import type { MyCertificationItem, MyCertificationState } from './types';

/** What matters first for the person: act on renewals, keep what is valid, then what is left. */
const ORDER: MyCertificationState[] = [
  'renewal_required',
  'expiring',
  'active',
  'pending_approval',
  'eligible',
  'in_progress',
  'expired',
  'revoked',
];

export function sortMine(items: readonly MyCertificationItem[]): MyCertificationItem[] {
  return [...items].sort(
    (a, b) =>
      ORDER.indexOf(a.state) - ORDER.indexOf(b.state) ||
      a.definition.name.localeCompare(b.definition.name),
  );
}

export type RenewalAction =
  { kind: 'renew'; requirementsLeft: number } | { kind: 'waiting'; message: string } | null;

/**
 * Renewing means completing the renewal requirements again; there is no separate "start" step in
 * the API. The renewal call to action is therefore offered only while a renewal is open (or lapsed
 * after expiry) and the requirements are not yet met.
 */
export function renewalAction(item: MyCertificationItem): RenewalAction {
  const renewal = item.renewal;
  if (!renewal || (renewal.status !== 'open' && renewal.status !== 'lapsed')) return null;
  if (item.state === 'revoked') return null;
  const progress = item.progress;
  if (progress && progress.purpose === 'renewal') {
    if (progress.status === 'pending_approval') {
      return { kind: 'waiting', message: 'Your renewal is waiting for approval.' };
    }
    if (progress.status === 'eligible' || progress.status === 'approved') {
      return {
        kind: 'waiting',
        message: 'You met the renewal requirements. Your new certificate is being issued.',
      };
    }
    return {
      kind: 'renew',
      requirementsLeft: Math.max(0, progress.totalCount - progress.metCount),
    };
  }
  return { kind: 'renew', requirementsLeft: 0 };
}

/** Does this item still show a requirement checklist? */
export function showsChecklist(item: MyCertificationItem): boolean {
  if (!item.progress || item.progress.requirements.length === 0) return false;
  return item.state !== 'active' && item.state !== 'revoked';
}
