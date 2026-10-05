import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serviceHeaders } from '@a5/nest-kit/testing';
import { PEOPLE, TEAMS, ORGANIZATION } from '@a5/seed-data';
import { iamKeys } from '../src/common/iam-keys.js';
import { createIdentityHarness, type IdentityHarness } from './harness.js';

let h: IdentityHarness;

beforeAll(async () => {
  h = await createIdentityHarness('rbac');
});
afterAll(() => h?.close());

async function roleId(key: string): Promise<string> {
  const row = await h.db.selectFrom('roles').select('id').where('key', '=', key).where('organization_id', '=', ORGANIZATION.id).executeTakeFirstOrThrow();
  return row.id;
}

describe('representatives', () => {
  it('cannot use administrative APIs', async () => {
    const rep = await h.as('marcus');
    expect((await h.http.get('/api/v1/users').set(rep)).status).toBe(403);
    expect((await h.http.get('/api/v1/roles').set(rep)).status).toBe(403);
    expect((await h.http.post('/api/v1/teams').set(rep).send({ name: 'Rogue team' })).status).toBe(403);
    expect((await h.http.put('/api/v1/feature-flags/voice_ai').set(rep).send({ enabled: true })).status).toBe(403);
  });

  it('can read their own profile but not a colleague', async () => {
    const rep = await h.as('marcus');
    expect((await h.http.get(`/api/v1/users/${PEOPLE.marcus.id}`).set(rep)).status).toBe(200);
    expect((await h.http.get(`/api/v1/users/${PEOPLE.tyler.id}`).set(rep)).status).toBe(404);
  });
});

describe('manager data scope', () => {
  it('lists only people in managed teams plus direct reports', async () => {
    const res = await h.http.get('/api/v1/users?pageSize=100').set(await h.as('danielle'));
    expect(res.status).toBe(200);
    const names = res.body.items.map((u: { displayName: string }) => u.displayName).sort();
    const teamA = TEAMS.find((t) => t.name === 'Dallas Residential A')!;
    const expected = [...teamA.members.map((m) => `${PEOPLE[m].firstName} ${PEOPLE[m].lastName}`), 'Danielle Okafor'].sort();
    expect(names).toEqual(expected);
  });

  it('cannot open a user from another team', async () => {
    const res = await h.http.get(`/api/v1/users/${PEOPLE.naomi.id}`).set(await h.as('danielle'));
    expect(res.status).toBe(404);
  });

  it('sees only managed teams', async () => {
    const res = await h.http.get('/api/v1/teams').set(await h.as('luis'));
    expect(res.body.items.map((t: { name: string }) => t.name)).toEqual(['Fort Worth Storm Response']);
  });

  it('trainers see assigned trainees across teams', async () => {
    const res = await h.http.get('/api/v1/users?pageSize=100').set(await h.as('hector'));
    const ids = res.body.items.map((u: { id: string }) => u.id);
    expect(ids).toEqual(expect.arrayContaining([PEOPLE.naomi.id, PEOPLE.devon.id]));
    expect(ids).not.toContain(PEOPLE.marcus.id);
  });
});

describe('role management', () => {
  it('trainers cannot modify system roles', async () => {
    const res = await h.http
      .put(`/api/v1/roles/${await roleId('sales_rep')}/permissions`)
      .set(await h.as('hector'))
      .send({ permissions: ['training.participate'] });
    expect(res.status).toBe(403);
  });

  it('administrators lacking permissions.manage receive 403', async () => {
    const res = await h.http
      .put(`/api/v1/roles/${await roleId('manager')}/permissions`)
      .set(await h.as('grant'))
      .send({ permissions: ['users.view'] });
    expect(res.status).toBe(403);
    expect(res.body.error.details.required).toEqual(['permissions.manage']);
  });

  it('the super administrator role is immutable', async () => {
    const res = await h.http
      .put(`/api/v1/roles/${await roleId('super_admin')}/permissions`)
      .set(await h.as('priya'))
      .send({ permissions: ['users.view'] });
    expect(res.status).toBe(403);
  });

  it('creates, clones and archives custom roles', async () => {
    const admin = await h.as('priya');
    const created = await h.http
      .post('/api/v1/roles')
      .set(admin)
      .send({ name: 'Regional Sales Director', dataScope: 'organization', cloneFromRoleId: await roleId('manager') });
    expect(created.status).toBe(201);
    expect(created.body.permissions).toContain('certificate_approvals.decide');
    expect(created.body.isSystem).toBe(false);

    const duplicate = await h.http.post('/api/v1/roles').set(admin).send({ name: 'regional sales director', dataScope: 'own' });
    expect(duplicate.status).toBe(409);

    const archived = await h.http.post(`/api/v1/roles/${created.body.id}/archive`).set(admin);
    expect(archived.status).toBe(200);
    expect(archived.body.archived).toBe(true);
  });

  it('refuses to archive roles that are in use', async () => {
    const res = await h.http.post(`/api/v1/roles/${await roleId('trainer')}/archive`).set(await h.as('priya'));
    expect(res.status).toBe(422);
  });

  it('resets a modified system role to defaults', async () => {
    const admin = await h.as('priya');
    const id = await roleId('auditor');
    await h.http.put(`/api/v1/roles/${id}/permissions`).set(admin).send({ permissions: ['users.view'] }).expect(200);
    const modified = await h.http.get(`/api/v1/roles/${id}`).set(admin);
    expect(modified.body.modifiedFromDefault).toBe(true);
    const reset = await h.http.post(`/api/v1/roles/${id}/reset`).set(admin);
    expect(reset.status).toBe(200);
    expect(reset.body.modifiedFromDefault).toBe(false);
    expect(reset.body.permissions).toContain('audit_logs.view');
  });

  it('records an audit event for permission changes', async () => {
    const audits = await h.db.selectFrom('outbox_events').select('envelope').where('type', '=', 'audit.recorded').execute();
    const actions = audits.map((a) => (a.envelope as { payload: { action: string } }).payload.action);
    expect(actions).toContain('role.permissions_changed');
    expect(actions).toContain('role.cloned');
  });
});

