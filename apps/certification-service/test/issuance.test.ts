import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { applyDirectoryUser } from '@a5/directory';
import { certificationEvents } from '@a5/events';
import { CERTIFICATE_TEMPLATES, CERTIFICATION, ORGANIZATION, PEOPLE, SIGNATORIES, directoryUser, seedId, type PersonKey } from '@a5/seed-data';
import type { Trx } from '../src/database/index.js';
import { renderSnapshotPdf } from '../src/rendering/snapshot-render.js';
import { createCertHarness, solidPng, type CertHarness } from './harness.js';

let h: CertHarness;
let admin: Record<string, string>;
const override = { reason: 'Issued during automated testing of the issuance pipeline' };

beforeAll(async () => {
  h = await createCertHarness('issuance');
  admin = await h.as('grant');
});
afterAll(() => h?.close());

const issue = (userId: string) => h.http.post('/api/v1/certificates').set(admin).send({ definitionId: CERTIFICATION.id, userId, override });
const sequenceOf = (number: string) => Number(number.slice(number.lastIndexOf('-') + 1));
const certOf = (id: string) => h.db.selectFrom('issued_certificates').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const snapshotOf = async (id: string) => (await h.db.selectFrom('certificate_snapshots').select('data').where('certificate_id', '=', id).executeTakeFirstOrThrow()).data;
const outbox = (type: string) => h.db.selectFrom('outbox_events').select('envelope').where('type', '=', type).execute();

describe('concurrency', () => {
  it('concurrent issue requests for one person produce a single certificate', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => issue(PEOPLE.ethan.id)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    expect(new Set(results.filter((r) => r.status === 409).map((r) => r.body.error.code))).toEqual(new Set(['ALREADY_CERTIFIED']));
    const rows = await h.db.selectFrom('issued_certificates').select('id').where('user_id', '=', PEOPLE.ethan.id).execute();
    expect(rows).toHaveLength(1);
    expect(await h.db.selectFrom('certificate_snapshots').select('certificate_id').where('certificate_id', '=', rows[0]!.id).execute()).toHaveLength(1);
  });

  it('the database itself refuses a second active certificate even without the lock', async () => {
    const existing = await h.db.selectFrom('issued_certificates').selectAll().where('user_id', '=', PEOPLE.ethan.id).executeTakeFirstOrThrow();
    await expect(
      h.db
        .insertInto('issued_certificates')
        .values({ ...existing, id: seedId('t:dup'), certificate_number: 'A5-SALES-9999-000001', verification_token: 'x'.repeat(43) })
        .execute(),
    ).rejects.toMatchObject({ code: '23505', constraint: 'issued_certificates_one_active_uq' });

    // Bypass the lock entirely: racing transactions end with one certificate and no skipped numbers.
    const before = (await h.db.selectFrom('certificate_number_sequences').select('last_value').where('definition_id', '=', CERTIFICATION.id).executeTakeFirstOrThrow()).last_value;
    const raw = h.issuance as unknown as { issueLocked(p: unknown): Promise<{ certificateNumber: string }> };
    const params = { definitionId: CERTIFICATION.id, userId: PEOPLE.isaiah.id, mode: 'manual', actor: { userId: null, displayName: null }, overrideReason: 'raced' };
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => raw.issueLocked(params)));
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const after = (await h.db.selectFrom('certificate_number_sequences').select('last_value').where('definition_id', '=', CERTIFICATION.id).executeTakeFirstOrThrow()).last_value;
    expect(Number(after)).toBe(Number(before) + 1);
  });

  it('20 parallel issues across people yield 20 distinct, sequential numbers', async () => {
    const users = Array.from({ length: 20 }, (_, i) => ({ ...directoryUser('marcus'), id: seedId(`t:parallel:${i}`), firstName: 'Parallel', lastName: `Rep${String(i + 1).padStart(2, '0')}`, displayName: `Parallel Rep${i + 1}`, email: `parallel.rep${i + 1}@a5roofing.example`, employeeId: `A5-9${String(i).padStart(3, '0')}`, teamIds: [] as string[], managerIds: [] as string[], trainerIds: [] as string[] }));
    await h.db.transaction().execute(async (trx) => {
      for (const u of users) await applyDirectoryUser(trx as Trx, u, 1);
    });
    const before = Number((await h.db.selectFrom('certificate_number_sequences').select('last_value').where('definition_id', '=', CERTIFICATION.id).executeTakeFirstOrThrow()).last_value);
    const results = await Promise.all(users.map((u) => issue(u.id)));
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
    const numbers = results.map((r) => r.body.certificateNumber as string);
    expect(new Set(numbers).size).toBe(20);
    const seqs = numbers.map(sequenceOf).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => before + 1 + i));
    const tokens = (await h.db.selectFrom('issued_certificates').select('verification_token').execute()).map((r) => r.verification_token);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens.every((t) => Buffer.from(t, 'base64url').length >= 24)).toBe(true);
  });
});

