import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiEvents } from '@a5/events';
import { CERTIFICATION, PEOPLE, PROGRAM, SCENARIOS, seedId, type PersonKey } from '@a5/seed-data';
import { createCertHarness, type CertHarness } from './harness.js';

let h: CertHarness;
let grant: Record<string, string>;

beforeAll(async () => {
  h = await createCertHarness('lifecycle');
  grant = await h.as('grant');
});
afterAll(() => h?.close());

const activeOf = (person: PersonKey) =>
  h.db.selectFrom('issued_certificates').selectAll().where('user_id', '=', PEOPLE[person].id).where('definition_id', '=', CERTIFICATION.id).orderBy('issued_at', 'desc').execute();
const events = async (type: string, certificateId?: string) =>
  (await h.db.selectFrom('outbox_events').select('envelope').where('type', '=', type).execute())
    .map((e) => (e.envelope as { payload: Record<string, unknown> }).payload)
    .filter((p) => !certificateId || p.certificateId === certificateId);

let n = 0;
function aiScore(person: PersonKey, score: number, at: string) {
  const s = SCENARIOS[n % SCENARIOS.length]!;
  return {
    sessionId: seedId(`t:lifecycle:${person}:${n++}`),
    scenarioId: s.id,
    scenarioTitle: s.title,
    scenarioCategory: s.category,
    difficulty: s.difficulty,
    userId: PEOPLE[person].id,
    overallScore: score,
    passed: score >= s.passingScore,
    passingScore: s.passingScore,
    categoryScores: [],
    context: { programId: PROGRAM.id },
    evaluatedAt: at,
    promptVersionId: seedId('t:p'),
    rubricVersionId: seedId('t:r'),
  };
}

describe('expiry reminders', () => {
  it('announces the most urgent reached offset once per certificate and offset', async () => {
    const [sofia] = await activeOf('sofia');
    const rows = () => h.db.selectFrom('certificate_reminders').select(['offset_days', 'sent']).where('certificate_id', '=', sofia!.id).orderBy('offset_days', 'desc').execute();
    // The seed already sent the 60-day reminder (49 days left) and recorded the 90-day offset as passed.
    expect(await rows()).toEqual([{ offset_days: 90, sent: false }, { offset_days: 60, sent: true }]);
    expect(await h.lifecycle.sendReminders(new Date('2026-10-05T15:00:00Z'))).toBe(0);

    expect(await h.lifecycle.sendReminders(new Date('2026-11-10T12:00:00Z'))).toBe(1);
    expect(await h.lifecycle.sendReminders(new Date('2026-11-10T18:00:00Z'))).toBe(0);
    expect(await h.lifecycle.sendReminders(new Date('2026-11-17T12:00:00Z'))).toBe(1);
    expect(await h.lifecycle.sendReminders(new Date('2026-11-17T20:00:00Z'))).toBe(0);

    const expiring = await events('certificate.expiring', sofia!.id);
    expect(expiring.map((e) => e.daysRemaining).sort((a, b) => Number(a) - Number(b))).toEqual([6, 13, 49]);
    expect((await rows()).map((r) => r.offset_days)).toEqual([90, 60, 30, 7]);
    const timeline = await h.http.get(`/api/v1/certificates/${sofia!.id}/events`).set(grant);
    expect(timeline.body.items.filter((e: { type: string }) => e.type === 'expiry_reminder')).toHaveLength(3);
  });
});

