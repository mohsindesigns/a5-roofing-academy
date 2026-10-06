import { describe, expect, it } from 'vitest';
import {
  Principal,
  TokenError,
  generateAccessKeys,
  scopeAdmitsUser,
  signAccessToken,
  signLessonGrant,
  signPrincipalToken,
  signServiceToken,
  verifyAccessToken,
  verifyLessonGrant,
  verifyPrincipalToken,
  verifyServiceToken,
} from './index.js';

const SECRET = 'internal-secret-for-tests-0123456789abcdef';
const USER = '0190a3b2-0000-7000-8000-0000000000c1';
const ORG = '0190a3b2-0000-7000-8000-0000000000c2';
const TEAM = '0190a3b2-0000-7000-8000-0000000000c3';

const managerData = {
  userId: USER,
  organizationId: ORG,
  sessionId: 'sess-1',
  displayName: 'Danielle Okafor',
  roles: ['manager'],
  permissions: { 'enrollments.view': 'managed', 'training.participate': 'own' } as const,
  managedTeamIds: [TEAM],
  managedUserIds: [],
};

describe('access tokens', () => {
  it('signs and verifies Ed25519 tokens', async () => {
    const keys = await generateAccessKeys();
    const token = await signAccessToken({ sub: USER, sid: 's1', org: ORG }, keys, 600);
    await expect(verifyAccessToken(token, keys.publicKey)).resolves.toEqual({
      sub: USER,
      sid: 's1',
      org: ORG,
    });
  });

  it('rejects tokens signed by another key', async () => {
    const a = await generateAccessKeys();
    const b = await generateAccessKeys();
    const token = await signAccessToken({ sub: USER, sid: 's1', org: ORG }, a, 600);
    await expect(verifyAccessToken(token, b.publicKey)).rejects.toBeInstanceOf(TokenError);
  });

  it('reports expiry distinctly', async () => {
    const keys = await generateAccessKeys();
    const token = await signAccessToken({ sub: USER, sid: 's1', org: ORG }, keys, -10);
    await expect(verifyAccessToken(token, keys.publicKey)).rejects.toMatchObject({
      code: 'expired',
    });
  });
});

describe('principal tokens', () => {
  it('round-trips permissions and scope', async () => {
    const principal = await verifyPrincipalToken(
      await signPrincipalToken(managerData, SECRET),
      SECRET,
    );
    expect(principal.can('enrollments.view')).toBe(true);
    expect(principal.can('users.create')).toBe(false);
    expect(principal.scopeFilter('enrollments.view')).toMatchObject({
      kind: 'managed',
      teamIds: [TEAM],
    });
    expect(principal.scopeFilter('users.view')).toEqual({ kind: 'none' });
  });

  it('cannot be verified with a different secret or as a grant', async () => {
    const token = await signPrincipalToken(managerData, SECRET);
    await expect(verifyPrincipalToken(token, `${SECRET}x`)).rejects.toBeInstanceOf(TokenError);
    await expect(verifyLessonGrant(token, SECRET)).rejects.toBeInstanceOf(TokenError);
  });

  it('service tokens are not principals', async () => {
    const svc = await signServiceToken('certification-service', SECRET);
    await expect(verifyServiceToken(svc, SECRET)).resolves.toEqual({
      service: 'certification-service',
    });
    await expect(
      verifyServiceToken(await signPrincipalToken(managerData, SECRET), SECRET),
    ).rejects.toThrow();
  });
});

describe('lesson grants', () => {
  it('carries the resource and policy', async () => {
    const grant = {
      userId: USER,
      organizationId: ORG,
      programId: USER,
      enrollmentId: USER,
      lessonId: USER,
      resource: { type: 'media' as const, id: TEAM },
      policy: { minWatchPercent: 90 },
    };
    await expect(verifyLessonGrant(await signLessonGrant(grant, SECRET), SECRET)).resolves.toEqual(
      grant,
    );
  });
});

describe('scopeAdmitsUser', () => {
  const principal = new Principal({ ...managerData, permissions: { ...managerData.permissions } });
  const filter = principal.scopeFilter('enrollments.view');

  it('admits members of managed teams and self', () => {
    expect(scopeAdmitsUser(filter, { userId: 'rep', organizationId: ORG, teamIds: [TEAM] })).toBe(
      true,
    );
    expect(scopeAdmitsUser(filter, { userId: USER, organizationId: ORG, teamIds: [] })).toBe(true);
  });

  it('rejects users outside managed teams and other organizations', () => {
    expect(
      scopeAdmitsUser(filter, { userId: 'rep', organizationId: ORG, teamIds: ['other'] }),
    ).toBe(false);
    expect(
      scopeAdmitsUser(filter, { userId: 'rep', organizationId: 'other', teamIds: [TEAM] }),
    ).toBe(false);
  });
});