describe('immutability of issued certificates', () => {
  let certificateId: string;
  let original: Awaited<ReturnType<typeof snapshotOf>>;

  it('snapshots every render input and copies signature and stamp images under the certificate prefix', async () => {
    h.identity.names.set(PEOPLE.colton.id, { firstName: 'Colton', lastName: 'Hayes-Whitaker' });
    const res = await issue(PEOPLE.colton.id);
    expect(res.status).toBe(201);
    certificateId = res.body.id;
    original = await snapshotOf(certificateId);
    expect(h.identity.calls).toContain(PEOPLE.colton.id);
    expect(original.recipient).toMatchObject({ legalName: 'Colton Hayes-Whitaker', source: 'identity', employeeId: PEOPLE.colton.employeeId });
    expect(original.certification).toMatchObject({ name: CERTIFICATION.name, code: 'SALES', issuingOrganizationName: ORGANIZATION.legalName });
    expect(original.signatories.map((s) => [s.slot, s.name, s.title])).toEqual([
      [1, 'Priya Raman', 'Director of Sales Enablement'],
      [2, 'Shelby Hartman', 'Sales Training Manager'],
    ]);
    expect(original.template.design.page).toEqual({ size: 'LETTER', orientation: 'landscape' });
    expect(original.placeholders.recipient_name).toBe('Colton Hayes-Whitaker');
    expect(original.dates.expiresAt).not.toBeNull();

    const prefix = `certification/${ORGANIZATION.id}/certificates/${certificateId}/`;
    const images = [...original.signatories.map((s) => s.image), original.stamp?.image];
    for (const image of images) {
      expect(image?.key.startsWith(prefix)).toBe(true);
      const bytes = await h.storage.getBytes(image!.key);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(image!.sha256);
    }
  });

  it('changing a signature never touches certificates that were already issued', async () => {
    const signatory = SIGNATORIES[0];
    const upload = await h.http
      .post(`/api/v1/certification-assets/signatories/${signatory.id}/signature`)
      .set(await h.as('priya'))
      .attach('file', solidPng(640, 200, [190, 20, 20, 255]), { filename: 'new-signature.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    expect(upload.body.currentSignature).toMatchObject({ version: 2, contentType: 'image/png', width: 640, height: 200 });

    // Remove the live version-1 signature from storage: the certificate must not depend on it.
    const v1 = await h.db
      .selectFrom('signatory_signatures as s')
      .innerJoin('certification_assets as a', 'a.id', 's.asset_id')
      .select('a.storage_key')
      .where('s.signatory_id', '=', signatory.id)
      .where('s.version', '=', 1)
      .executeTakeFirstOrThrow();
    await h.storage.deleteObject(v1.storage_key);

    expect(await snapshotOf(certificateId)).toEqual(original);
    const bytes = await h.storage.getBytes(original.signatories[0]!.image!.key);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(original.signatories[0]!.image!.sha256);
    const pdf = await renderSnapshotPdf(h.storage, await snapshotOf(certificateId));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('changing a template creates a new version and leaves issued certificates untouched', async () => {
    const templateId = CERTIFICATE_TEMPLATES[0].id;
    const current = await h.http.get(`/api/v1/certificate-templates/${templateId}`).set(admin);
    expect(current.body.currentVersion).toBe(1);
    const design = structuredClone(current.body.design);
    design.elements.find((e: { id: string }) => e.id === 'title').content = 'Certificate of Completion';
    design.theme.accentColor = '#112233';
    const updated = await h.http.put(`/api/v1/certificate-templates/${templateId}/design`).set(admin).send({ design, changeNote: 'New headline' });
    expect(updated.status).toBe(200);
    expect(updated.body.currentVersion).toBe(2);
    const versions = await h.http.get(`/api/v1/certificate-templates/${templateId}/versions`).set(admin);
    expect(versions.body.items.map((v: { version: number }) => v.version)).toEqual([2, 1]);

    // Saving an identical design is a no-op, not a new version.
    const same = await h.http.put(`/api/v1/certificate-templates/${templateId}/design`).set(admin).send({ design });
    expect(same.body.currentVersion).toBe(2);

    const cert = await certOf(certificateId);
    expect(cert.template_version_id).toBe(original.template.versionId);
    expect(await snapshotOf(certificateId)).toEqual(original);
    expect((await snapshotOf(certificateId)).template.design.elements.find((e) => e.id === 'title')?.content).toBe('Certificate of Achievement');

    // Versions and snapshots are immutable at the database level.
    await expect(h.db.updateTable('certificate_snapshots').set({ schema_version: 2 }).where('certificate_id', '=', certificateId).execute()).rejects.toThrow(/immutable/);
    await expect(h.db.updateTable('certificate_template_versions').set({ change_note: 'tamper' }).execute()).rejects.toThrow(/immutable/);
    await expect(h.db.deleteFrom('certificate_events').execute()).rejects.toThrow(/immutable/);

    const fresh = await issue(PEOPLE.devon.id);
    expect(fresh.status).toBe(201);
    const freshSnapshot = await snapshotOf(fresh.body.id);
    expect(freshSnapshot.template.version).toBe(2);
    expect(freshSnapshot.template.design.elements.find((e) => e.id === 'title')?.content).toBe('Certificate of Completion');
    // The signature uploaded earlier is what new certificates show; the old certificate keeps version 1.
    expect(freshSnapshot.signatories[0]!.signatureVersionId).not.toBe(original.signatories[0]!.signatureVersionId);
    expect(freshSnapshot.signatories[0]!.image!.sha256).not.toBe(original.signatories[0]!.image!.sha256);
  });
});

describe('PDF generation and download', () => {
  it('renders a valid PDF from the snapshot, records its checksum and emits certificate.generated once', async () => {
    const res = await issue(PEOPLE.caleb.id);
    const id = res.body.id as string;
    expect(res.body.pdfStatus).toBe('pending');

    // Not downloadable before the worker has run.
    const early = await h.http.post(`/api/v1/certificates/me/${id}/download`).set(await h.as('caleb'));
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('PDF_NOT_READY');

    expect(await h.pdf.generate(id)).toBe('generated');
    expect(await h.pdf.generate(id)).toBe('already_ready');
    const cert = await certOf(id);
    expect(cert).toMatchObject({ pdf_status: 'ready' });
    const bytes = await readFile(`${h.storageRoot}/${cert.pdf_storage_key}`);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.subarray(-8).toString()).toContain('%%EOF');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(cert.pdf_sha256);
    expect(cert.pdf_byte_size).toBe(bytes.length);

    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([792, 612]);
    expect(doc.getTitle()).toContain('Caleb Ramirez');
    expect(doc.getSubject()).toBe(`Certificate ${res.body.certificateNumber}`);

    const generated = (await outbox(certificationEvents.generated.type)).filter((e) => (e.envelope as { payload: { certificateId: string } }).payload.certificateId === id);
    expect(generated).toHaveLength(1);
  });

  it('issues short-lived signed download links, audits downloads and rejects tampered links', async () => {
    const cert = await h.db.selectFrom('issued_certificates').selectAll().where('user_id', '=', PEOPLE.caleb.id).executeTakeFirstOrThrow();
    const res = await h.http.post(`/api/v1/certificates/me/${cert.id}/download`).set(await h.as('caleb'));
    expect(res.status).toBe(200);
    expect(res.body.fileName).toBe(`${cert.certificate_number}.pdf`);
    expect(new Date(res.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);

    const url = new URL(res.body.url);
    const path = `${url.pathname}${url.search}`;
    const file = await h.http.get(path).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    expect(file.headers['content-disposition']).toContain(`${cert.certificate_number}.pdf`);
    expect(createHash('sha256').update(file.body as Buffer).digest('hex')).toBe(cert.pdf_sha256);

    const tampered = new URL(url);
    tampered.searchParams.set('sig', `${url.searchParams.get('sig')!.slice(0, -2)}AA`);
    expect((await h.http.get(`${tampered.pathname}${tampered.search}`)).status).toBe(403);
    const wrongKey = new URL(url);
    wrongKey.searchParams.set('key', cert.pdf_storage_key!.replace('certificate.pdf', 'other.pdf'));
    expect((await h.http.get(`${wrongKey.pathname}${wrongKey.search}`)).status).toBe(403);
    const expiredAt = Math.floor(Date.now() / 1000) - 5;
    const stale = new URL(url);
    stale.searchParams.set('expires', String(expiredAt));
    stale.searchParams.set('sig', h.storage.sign(cert.pdf_storage_key!, expiredAt, `${cert.certificate_number}.pdf`));
    expect((await h.http.get(`${stale.pathname}${stale.search}`)).status).toBe(403);

    expect((await outbox(certificationEvents.downloaded.type)).length).toBeGreaterThanOrEqual(1);
    const timeline = await h.http.get(`/api/v1/certificates/${cert.id}/events`).set(admin);
    expect(timeline.body.items.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['issued', 'pdf_generated', 'downloaded']));
  });
});

describe('reissue keeps historical linkage', () => {
  it('replaces the original with a new number, supersedes it and links both ways', async () => {
    const original = await h.db.selectFrom('issued_certificates').selectAll().where('user_id', '=', PEOPLE.ashlyn.id).executeTakeFirstOrThrow();
    h.identity.names.set(PEOPLE.ashlyn.id, { firstName: 'Ashlyn', lastName: 'Pierce-Hale' });
    const res = await h.http.post(`/api/v1/certificates/${original.id}/reissue`).set(admin).send({ reasonCode: 'corrected_name', note: 'Married name on file' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'issued',
      mode: 'reissue',
      recipientName: 'Ashlyn Pierce-Hale',
      replaces: { id: original.id, certificateNumber: original.certificate_number, reasonCode: 'corrected_name', note: 'Married name on file' },
    });
    expect(res.body.certificateNumber).not.toBe(original.certificate_number);
    expect(res.body.expiresAt).toBe(original.expires_at!.toISOString());

    const old = await h.http.get(`/api/v1/certificates/${original.id}`).set(admin);
    expect(old.body).toMatchObject({ status: 'superseded', recipientName: 'Ashlyn Pierce', replacedBy: { id: res.body.id, kind: 'reissue' } });
    const link = await h.db.selectFrom('certificate_reissues').selectAll().where('original_certificate_id', '=', original.id).executeTakeFirstOrThrow();
    expect(link).toMatchObject({ new_certificate_id: res.body.id, reason_code: 'corrected_name', reissued_by: PEOPLE.grant.id });
    expect((await snapshotOf(original.id)).recipient.legalName).toBe('Ashlyn Pierce');

    const types = (id: string) => h.http.get(`/api/v1/certificates/${id}/events`).set(admin).then((r) => r.body.items.map((e: { type: string }) => e.type));
    expect(await types(original.id)).toEqual(expect.arrayContaining(['issued', 'superseded']));
    expect(await types(res.body.id)).toEqual(expect.arrayContaining(['reissued']));
    expect((await outbox(certificationEvents.reissued.type)).some((e) => (e.envelope as { payload: { originalCertificateId: string } }).payload.originalCertificateId === original.id)).toBe(true);

    // The superseded certificate cannot be reissued again; the active one can, and survives an identity outage.
    expect((await h.http.post(`/api/v1/certificates/${original.id}/reissue`).set(admin).send({ reasonCode: 'administrative', note: 'Second try' })).status).toBe(409);
    h.identity.down = true;
    const again = await h.http.post(`/api/v1/certificates/${res.body.id}/reissue`).set(admin).send({ reasonCode: 'corrected_data', note: 'Identity unavailable' });
    h.identity.down = false;
    expect(again.status).toBe(201);
    expect((await snapshotOf(again.body.id)).recipient).toMatchObject({ source: 'directory', legalName: 'Ashlyn Pierce' });
    expect(await h.db.selectFrom('certificate_reissues').select('id').where('original_certificate_id', 'in', [original.id, res.body.id]).execute()).toHaveLength(2);

    // Public verification follows the chain.
    const oldToken = original.verification_token;
    expect((await h.http.get(`/api/v1/public/certificates/verify/${oldToken}`)).body.status).toBe('superseded');
    const newToken = (await certOf(again.body.id)).verification_token;
    expect((await h.http.get(`/api/v1/public/certificates/verify/${newToken}`)).body.status).toBe('valid');
  });
});

describe('revocation', () => {
  it('requires the confirmation phrase, keeps the person on hold and shows revoked publicly', async () => {
    const cert = await h.db.selectFrom('issued_certificates').selectAll().where('user_id', '=', PEOPLE.destiny.id).where('status', '=', 'issued').executeTakeFirstOrThrow();
    const wrong = await h.http.post(`/api/v1/certificates/${cert.id}/revoke`).set(admin).send({ reason: 'Issued in error after audit review', confirmation: 'REVOKE' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.fields[0].path).toBe('confirmation');
    const short = await h.http.post(`/api/v1/certificates/${cert.id}/revoke`).set(admin).send({ reason: 'short', confirmation: `REVOKE ${cert.certificate_number}` });
    expect(short.status).toBe(400);

    const ok = await h.http
      .post(`/api/v1/certificates/${cert.id}/revoke`)
      .set(admin)
      .send({ reason: 'Compliance violation confirmed by internal audit #4471', publicNote: 'Revoked by A5 Roofing compliance.', confirmation: `revoke ${cert.certificate_number}` });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'revoked', effectiveStatus: 'revoked', revocation: { publicNote: 'Revoked by A5 Roofing compliance.', revokedBy: { displayName: 'Grant Holloway' } } });
    expect(ok.body.revocation.reason).toContain('internal audit #4471');

    const verification = await h.http.get(`/api/v1/public/certificates/verify/${cert.verification_token}`);
    expect(verification.status).toBe(200);
    expect(verification.body).toMatchObject({ status: 'revoked', revocationNote: 'Revoked by A5 Roofing compliance.', recipientName: 'Destiny Morales' });
    expect(verification.body.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect((await h.http.post(`/api/v1/certificates/${cert.id}/revoke`).set(admin).send({ reason: 'Revoking a second time please', confirmation: `REVOKE ${cert.certificate_number}` })).status).toBe(409);
    expect((await h.http.post(`/api/v1/certificates/me/${cert.id}/download`).set(await h.as('destiny'))).body.error.code).toBe('CERTIFICATE_REVOKED');
    expect((await outbox(certificationEvents.revoked.type)).length).toBe(1);
    const listed = await h.http.get('/api/v1/certificates/revocations').set(admin);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({ reason: expect.stringContaining('audit'), certificate: { id: cert.id } });

    // The person stays on hold: events never re-issue automatically, and manual issuance needs an override.
    await h.eligibility.evaluate(CERTIFICATION.id, PEOPLE.destiny.id);
    expect((await h.db.selectFrom('issued_certificates').select('id').where('user_id', '=', PEOPLE.destiny.id).where('status', '=', 'issued').execute())).toHaveLength(0);
    const manual = await h.http.post('/api/v1/certificates').set(await h.as('grant')).send({ definitionId: CERTIFICATION.id, userId: PEOPLE.destiny.id });
    expect(manual.status).toBe(422);
    expect(manual.body.error.message).toContain('was revoked');
    const reissued = await issue(PEOPLE.destiny.id);
    expect(reissued.status).toBe(201);
    expect(reissued.body.certificateNumber).not.toBe(cert.certificate_number);
  });
});
