import { describe, expect, it } from 'vitest';
import { renewalAction, showsChecklist, sortMine } from './mine';
import type { MyCertificationItem } from './types';

const ID = '0190aaaa-0000-7000-8000-0000000000a1';

function item(
  overrides: Partial<MyCertificationItem> & { name?: string } = {},
): MyCertificationItem {
  const { name = 'Certification', ...rest } = overrides;
  return {
    definition: {
      id: ID,
      name,
      code: 'CERT',
      publicDescription: null,
      badge: { label: null, color: '#B87333', assetId: null },
    },
    state: 'in_progress',
    certificate: null,
    progress: null,
    renewal: null,
    verificationUrl: null,
    ...rest,
  };
}

const renewal = (status: 'open' | 'lapsed' | 'completed' | 'cancelled') => ({
  id: ID,
  certificateId: ID,
  status,
  windowOpenedAt: '2026-09-01T00:00:00.000Z',
  dueAt: '2026-11-01T00:00:00.000Z',
  completedAt: null,
  newCertificateId: null,
});

const progress = (
  status: 'in_progress' | 'eligible' | 'pending_approval' | 'approved',
  metCount: number,
  totalCount: number,
) => ({
  definitionId: ID,
  userId: ID,
  status,
  purpose: 'renewal' as const,
  metCount,
  totalCount,
  requirements: [],
  evaluatedAt: null,
  eligibleAt: null,
  onHold: false,
  holdReason: null,
});

describe('sortMine', () => {
  it('puts renewals first, then what is valid, then what is left to earn, then what ended', () => {
    const sorted = sortMine([
      item({ name: 'F', state: 'revoked' }),
      item({ name: 'E', state: 'in_progress' }),
      item({ name: 'D', state: 'active' }),
      item({ name: 'C', state: 'expired' }),
      item({ name: 'B', state: 'renewal_required' }),
      item({ name: 'A', state: 'active' }),
    ]);
    expect(sorted.map((i) => i.definition.name)).toEqual(['B', 'A', 'D', 'E', 'C', 'F']);
  });
});

describe('renewalAction', () => {
  it('offers renewal only while a renewal is open or lapsed and the requirements are not met', () => {
    expect(renewalAction(item({ state: 'active' }))).toBeNull();
    expect(
      renewalAction(item({ state: 'renewal_required', renewal: renewal('completed') })),
    ).toBeNull();
    expect(renewalAction(item({ state: 'revoked', renewal: renewal('open') }))).toBeNull();
    expect(renewalAction(item({ state: 'renewal_required', renewal: renewal('open') }))).toEqual({
      kind: 'renew',
      requirementsLeft: 0,
    });
    expect(
      renewalAction(
        item({
          state: 'expired',
          renewal: renewal('lapsed'),
          progress: progress('in_progress', 1, 3),
        }),
      ),
    ).toEqual({
      kind: 'renew',
      requirementsLeft: 2,
    });
  });

  it('says what happens next once the renewal requirements are met', () => {
    const waiting = renewalAction(
      item({
        state: 'renewal_required',
        renewal: renewal('open'),
        progress: progress('pending_approval', 3, 3),
      }),
    );
    expect(waiting).toEqual({ kind: 'waiting', message: 'Your renewal is waiting for approval.' });
    const issuing = renewalAction(
      item({
        state: 'renewal_required',
        renewal: renewal('open'),
        progress: progress('eligible', 3, 3),
      }),
    );
    expect(issuing?.kind).toBe('waiting');
  });
});

describe('showsChecklist', () => {
  it('shows requirements while there is something left to do', () => {
    const requirement = {
      key: '0',
      type: 'x',
      description: 'Do it',
      satisfied: false,
      unknown: false,
      progress: null,
    };
    const withProgress = { ...progress('in_progress', 0, 1), requirements: [requirement] };
    expect(showsChecklist(item({ state: 'in_progress', progress: withProgress }))).toBe(true);
    expect(showsChecklist(item({ state: 'active', progress: withProgress }))).toBe(false);
    expect(showsChecklist(item({ state: 'in_progress', progress: null }))).toBe(false);
  });
});
