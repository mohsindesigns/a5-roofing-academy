import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CERTIFICATION, PEOPLE } from '@a5/seed-data';
import { createCertHarness, type CertHarness } from './harness.js';

let h: CertHarness;

beforeAll(async () => {
  h = await createCertHarness('verification');
});
afterAll(() => h?.close());

const ALLOWED_KEYS = [
  'certificateNumber',
  'certificationName',
  'checkedAt',
  'expiresAt',
  'issuedAt',
  'issuer',
  'recipientName',
  'revocationNote',
  'revokedAt',
  'status',
];

const tokenOf = async (person: keyof typeof PEOPLE, status: 'issued' | 'superseded' = 'issued') =>
  (
    await h.db
      .selectFrom('issued_certificates')
      .select('verification_token')
      .where('user_id', '=', PEOPLE[person].id)
      .where('status', '=', status)
      .executeTakeFirstOrThrow()
  ).verification_token;

describe('public verification', () => {
  it('returns an allow-listed DTO without authentication', async () => {
    const res = await h.http.get(`/api/v1/public/certificates/verify/${await tokenOf('ashlyn')}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body).sort()).toEqual(ALLOWED_KEYS);
    expect(res.body).toMatchObject({
      status: 'valid',
      recipientName: 'Ashlyn Pierce',
      certificationName: CERTIFICATION.name,
      issuer: 'A5 Roofing LLC',
      issuedAt: '2025-04-04',
      expiresAt: '2027-04-04',
      certificateNumber: 'A5-SALES-2025-000002',
      revokedAt: null,
      revocationNote: null,
    });
  });

  it('never exposes contact details, scores, ids, internal notes or storage keys', async () => {
    const res = await h.http.get(`/api/v1/public/certificates/verify/${await tokenOf('ashlyn')}`);
    // Timestamps are random digits; scan everything else.
    const { checkedAt: _checked, issuedAt: _issued, expiresAt: _expires, ...rest } = res.body;
    const text = JSON.stringify(rest);
    const forbidden = [
      'a5roofing.example', // email
      PEOPLE.ashlyn.phone,
      PEOPLE.ashlyn.employeeId,
      PEOPLE.ashlyn.id,
      '91', // final score
      'score',
      'approval',
      'comment',
      'transcript',
      'certification/', // storage keys
      'pdf',
      'override',
    ];
    for (const needle of forbidden) expect(text.toLowerCase()).not.toContain(needle.toLowerCase());
    // No database ids or tokens either.
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('answers generically for unknown tokens and rejects malformed ones', async () => {
    const unknown = await h.http.get(`/api/v1/public/certificates/verify/${'A'.repeat(43)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_AVAILABLE');
    expect(unknown.body.error.message).toContain('not available');
    expect((await h.http.get('/api/v1/public/certificates/verify/short')).status).toBe(400);
  });

  it('reports superseded certificates', async () => {
    const res = await h.http.get(
      `/api/v1/public/certificates/verify/${await tokenOf('destiny', 'superseded')}`,
    );
    expect(res.body).toMatchObject({ status: 'superseded', recipientName: 'Destiny Moralez' });
  });

  it('reports expired the moment the expiration date passes and after the nightly job', async () => {
    const token = await tokenOf('sofia');
    expect((await h.verification.verify(token, new Date('2026-10-05T12:00:00Z'))).status).toBe(
      'valid',
    );
    expect((await h.verification.verify(token, new Date('2026-12-01T12:00:00Z'))).status).toBe(
      'expired',
    );

    const far = new Date('2026-12-01T12:00:00Z');
    expect(await h.lifecycle.expire(far)).toBe(1);
    const res = await h.http.get(`/api/v1/public/certificates/verify/${token}`);
    expect(res.body).toMatchObject({
      status: 'expired',
      expiresAt: '2026-11-22',
      recipientName: 'Sofia Navarro',
    });
    expect(res.body.revokedAt).toBeNull();
  });

  it('is not available when public verification is disabled for the certification', async () => {
    const token = await tokenOf('ashlyn');
    const admin = await h.as('shelby');
    const off = await h.http
      .patch(`/api/v1/certifications/${CERTIFICATION.id}`)
      .set(admin)
      .send({ publicVerificationEnabled: false });
    expect(off.status).toBe(200);
    const hidden = await h.http.get(`/api/v1/public/certificates/verify/${token}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe('NOT_AVAILABLE');
    expect(JSON.stringify(hidden.body)).not.toContain('Ashlyn');
    await h.http
      .patch(`/api/v1/certifications/${CERTIFICATION.id}`)
      .set(admin)
      .send({ publicVerificationEnabled: true });
    expect((await h.http.get(`/api/v1/public/certificates/verify/${token}`)).status).toBe(200);
  });

  it('honours the display options of the verification settings', async () => {
    const token = await tokenOf('ashlyn');
    const admin = await h.as('grant');
    const shown = await h.http.get('/api/v1/certification-settings').set(admin);
    expect(shown.body).toMatchObject({
      organizationCode: 'A5',
      effectiveVerificationBaseUrl: 'https://academy.a5roofing.example',
      recipientNameDisplay: 'full_name',
    });

    const updated = await h.http
      .put('/api/v1/certification-settings')
      .set(admin)
      .send({
        recipientNameDisplay: 'first_name_last_initial',
        showCertificateNumber: false,
        showExpirationDate: false,
      });
    expect(updated.status).toBe(200);
    const res = await h.http.get(`/api/v1/public/certificates/verify/${token}`);
    expect(res.body).toMatchObject({
      status: 'valid',
      recipientName: 'Ashlyn P.',
      certificateNumber: null,
      expiresAt: null,
    });

    const base = await h.http
      .put('/api/v1/certification-settings')
      .set(admin)
      .send({ verificationBaseUrl: 'https://verify.a5roofing.example/' });
    expect(base.body).toMatchObject({
      verificationBaseUrl: 'https://verify.a5roofing.example',
      effectiveVerificationBaseUrl: 'https://verify.a5roofing.example',
    });
    expect(
      (
        await h.http
          .put('/api/v1/certification-settings')
          .set(admin)
          .send({ verificationBaseUrl: 'ftp://nope' })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.http
          .put('/api/v1/certification-settings')
          .set(admin)
          .send({ timezone: 'Mars/Phobos' })
      ).status,
    ).toBe(400);
    await h.http
      .put('/api/v1/certification-settings')
      .set(admin)
      .send({
        recipientNameDisplay: 'full_name',
        showCertificateNumber: true,
        showExpirationDate: true,
        verificationBaseUrl: null,
      });
    const restored = await h.http.get(`/api/v1/public/certificates/verify/${token}`);
    expect(restored.body.recipientName).toBe('Ashlyn Pierce');

    // Only people who may update settings can change them.
    expect(
      (
        await h.http
          .put('/api/v1/certification-settings')
          .set(await h.as('danielle'))
          .send({ showCertificateNumber: false })
      ).status,
    ).toBe(403);
  });

  it('owners see their certificate without internal fields', async () => {
    const mine = await h.http.get('/api/v1/certificates/me').set(await h.as('ashlyn'));
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({
      state: 'active',
      certificate: { certificateNumber: 'A5-SALES-2025-000002' },
    });
    expect(mine.body.items[0].verificationUrl).toMatch(
      /^https:\/\/academy\.a5roofing\.example\/verify\/[A-Za-z0-9_-]{43}$/,
    );
    const detail = await h.http
      .get(`/api/v1/certificates/me/${mine.body.certificates[0].id}`)
      .set(await h.as('ashlyn'));
    expect(detail.status).toBe(200);
    expect(detail.body).not.toHaveProperty('overrideReason');
    expect(detail.body).not.toHaveProperty('issuedBy');
    expect(detail.body.signatories.map((s: { name: string }) => s.name)).toEqual([
      'Priya Raman',
      'Shelby Hartman',
    ]);
  });
});