describe('renewal', () => {
  it('opened a renewal window for the certificate expiring within the window', async () => {
    const [sofia] = await activeOf('sofia');
    const renewal = await h.db.selectFrom('certificate_renewals').selectAll().where('certificate_id', '=', sofia!.id).executeTakeFirstOrThrow();
    expect(renewal).toMatchObject({ status: 'open', due_at: sofia!.expires_at });
    expect(renewal.window_opened_at.toISOString()).toBe(new Date(sofia!.expires_at!.getTime() - 90 * 86_400_000).toISOString());
    expect(await events('certificate.renewal_required', sofia!.id)).toHaveLength(1);
    const mine = await h.http.get('/api/v1/certificates/me').set(await h.as('sofia'));
    expect(mine.body.items[0]).toMatchObject({ state: 'renewal_required', renewal: { status: 'open' } });
    expect(mine.body.items[0].progress).toMatchObject({ purpose: 'renewal', metCount: 0, totalCount: 2 });
    expect(mine.body.items[0].progress.requirements.map((r: { description: string }) => r.description)).toEqual(['Complete 2 AI role-plays scoring 80+', 'Manager approval']);
  });

  it('renews through the renewal requirements and supersedes the old certificate', async () => {
    const [old] = await activeOf('sofia');
    // Activity before the window opened does not count; activity inside it does.
    await h.deliver(aiEvents.scoreGenerated, aiScore('sofia', 92, '2026-07-01T12:00:00Z'));
    await h.deliver(aiEvents.scoreGenerated, aiScore('sofia', 84, '2026-09-20T12:00:00Z'));
    expect((await h.http.get(`/api/v1/certifications/${CERTIFICATION.id}/progress?userId=${PEOPLE.sofia.id}`).set(grant)).body).toMatchObject({ metCount: 0, totalCount: 2 });
    await h.deliver(aiEvents.scoreGenerated, aiScore('sofia', 86, '2026-09-21T12:00:00Z'));

    const candidate = await h.db.selectFrom('certification_candidates').selectAll().where('user_id', '=', PEOPLE.sofia.id).executeTakeFirstOrThrow();
    expect(candidate).toMatchObject({ status: 'pending_approval', purpose: 'renewal', cycle: 2, met_count: 1, total_count: 2 });

    const luis = await h.as('luis');
    const queue = await h.http.get('/api/v1/certificates/approvals').set(luis);
    expect(queue.body.items).toHaveLength(1);
    const decided = await h.http.post(`/api/v1/certificates/approvals/${queue.body.items[0].id}/decision`).set(luis).send({ decision: 'approved' });
    expect(decided.status).toBe(200);

    const [renewed, previous] = await activeOf('sofia');
    expect(renewed).toMatchObject({ status: 'issued', mode: 'renewal' });
    expect(previous).toMatchObject({ id: old!.id, status: 'superseded', superseded_by_id: renewed!.id });
    expect(renewed!.certificate_number).not.toBe(old!.certificate_number);
    expect(renewed!.expires_at!.toISOString()).toBe('2028-11-22T16:00:00.000Z');
    const renewal = await h.db.selectFrom('certificate_renewals').selectAll().where('certificate_id', '=', old!.id).executeTakeFirstOrThrow();
    expect(renewal).toMatchObject({ status: 'completed', new_certificate_id: renewed!.id });
    expect(await h.db.selectFrom('certification_candidates').select(['status', 'purpose']).where('user_id', '=', PEOPLE.sofia.id).executeTakeFirstOrThrow()).toEqual({ status: 'issued', purpose: 'initial' });
    expect((await events('certificate.issued', renewed!.id))[0]).toMatchObject({ mode: 'renewal' });
    expect((await h.http.get(`/api/v1/public/certificates/verify/${old!.verification_token}`)).body.status).toBe('superseded');
    const mine = await h.http.get('/api/v1/certificates/me').set(await h.as('sofia'));
    expect(mine.body.items[0]).toMatchObject({ state: 'active' });
    expect(mine.body.certificates).toHaveLength(2);
  });

  it('opens each renewal window once and emits certificate.renewal_required once', async () => {
    const [ashlyn] = await activeOf('ashlyn');
    const when = new Date('2027-03-15T12:00:00Z');
    expect(await h.lifecycle.openRenewalWindows(when)).toBe(1);
    expect(await h.lifecycle.openRenewalWindows(when)).toBe(0);
    expect(await events('certificate.renewal_required', ashlyn!.id)).toHaveLength(1);
    const candidate = await h.db.selectFrom('certification_candidates').select(['status', 'purpose', 'cycle', 'met_count', 'total_count']).where('user_id', '=', PEOPLE.ashlyn.id).executeTakeFirstOrThrow();
    expect(candidate).toEqual({ status: 'in_progress', purpose: 'renewal', cycle: 2, met_count: 0, total_count: 2 });
    const list = await h.http.get('/api/v1/certificates/renewals').set(grant);
    expect(list.body.items.map((r: { certificate: { recipient: { displayName: string } } }) => r.certificate.recipient.displayName)).toEqual(['Ashlyn Pierce']);
  });
});

