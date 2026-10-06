import type { DataScope } from '@a5/permissions';
import type { Approval } from './types';

/**
 * Reasons the signed-in approver cannot decide a request. This mirrors what the API enforces so
 * the buttons explain themselves instead of failing; the API remains the authority (it also knows
 * whether the approver is the person's trainer, which the client cannot tell).
 */
export function decisionBlocker(
  approval: Pick<Approval, 'status' | 'kind' | 'user'>,
  me: { userId: string | undefined; scope: DataScope | null },
): string | null {
  if (approval.status !== 'pending') return null;
  if (me.userId && approval.user.id === me.userId) {
    return 'You cannot decide your own certification. Ask another approver.';
  }
  const wide = me.scope === 'organization' || me.scope === 'platform';
  if (approval.kind === 'manual_review' && !wide) {
    return 'Manual review needs an administrator with organization-wide approval access.';
  }
  return null;
}
