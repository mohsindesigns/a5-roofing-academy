import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORGANIZATION, PEOPLE, TEAMS, LOCATIONS } from '@a5/seed-data';
import { createIdentityHarness, type IdentityHarness } from './harness.js';

let h: IdentityHarness;
let repRoleId: string;

beforeAll(async () => {
  h = await createIdentityHarness('users');
  repRoleId = (
    await h.db
      .selectFrom('roles')
      .select('id')
      .where('key', '=', 'sales_rep')
      .where('organization_id', '=', ORGANIZATION.id)
      .executeTakeFirstOrThrow()
  ).id;
});
afterAll(() => h?.close());

describe('user lifecycle', () => {
  it('invites, activates and signs in a new representative', async () => {
    const admin = await h.as('grant');
    const teamA = TEAMS[0].id;
    const created = await h.http
      .post('/api/v1/users')
      .set(admin)
      .send({
        email: 'Wesley.Tran@a5roofing.example',
        firstName: 'Wesley',
        lastName: 'Tran',
        jobTitle: 'Sales Representative',
        employeeId: 'A5-1301',
        locationId: LOCATIONS[0].id,
        teamIds: [teamA],
        managerIds: [PEOPLE.danielle.id],
        trainerIds: [PEOPLE.shelby.id],
        roleIds: [repRoleId],
      });
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({
      email: 'wesley.tran@a5roofing.example',
      status: 'invited',
      displayName: 'Wesley Tran',
    });
    expect(created.body.user.managers).toEqual([
      { id: PEOPLE.danielle.id, displayName: 'Danielle Okafor' },
    ]);
    expect(created.body.activationUrl).toMatch(/\/activate\?token=/);

    const types = (await h.db.selectFrom('outbox_events').select('type').execute()).map(
      (e) => e.type,
    );
    expect(types).toEqual(
      expect.arrayContaining([
        'user.created',
        'identity.invitation.created',
        'directory.user.upserted',
        'directory.team.upserted',
      ]),
    );

    // Invited users cannot sign in yet.
    expect(
      (
        await h.http
          .post('/api/v1/auth/login')
          .send({ email: 'wesley.tran@a5roofing.example', password: 'anything-goes-1' })
      ).status,
    ).toBe(401);

    const token = new URL(created.body.activationUrl).searchParams.get('token')!;
    const info = await h.http.get(`/api/v1/auth/tokens/${token}`);
    expect(info.body).toMatchObject({ purpose: 'activation', passwordPolicy: { minLength: 12 } });
    const activated = await h.http
      .post('/api/v1/auth/activate')
      .send({ token, password: 'Valley-Flashing-77' });
    expect(activated.status).toBe(200);
    expect(activated.body.user.displayName).toBe('Wesley Tran');
    expect(
      (await h.http.post('/api/v1/auth/activate').send({ token, password: 'Valley-Flashing-77' }))
        .status,
    ).toBe(410);

    // The manager now sees the new hire.
    const team = await h.http
      .get(`/api/v1/users?teamId=${teamA}&pageSize=50`)
      .set(await h.as('danielle'));
    expect(team.body.items.map((u: { displayName: string }) => u.displayName)).toContain(
      'Wesley Tran',
    );
  });

  it('rejects duplicate emails and employee ids', async () => {
    const admin = await h.as('grant');
    const dup = await h.http
      .post('/api/v1/users')
      .set(admin)
      .send({ email: h.email('marcus'), firstName: 'M', lastName: 'D', roleIds: [repRoleId] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
    const emp = await h.http
      .post('/api/v1/users')
      .set(admin)
      .send({
        email: 'fresh.person@a5roofing.example',
        firstName: 'Fresh',
        lastName: 'Person',
        employeeId: PEOPLE.marcus.employeeId,
        roleIds: [repRoleId],
      });
    expect(emp.body.error.code).toBe('EMPLOYEE_ID_TAKEN');
  });

  it('validates org references', async () => {
    const res = await h.http
      .post('/api/v1/users')
      .set(await h.as('grant'))
      .send({
        email: 'x.y@a5roofing.example',
        firstName: 'X',
        lastName: 'Y',
        teamIds: ['0190a3b2-0000-7000-8000-000000000999'],
        roleIds: [repRoleId],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.fields[0].path).toBe('teamIds');
  });

  it('moves a rep between teams and updates directory events', async () => {
    const admin = await h.as('grant');
    const teamB = TEAMS[1].id;
    const res = await h.http
      .patch(`/api/v1/users/${PEOPLE.kayla.id}`)
      .set(admin)
      .send({ teamIds: [teamB], managerIds: [PEOPLE.andre.id] });
    expect(res.status).toBe(200);
    expect(res.body.teams.map((t: { id: string }) => t.id)).toEqual([teamB]);
    const danielle = await h.http
      .get(`/api/v1/users/${PEOPLE.kayla.id}`)
      .set(await h.as('danielle'));
    expect(danielle.status).toBe(404);
    const andre = await h.http.get(`/api/v1/users/${PEOPLE.kayla.id}`).set(await h.as('andre'));
    expect(andre.status).toBe(200);
  });

  it('only deletes accounts that never activated', async () => {
    const admin = await h.as('priya');
    const res = await h.http.delete(`/api/v1/users/${PEOPLE.tyler.id}`).set(admin);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('USER_HAS_HISTORY');
  });

  it('filters and searches the user list', async () => {
    const admin = await h.as('grant');
    const res = await h.http.get('/api/v1/users?q=delg').set(admin);
    expect(res.body.items.map((u: { displayName: string }) => u.displayName)).toEqual([
      'Marcus Delgado',
    ]);
    const reps = await h.http.get(`/api/v1/users?roleId=${repRoleId}&pageSize=100`).set(admin);
    expect(reps.body.total).toBeGreaterThanOrEqual(17);
    const sorted = await h.http.get('/api/v1/users?sort=-createdAt&pageSize=2&page=2').set(admin);
    expect(sorted.body.page).toBe(2);
    expect(sorted.body.items).toHaveLength(2);
  });
});

describe('organization structure', () => {
  it('creates teams and changes members', async () => {
    const admin = await h.as('grant');
    const team = await h.http
      .post('/api/v1/teams')
      .set(admin)
      .send({
        name: 'Plano Residential',
        locationId: LOCATIONS[0].id,
        managerIds: [PEOPLE.danielle.id],
      });
    expect(team.status).toBe(201);
    const members = await h.http
      .put(`/api/v1/teams/${team.body.id}/members`)
      .set(admin)
      .send({ memberIds: [PEOPLE.jordan.id] });
    expect(members.body.members.map((m: { displayName: string }) => m.displayName)).toEqual([
      'Jordan Whitfield',
    ]);
    expect(
      (await h.http.post('/api/v1/teams').set(admin).send({ name: 'plano residential' })).status,
    ).toBe(409);
  });

  it('returns the full structure for administrators', async () => {
    const res = await h.http.get('/api/v1/organization/structure').set(await h.as('grant'));
    expect(res.body.organization.name).toBe('A5 Roofing');
    expect(res.body.locations.map((l: { name: string }) => l.name)).toEqual([
      'Austin',
      'Dallas',
      'Fort Worth',
    ]);
  });

  it('toggles feature flags with audit', async () => {
    const res = await h.http
      .put('/api/v1/feature-flags/leaderboards')
      .set(await h.as('priya'))
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.items.find((f: { key: string }) => f.key === 'leaderboards').enabled).toBe(
      true,
    );
    expect(
      (
        await h.http
          .put('/api/v1/feature-flags/unknown_flag')
          .set(await h.as('priya'))
          .send({ enabled: true })
      ).status,
    ).toBe(404);
  });

  it('validates security settings', async () => {
    const res = await h.http
      .put('/api/v1/settings/security')
      .set(await h.as('priya'))
      .send({
        passwordMinLength: 12,
        lockoutThreshold: 5,
        lockoutMinutes: 15,
        sessionIdleMinutes: 10_000,
        sessionMaxHours: 24,
      });
    expect(res.status).toBe(400);
  });
});