describe('expiry', () => {
  it('marks certificates expired once, lapses their renewals and keeps the history', async () => {
    const [ashlyn] = await activeOf('ashlyn');
    const when = new Date('2027-05-01T12:00:00Z');
    const runs = await Promise.all([h.lifecycle.expire(when), h.lifecycle.expire(when)]);
    expect(runs.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await h.lifecycle.expire(when)).toBe(0);

    const expired = await h.db.selectFrom('issued_certificates').selectAll().where('id', '=', ashlyn!.id).executeTakeFirstOrThrow();
    expect(expired).toMatchObject({ status: 'expired' });
    expect(expired.expired_at).not.toBeNull();
    expect(await events('certificate.expired', ashlyn!.id)).toHaveLength(1);
    expect((await h.db.selectFrom('certificate_renewals').select('status').where('certificate_id', '=', ashlyn!.id).executeTakeFirstOrThrow()).status).toBe('lapsed');
    // Destiny's and Sofia's certificates are untouched.
    expect((await activeOf('destiny')).filter((c) => c.status === 'issued')).toHaveLength(1);

    const detail = await h.http.get(`/api/v1/certificates/${ashlyn!.id}`).set(grant);
    expect(detail.body).toMatchObject({ status: 'expired', effectiveStatus: 'expired', renewal: { status: 'lapsed' } });
    const verification = await h.http.get(`/api/v1/public/certificates/verify/${ashlyn!.verification_token}`);
    expect(verification.body.status).toBe('expired');
    const team = await h.http.get(`/api/v1/certificates/team?filter=expired`).set(grant);
    expect(team.body.items.map((r: { user: { displayName: string } }) => r.user.displayName)).toEqual(['Ashlyn Pierce']);
  });

  it('lets an expired certificate be recertified; the old record stays expired', async () => {
    const [expired] = await activeOf('ashlyn');
    await h.deliver(aiEvents.scoreGenerated, aiScore('ashlyn', 90, '2027-02-01T12:00:00Z'));
    await h.deliver(aiEvents.scoreGenerated, aiScore('ashlyn', 88, '2027-02-02T12:00:00Z'));
    const approval = await h.db.selectFrom('certificate_approvals').select('id').where('user_id', '=', PEOPLE.ashlyn.id).where('status', '=', 'pending').executeTakeFirstOrThrow();
    const res = await h.http.post(`/api/v1/certificates/approvals/${approval.id}/decision`).set(await h.as('danielle')).send({ decision: 'approved' });
    expect(res.status).toBe(200);
    const all = await activeOf('ashlyn');
    expect(all).toHaveLength(2);
    expect(all.map((c) => [c.id === expired!.id, c.status, c.mode]).sort()).toEqual([
      [false, 'issued', 'renewal'],
      [true, 'expired', 'approval'],
    ].sort());
    const renewal = await h.db.selectFrom('certificate_renewals').select(['status', 'new_certificate_id']).where('certificate_id', '=', expired!.id).executeTakeFirstOrThrow();
    expect(renewal.status).toBe('completed');
    expect(renewal.new_certificate_id).toBe(all.find((c) => c.status === 'issued')!.id);
  });

  it('opens a lapsed renewal at expiry when the renewal window is zero days', async () => {
    const stormed = await h.http.post('/api/v1/certifications').set(await h.as('shelby')).send({
      name: 'Closer Certified',
      code: 'CLOSER',
      issuingOrganizationName: 'A5 Roofing LLC',
      templateId: (await h.http.get('/api/v1/certificate-templates').set(grant)).body.items[0].id,
      signatories: [{ slot: 1, signatoryId: (await h.http.get('/api/v1/signatories').set(await h.as('priya'))).body.items[0].id }, { slot: 2, signatoryId: (await h.http.get('/api/v1/signatories').set(await h.as('priya'))).body.items[1].id }],
      stampId: (await h.http.get('/api/v1/stamps').set(await h.as('priya'))).body.items[0].id,
      validity: { kind: 'months', months: 1 },
      renewal: { windowDays: 0, reminderOffsets: [7], requirements: { type: 'all', rules: [] } },
      approvalPolicy: 'none',
      automaticIssuance: true,
      eligibilityRule: { type: 'all', rules: [{ type: 'ai_sessions_count', minCount: 1, minScore: 70 }] },
    });
    expect(stormed.status).toBe(201);
    expect((await h.http.post(`/api/v1/certifications/${stormed.body.id}/activate`).set(await h.as('shelby'))).status).toBe(200);

    // Automatic issuance: one qualifying session is enough.
    await h.deliver(aiEvents.scoreGenerated, aiScore('marcus', 80, new Date().toISOString()));
    const cert = await h.db.selectFrom('issued_certificates').selectAll().where('definition_id', '=', stormed.body.id).executeTakeFirstOrThrow();
    expect(cert).toMatchObject({ status: 'issued', mode: 'automatic', issued_by: null });
    expect(cert.certificate_number).toMatch(/^A5-CLOSER-\d{4}-000001$/);

    const later = new Date(cert.expires_at!.getTime() + 86_400_000);
    const summary = await h.lifecycle.runDaily(later);
    expect(summary.expired).toBeGreaterThanOrEqual(1);
    const renewal = await h.db.selectFrom('certificate_renewals').select(['status', 'due_at']).where('certificate_id', '=', cert.id).executeTakeFirstOrThrow();
    expect(renewal).toEqual({ status: 'lapsed', due_at: cert.expires_at });
    expect(await events('certificate.renewal_required', cert.id)).toHaveLength(1);
    // No renewal requirements: the person is eligible, but renewing proves nothing, so it is never automatic.
    const candidate = await h.db.selectFrom('certification_candidates').select(['status', 'purpose']).where('definition_id', '=', stormed.body.id).executeTakeFirstOrThrow();
    expect(candidate).toEqual({ status: 'eligible', purpose: 'renewal' });
    const renewed = await h.http.post('/api/v1/certificates').set(grant).send({ definitionId: stormed.body.id, userId: PEOPLE.marcus.id });
    expect(renewed.status).toBe(201);
    expect(renewed.body).toMatchObject({ mode: 'renewal', status: 'issued' });
    expect(await h.db.selectFrom('certificate_renewals').select('status').where('certificate_id', '=', cert.id).executeTakeFirstOrThrow()).toEqual({ status: 'completed' });
  });
});
