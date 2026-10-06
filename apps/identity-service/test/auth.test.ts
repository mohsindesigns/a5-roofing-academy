import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAccessToken, importAccessKeys, unsealLink } from '@a5/auth';
import { TEST_INTERNAL_SECRET } from '@a5/nest-kit/testing';
import { PEOPLE } from '@a5/seed-data';
import { iamKeys } from '../src/common/iam-keys.js';
import { cookie, createIdentityHarness, type IdentityHarness } from './harness.js';

let h: IdentityHarness;

beforeAll(async () => {
  h = await createIdentityHarness('auth');
});
afterAll(() => h?.close());

async function login(email: string, password: string) {
  return h.http.post('/api/v1/auth/login').send({ email, password });
}

function sessionCookies(res: { headers: Record<string, unknown> }) {
  const rt = cookie(res, 'a5_rt');
  const csrf = cookie(res, 'a5_csrf');
  return { rt, csrf, header: `a5_rt=${rt}; a5_csrf=${csrf}` };
}

describe('login', () => {
  it('issues a verifiable access token, a session and cookies', async () => {
    const res = await login(h.email('marcus'), h.password);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      displayName: 'Marcus Delgado',
      organizationName: 'A5 Roofing',
    });
    expect(res.body.user.roles.map((r: { key: string }) => r.key)).toEqual(['sales_rep']);
    const keys = await importAccessKeys(undefined, h.config.auth.publicKeyPem);
    const claims = await verifyAccessToken(res.body.accessToken, keys.publicKey);
    expect(claims.sub).toBe(PEOPLE.marcus.id);
    expect(await h.redis.exists(iamKeys.session(h.ns, res.body.sessionId))).toBe(1);
    const rtCookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('a5_rt='),
    )!;
    expect(rtCookie).toContain('HttpOnly');
    expect(rtCookie).toContain('SameSite=Strict');
    expect(rtCookie).toContain('Path=/api/v1/auth');
  });

  it('is case-insensitive on email', async () => {
    expect((await login(h.email('tyler').toUpperCase(), h.password)).status).toBe(200);
  });

  it('rejects wrong passwords and unknown emails identically', async () => {
    const wrong = await login(h.email('kayla'), 'not-the-password');
    const unknown = await login('nobody@a5roofing.example', 'whatever-password');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('locks the account after the configured number of failures', async () => {
    const email = h.email('jordan');
    for (let i = 0; i < 4; i++)
      expect((await login(email, 'bad-password-attempt')).status).toBe(401);
    const locked = await login(email, 'bad-password-attempt');
    // Indistinguishable from a wrong password, so lockout does not reveal that the account exists.
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe('INVALID_CREDENTIALS');
    // Even the right password is refused while locked.
    const refused = await login(email, h.password);
    expect(refused.status).toBe(401);
    expect(refused.body.error.message).toBe(locked.body.error.message);
    const attempts = await h.db
      .selectFrom('login_attempts')
      .select('reason')
      .where('user_id', '=', PEOPLE.jordan.id)
      .execute();
    expect(attempts.map((a) => a.reason)).toContain('locked_after_failures');
  });

  it('counts parallel failed attempts atomically', async () => {
    const target = h.email('hector');
    await Promise.all(Array.from({ length: 5 }, () => login(target, 'bad-password-attempt')));
    const row = await h.db
      .selectFrom('users')
      .select('locked_until')
      .where('id', '=', PEOPLE.hector.id)
      .executeTakeFirstOrThrow();
    expect(row.locked_until).not.toBeNull();
  });

  it('refuses deactivated accounts only after a correct password', async () => {
    await h.db
      .updateTable('users')
      .set({ status: 'deactivated' })
      .where('id', '=', PEOPLE.darius.id)
      .execute();
    expect((await login(h.email('darius'), 'wrong-password-123')).body.error.code).toBe(
      'INVALID_CREDENTIALS',
    );
    const res = await login(h.email('darius'), h.password);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('refresh token rotation', () => {
  it('rotates tokens and requires the CSRF header', async () => {
    const first = await login(h.email('brianna'), h.password);
    const c = sessionCookies(first);
    const noCsrf = await h.http.post('/api/v1/auth/refresh').set('Cookie', c.header);
    expect(noCsrf.status).toBe(403);

    const refreshed = await h.http
      .post('/api/v1/auth/refresh')
      .set('Cookie', c.header)
      .set('x-csrf-token', c.csrf!);
    expect(refreshed.status).toBe(200);
    const next = sessionCookies(refreshed);
    expect(next.rt).not.toBe(c.rt);
    expect(refreshed.body.sessionId).toBe(first.body.sessionId);
  });

  it('revokes the session when a rotated token is replayed after the grace window', async () => {
    const first = await login(h.email('caleb'), h.password);
    const c = sessionCookies(first);
    await h.http
      .post('/api/v1/auth/refresh')
      .set('Cookie', c.header)
      .set('x-csrf-token', c.csrf!)
      .expect(200);
    // Age the rotation beyond the concurrency grace window.
    await h.db
      .updateTable('refresh_tokens')
      .set({ rotated_at: new Date(Date.now() - 60_000) })
      .where('session_id', '=', first.body.sessionId)
      .where('rotated_at', 'is not', null)
      .execute();
    const replay = await h.http
      .post('/api/v1/auth/refresh')
      .set('Cookie', c.header)
      .set('x-csrf-token', c.csrf!);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('SESSION_REVOKED');
    const session = await h.db
      .selectFrom('sessions')
      .select(['revoked_reason'])
      .where('id', '=', first.body.sessionId)
      .executeTakeFirstOrThrow();
    expect(session.revoked_reason).toBe('refresh_token_reuse');
    expect(await h.redis.exists(iamKeys.session(h.ns, first.body.sessionId))).toBe(0);
  });

  it('honours a just-rotated token from a concurrent tab', async () => {
    const first = await login(h.email('naomi'), h.password);
    const c = sessionCookies(first);
    await h.http
      .post('/api/v1/auth/refresh')
      .set('Cookie', c.header)
      .set('x-csrf-token', c.csrf!)
      .expect(200);
    await h.http
      .post('/api/v1/auth/refresh')
      .set('Cookie', c.header)
      .set('x-csrf-token', c.csrf!)
      .expect(200);
  });
});

describe('logout and sessions', () => {
  it('logout revokes the session immediately', async () => {
    const res = await login(h.email('isaiah'), h.password);
    const sid = res.body.sessionId as string;
    const headers = await h.as('isaiah');
    // Gateway would include the session id; emulate with a principal carrying it.
    await h.http
      .post('/api/v1/auth/logout')
      .set(headers)
      .set('Cookie', sessionCookies(res).header)
      .set('x-csrf-token', sessionCookies(res).csrf!)
      .expect(200);
    expect(await h.redis.exists(iamKeys.session(h.ns, sid))).toBe(0);
    const row = await h.db
      .selectFrom('sessions')
      .select('revoked_at')
      .where('id', '=', sid)
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).toBeInstanceOf(Date);
  });

  it('lists own sessions', async () => {
    await login(h.email('sofia'), h.password);
    const res = await h.http.get('/api/v1/auth/sessions').set(await h.as('sofia'));
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
  });
});

describe('password reset', () => {
  it('always answers 202 and emails a reset link for active accounts only', async () => {
    expect(
      (await h.http.post('/api/v1/auth/password/forgot').send({ email: 'ghost@a5roofing.example' }))
        .status,
    ).toBe(202);
    expect(
      (await h.http.post('/api/v1/auth/password/forgot').send({ email: h.email('ethan') })).status,
    ).toBe(202);
    const events = await h.db
      .selectFrom('outbox_events')
      .select('envelope')
      .where('type', '=', 'identity.password_reset.requested')
      .execute();
    expect(events).toHaveLength(1);
  });

  it('resets with a valid token once and revokes sessions', async () => {
    const before = await login(h.email('ethan'), h.password);
    const event = await h.db
      .selectFrom('outbox_events')
      .select('envelope')
      .where('type', '=', 'identity.password_reset.requested')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    const stored = (event.envelope as { payload: { resetUrl: string } }).payload.resetUrl;
    // The outbox never holds a usable link; only the notification service can open it.
    expect(stored).not.toContain('token=');
    const url = new URL(unsealLink(TEST_INTERNAL_SECRET, stored));
    const token = url.searchParams.get('token')!;

    const info = await h.http.get(`/api/v1/auth/tokens/${token}`);
    expect(info.body).toMatchObject({ purpose: 'password_reset', displayName: 'Ethan Kowalski' });

    const weak = await h.http
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'short1' });
    expect(weak.status).toBe(400);
    const tooCommon = await h.http
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'ethankowalski2026' });
    expect(tooCommon.status).toBe(400);
    expect(tooCommon.body.error.fields[0].message).toMatch(/name/);

    const ok = await h.http
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'Shingle-Tear-Off-42' });
    expect(ok.status).toBe(200);
    expect(
      (
        await h.http
          .post('/api/v1/auth/password/reset')
          .send({ token, password: 'Another-Pass-9876' })
      ).status,
    ).toBe(410);
    expect(await h.redis.exists(iamKeys.session(h.ns, before.body.sessionId))).toBe(0);
    expect((await login(h.email('ethan'), 'Shingle-Tear-Off-42')).status).toBe(200);
  });
});

describe('me', () => {
  it('returns permissions and feature flags for the UI', async () => {
    const res = await h.http.get('/api/v1/auth/me').set(await h.as('danielle'));
    expect(res.status).toBe(200);
    expect(res.body.permissions['enrollments.view']).toBe('managed');
    expect(res.body.featureFlags.manager_approvals).toBe(true);
    expect(res.body.managedTeamIds).toHaveLength(1);
  });
});
