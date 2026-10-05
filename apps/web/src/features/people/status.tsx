import type { identity } from '@a5/contracts';
import { StatusText, type Tone } from '@/components/ui';

const map: Record<identity.UserStatus, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'success' },
  invited: { label: 'Invited', tone: 'information' },
  locked: { label: 'Locked', tone: 'warning' },
  deactivated: { label: 'Deactivated', tone: 'neutral' },
};

export function UserStatus({ status }: { status: identity.UserStatus }) {
  const s = map[status];
  return <StatusText tone={s.tone}>{s.label}</StatusText>;
}