describe('privilege escalation', () => {
  it('a custom-role admin cannot grant permissions they do not hold', async () => {
    const admin = await h.as('priya');
    const limited = await h.http
      .post('/api/v1/roles')
      .set(admin)
      .send({ name: 'People Coordinator', dataScope: 'organization', permissions: ['users.view', 'roles.view', 'roles.update', 'permissions.manage', 'roles.create'] });
    expect(limited.status).toBe(201);
    await h.http.put(`/api/v1/users/${PEOPLE.ruth.id}/roles`).set(admin).send({ roleIds: [limited.body.id] }).expect(200);

    const ruth = await h.as('ruth');
    const escalate = await h.http
      .put(`/api/v1/roles/${limited.body.id}/permissions`)
      .set(ruth)
      .send({ permissions: ['users.view', 'roles.view', 'roles.update', 'permissions.manage', 'roles.create', 'users.delete'] });
    expect(escalate.status).toBe(403);
    expect(escalate.body.error.details.permissions).toEqual(['users.delete']);

    const widen = await h.http.post('/api/v1/roles').set(ruth).send({ name: 'Shadow admin', dataScope: 'platform', permissions: [] });
    expect(widen.status).toBe(400);
  });

  it('administrators cannot assign roles granting permissions they lack', async () => {
    const res = await h.http.put(`/api/v1/users/${PEOPLE.tyler.id}/roles`).set(await h.as('grant')).send({ roleIds: [await roleId('super_admin')] });
    expect(res.status).toBe(403);
  });

  it('users cannot change their own roles', async () => {
    const res = await h.http.put(`/api/v1/users/${PEOPLE.priya.id}/roles`).set(await h.as('priya')).send({ roleIds: [await roleId('admin')] });
    expect(res.status).toBe(403);
  });
});

describe('revocation takes effect immediately', () => {
  it('bumps the authorization epoch so the gateway re-resolves principals', async () => {
    const svc = await serviceHeaders('gateway');
    const first = await h.http.get(`/internal/principals/${PEOPLE.andre.id}`).set(svc);
    expect(first.body.principal.permissions['certificate_approvals.decide']).toBe('managed');

    const manager = await roleId('manager');
    const current = await h.http.get(`/api/v1/roles/${manager}`).set(await h.as('priya'));
    const without = current.body.permissions.filter((p: string) => p !== 'certificate_approvals.decide');
    await h.http.put(`/api/v1/roles/${manager}/permissions`).set(await h.as('priya')).send({ permissions: without }).expect(200);

    const epoch = await h.redis.get(iamKeys.epoch(h.ns, ORGANIZATION.id));
    expect(Number(epoch)).toBeGreaterThan(0);
    const after = await h.http.get(`/internal/principals/${PEOPLE.andre.id}`).set(svc);
    expect(after.body.principal.permissions['certificate_approvals.decide']).toBeUndefined();
  });

  it('deactivation revokes sessions and principal resolution', async () => {
    const login = await h.http.post('/api/v1/auth/login').send({ email: h.email('colton'), password: h.password });
    expect(login.status).toBe(200);
    const res = await h.http
      .post(`/api/v1/users/${PEOPLE.colton.id}/deactivate`)
      .set(await h.as('grant'))
      .send({ reason: 'Left the company' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('deactivated');
    expect(await h.redis.exists(iamKeys.session(h.ns, login.body.sessionId))).toBe(0);
    const svc = await serviceHeaders('gateway');
    const principal = await h.http.get(`/internal/principals/${PEOPLE.colton.id}?sessionId=${login.body.sessionId}`).set(svc);
    expect(principal.body).toEqual({ principal: null, sessionActive: false });
  });

  it('internal endpoints reject user principals', async () => {
    expect((await h.http.get(`/internal/principals/${PEOPLE.andre.id}`).set(await h.as('priya'))).status).toBe(401);
  });
});
