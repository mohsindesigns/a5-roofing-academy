import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CERTIFICATION, PEOPLE } from '@a5/seed-data';
import { createCertHarness, type CertHarness } from './harness.js';

let h: CertHarness;

beforeAll(async () => {
  h = await createCertHarness('access');
});
afterAll(() => h?.close());

async function certificateOf(person: keyof typeof PEOPLE, status = 'issued') {
  return h.db
    .selectFrom('issued_certificates')
    .selectAll()
    .where('user_id', '=', PEOPLE[person].id)
    .where('status', '=', status as 'issued')
    .executeTakeFirstOrThrow();
}

describe('representatives', () => {
  it('cannot use admin endpoints', async () => {
    const rep = await h.as('marcus');
    const cert = await certificateOf('sofia');
    const calls = [
      h.http.get('/api/v1/certifications').set(rep),
      h.http.post('/api/v1/certifications').set(rep).send({}),
      h.http.get('/api/v1/certificate-templates').set(rep),
      h.http.get('/api/v1/signatories').set(rep),
      h.http.get('/api/v1/stamps').set(rep),
      h.http.get('/api/v1/certification-settings').set(rep),
      h.http.get('/api/v1/certificates').set(rep),
      h.http.get('/api/v1/certificates/dashboard').set(rep),
      h.http.get('/api/v1/certificates/team').set(rep),
      h.http.get('/api/v1/certificates/approvals').set(rep),
      h.http.get('/api/v1/certificates/eligibility').set(rep),
      h.http.get(`/api/v1/certificates/${cert.id}`).set(rep),
      h.http.post(`/api/v1/certificates/${cert.id}/revoke`).set(rep).send({}),
      h.http.post('/api/v1/certificates').set(rep).send({ definitionId: CERTIFICATION.id, userId: PEOPLE.marcus.id }),
    ];
    const statuses: number[] = [];
    for (const call of calls) statuses.push((await call).status);
    expect(statuses).toEqual(calls.map(() => 403));
  });

  it('can see their own certifications, with progress for what is still in progress', async () => {
    const res = await h.http.get('/api/v1/certificates/me').set(await h.as('marcus'));
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: { definition: { id: string } }) => i.definition.id === CERTIFICATION.id);
    expect(item).toMatchObject({ state: 'in_progress', certificate: null });
    expect(item.progress).toMatchObject({ totalCount: 6, status: 'in_progress' });
    expect(item.progress.requirements).toHaveLength(6);
    expect(item.progress.requirements[0].description).toContain('Complete A5 New Hire Sales Academy');
  });

  it('cannot read a colleague’s progress or certificate', async () => {
    const rep = await h.as('marcus');
    const other = await h.http.get(`/api/v1/certifications/${CERTIFICATION.id}/progress?userId=${PEOPLE.tyler.id}`).set(rep);
    expect(other.status).toBe(404);
    const own = await h.http.get(`/api/v1/certifications/${CERTIFICATION.id}/progress`).set(rep);
    expect(own.status).toBe(200);
    const sofia = await certificateOf('sofia');
    expect((await h.http.get(`/api/v1/certificates/me/${sofia.id}`).set(rep)).status).toBe(404);
    expect((await h.http.post(`/api/v1/certificates/me/${sofia.id}/download`).set(rep)).status).toBe(404);
  });
});

describe('manager data scope', () => {
  it('lists only certificates of people in managed teams', async () => {
    const res = await h.http.get('/api/v1/certificates?pageSize=50').set(await h.as('danielle'));
    expect(res.status).toBe(200);
    const names = res.body.items.map((c: { recipient: { displayName: string } }) => c.recipient.displayName).sort();
    // Team A: Ashlyn holds a certificate; Sofia (Fort Worth) and Destiny (Austin) are out of scope.
    expect(names).toEqual(['Ashlyn Pierce']);
  });

  it('returns 404 for certificates outside the managed teams', async () => {
    const sofia = await certificateOf('sofia');
    const danielle = await h.as('danielle');
    expect((await h.http.get(`/api/v1/certificates/${sofia.id}`).set(danielle)).status).toBe(404);
    expect((await h.http.get(`/api/v1/certificates/${sofia.id}/events`).set(danielle)).status).toBe(404);
    expect((await h.http.post(`/api/v1/certificates/${sofia.id}/download`).set(danielle)).status).toBe(404);
    const ashlyn = await certificateOf('ashlyn');
    expect((await h.http.get(`/api/v1/certificates/${ashlyn.id}`).set(danielle)).status).toBe(200);
  });

  it('managers cannot revoke or reissue (no permission) and cannot issue outside their team', async () => {
    const ashlyn = await certificateOf('ashlyn');
    const danielle = await h.as('danielle');
    expect((await h.http.post(`/api/v1/certificates/${ashlyn.id}/revoke`).set(danielle).send({ reason: 'A reason long enough', confirmation: 'x' })).status).toBe(403);
    expect((await h.http.post(`/api/v1/certificates/${ashlyn.id}/reissue`).set(danielle).send({ reasonCode: 'administrative', note: 'Because' })).status).toBe(403);
    const issue = await h.http.post('/api/v1/certificates').set(danielle).send({ definitionId: CERTIFICATION.id, userId: PEOPLE.naomi.id });
    expect(issue.status).toBe(403);
  });

  it('team status shows managed people only, with filters', async () => {
    const danielle = await h.as('danielle');
    const all = await h.http.get(`/api/v1/certificates/team?definitionId=${CERTIFICATION.id}&pageSize=50`).set(danielle);
    expect(all.status).toBe(200);
    const byName = Object.fromEntries(all.body.items.map((r: { user: { displayName: string }; state: string }) => [r.user.displayName, r.state]));
    expect(byName).toMatchObject({ 'Ashlyn Pierce': 'certified', 'Marcus Delgado': 'in_progress', 'Kayla Simmons': 'in_progress' });
    expect(byName['Sofia Navarro']).toBeUndefined();

    const certified = await h.http.get('/api/v1/certificates/team?filter=certified').set(danielle);
    expect(certified.body.items.map((r: { user: { displayName: string } }) => r.user.displayName)).toEqual(['Ashlyn Pierce']);
    const notCertified = await h.http.get('/api/v1/certificates/team?filter=not_certified&pageSize=50').set(danielle);
    expect(notCertified.body.total).toBe(4);
  });

  it('administrators see everything: certified, expiring, renewal needed, pending approval', async () => {
    const admin = await h.as('grant');
    const rows = await h.http.get(`/api/v1/certificates/team?definitionId=${CERTIFICATION.id}&pageSize=100`).set(admin);
    const byName = Object.fromEntries(rows.body.items.map((r: { user: { displayName: string }; state: string }) => [r.user.displayName, r.state]));
    expect(byName['Sofia Navarro']).toBe('renewal_required');
    expect(byName['Destiny Morales']).toBe('certified');
    expect(byName['Brianna Castillo']).toBe('pending_approval');
    const expiring = await h.http.get('/api/v1/certificates/team?filter=expiring&expiringWithinDays=60').set(admin);
    expect(expiring.body.items.map((r: { user: { displayName: string } }) => r.user.displayName)).toEqual(['Sofia Navarro']);
    const pending = await h.http.get('/api/v1/certificates/team?filter=pending_approval').set(admin);
    expect(pending.body.items).toHaveLength(1);
  });

  it('trainers see assigned trainees across teams but cannot decide approvals', async () => {
    const hector = await h.as('hector');
    const team = await h.http.get('/api/v1/certificates/team?pageSize=50').set(hector);
    const names = team.body.items.map((r: { user: { displayName: string } }) => r.user.displayName);
    expect(names).toEqual(expect.arrayContaining(['Naomi Fischer', 'Devon Mitchell']));
    expect(names).not.toContain('Marcus Delgado');
    expect((await h.http.get('/api/v1/certificates/approvals').set(hector)).status).toBe(403);
  });
});

describe('dashboard and admin queues', () => {
  it('summarizes certificates for administrators', async () => {
    const res = await h.http.get('/api/v1/certificates/dashboard').set(await h.as('grant'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      issued: 4,
      active: 3,
      expiring: { within30: 0, within60: 1, within90: 1 },
      pendingApprovals: 1,
      eligible: 0,
      revokedThisMonth: 0,
      renewalsOpen: 1,
      pdfFailed: 0,
    });
  });

  it('scopes the dashboard to the manager’s people', async () => {
    const res = await h.http.get('/api/v1/certificates/dashboard').set(await h.as('danielle'));
    expect(res.body).toMatchObject({ issued: 1, active: 1, pendingApprovals: 0 });
  });

  it('searches issued certificates by number or name', async () => {
    const admin = await h.as('grant');
    const byNumber = await h.http.get('/api/v1/certificates?q=2025-000002').set(admin);
    expect(byNumber.body.items.map((c: { recipient: { displayName: string } }) => c.recipient.displayName)).toEqual(['Ashlyn Pierce']);
    const byName = await h.http.get('/api/v1/certificates?q=navarro').set(admin);
    expect(byName.body.total).toBe(1);
    const superseded = await h.http.get('/api/v1/certificates?status=superseded').set(admin);
    expect(superseded.body.items).toHaveLength(1);
    const expiringSoon = await h.http.get('/api/v1/certificates?expiringWithinDays=60').set(admin);
    expect(expiringSoon.body.items.map((c: { recipient: { displayName: string } }) => c.recipient.displayName)).toEqual(['Sofia Navarro']);
  });

  it('lists the renewal opened for the certificate expiring soon', async () => {
    const res = await h.http.get('/api/v1/certificates/renewals').set(await h.as('grant'));
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ status: 'open', certificate: { recipient: { displayName: 'Sofia Navarro' } } });
    expect(res.body.items[0].progress).toMatchObject({ status: 'in_progress', totalCount: 2 });
  });
});
