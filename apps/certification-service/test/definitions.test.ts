import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { certification } from '@a5/contracts';
import { aiEvents } from '@a5/events';
import { CERTIFICATE_TEMPLATES, CERTIFICATION, PEOPLE, PROGRAM, SCENARIOS, SIGNATORIES, STAMPS, seedId } from '@a5/seed-data';
import { createCertHarness, type CertHarness } from './harness.js';

let h: CertHarness;
let admin: Record<string, string>;
const classic = CERTIFICATE_TEMPLATES[0].id;

beforeAll(async () => {
  h = await createCertHarness('definitions');
  admin = await h.as('shelby');
});
afterAll(() => h?.close());

const base = (overrides: Record<string, unknown> = {}) => ({
  name: 'Storm Response Specialist',
  code: 'storm',
  publicDescription: 'Field-ready for hail and wind claim canvassing.',
  issuingOrganizationName: 'A5 Roofing LLC',
  templateId: classic,
  signatories: [
    { slot: 1, signatoryId: SIGNATORIES[0].id },
    { slot: 2, signatoryId: SIGNATORIES[1].id },
  ],
  stampId: STAMPS[0].id,
  approvalPolicy: 'none',
  automaticIssuance: false,
  numberPattern: '{ORG}-{CODE}-{YY}{MM}-{SEQ:5}',
  eligibilityRule: { type: 'all', rules: [{ type: 'ai_sessions_count', minCount: 2, minScore: 80 }] },
  ...overrides,
});

describe('numbering patterns and designs (shared contracts)', () => {
  it('validates numbering tokens and formats numbers', () => {
    expect(certification.numberPatternProblems('{ORG}-{CODE}-{YYYY}-{SEQ:6}')).toEqual([]);
    expect(certification.numberPatternProblems('{CODE}-{SEQ:4}')).toEqual([]);
    expect(certification.numberPatternProblems('{ORG}-{YYYY}-{SEQ:6}').join()).toContain('{CODE}');
    expect(certification.numberPatternProblems('{ORG}-{CODE}-{NOPE}-{SEQ:6}').join()).toContain('Unknown token {NOPE}');
    expect(certification.numberPatternProblems('{CODE}-{SEQ}').join()).toContain('width');
    expect(certification.numberPatternProblems('{CODE}-{SEQ:6}-{SEQ:6}').join()).toContain('exactly one {SEQ:n}');
    expect(certification.numberPatternProblems('{CODE} {SEQ:6}').join()).toContain('Only letters');
    const n = certification.formatCertificateNumber('{ORG}-{CODE}-{YYYY}-{SEQ:6}', { org: 'A5', code: 'SALES', issuedAt: new Date('2026-03-01T00:00:00Z'), seq: 184 });
    expect(n).toBe('A5-SALES-2026-000184');
  });

  it('keeps design elements inside the safe area and requires matching image placeholders', () => {
    const el = { id: 'a', type: 'text', content: 'Hello {{recipient_name}}', x: 10, y: 10, width: 50, height: 10 };
    const design = (elements: unknown[]) => ({ page: { size: 'A4', orientation: 'portrait' }, theme: { backgroundColor: '#FFFFFF', border: { style: 'none', color: '#000000', width: 1, inset: 2 }, accentColor: '#000000', fontFamily: 'sans' }, elements });
    expect(certification.templateDesignSchema.safeParse(design([el])).success).toBe(true);
    expect(certification.templateDesignSchema.safeParse(design([{ ...el, x: 1 }])).success).toBe(false);
    expect(certification.templateDesignSchema.safeParse(design([{ ...el, x: 60, width: 45 }])).success).toBe(false);
    expect(certification.templateDesignSchema.safeParse(design([el, el])).success).toBe(false);
    expect(certification.templateDesignSchema.safeParse(design([{ ...el, content: '{{qr_code}}' }])).success).toBe(false);
    expect(certification.templateDesignSchema.safeParse(design([{ ...el, type: 'qr', content: '{{qr_code}}' }])).success).toBe(true);
    expect(certification.templateDesignSchema.safeParse(design([{ ...el, type: 'qr', content: 'https://evil.example' }])).success).toBe(false);
    expect(certification.templateDesignSchema.safeParse(design([{ ...el, type: 'image' }])).success).toBe(false);
    expect(certification.templateDesignSchema.safeParse(design([{ ...el, color: 'red' }])).success).toBe(false);
    expect(certification.customPlaceholdersOf({ elements: [{ ...el, content: '{{division}} {{recipient_name}}' }] as never })).toEqual(['division']);
  });
});

describe('certification definitions', () => {
  it('creates drafts, validates references and refuses activation without requirements', async () => {
    const draft = await h.http.post('/api/v1/certifications').set(admin).send(base({ eligibilityRule: { type: 'all', rules: [] } }));
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ status: 'draft', code: 'STORM', requirementCount: 0, approvalPolicy: 'none' });
    expect(draft.body.renewal.reminderOffsets).toEqual([90, 60, 30, 7]);

    const refused = await h.http.post(`/api/v1/certifications/${draft.body.id}/activate`).set(admin);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('ELIGIBILITY_RULE_REQUIRED');

    const withRule = await h.http.patch(`/api/v1/certifications/${draft.body.id}`).set(admin).send({ eligibilityRule: base().eligibilityRule });
    expect(withRule.body.requirements).toEqual([{ type: 'ai_sessions_count', description: 'Complete 2 AI role-plays scoring 80+' }]);
    const active = await h.http.post(`/api/v1/certifications/${draft.body.id}/activate`).set(admin);
    expect(active.status).toBe(200);
    expect(active.body).toMatchObject({ status: 'active' });
    expect(active.body.numberPreview).toMatch(/^A5-STORM-\d{4}-00001$/);
  });

  it('rejects duplicate codes, bad numbering patterns, missing signatories and conflicting approval settings', async () => {
    const dup = await h.http.post('/api/v1/certifications').set(admin).send(base());
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CODE_TAKEN');

    const pattern = await h.http.post('/api/v1/certifications').set(admin).send(base({ code: 'PAT', numberPattern: '{ORG}-{YYYY}-{SEQ:6}' }));
    expect(pattern.status).toBe(400);
    expect(pattern.body.error.fields[0].message).toContain('{CODE}');

    const ghost = await h.http.post('/api/v1/certifications').set(admin).send(base({ code: 'GHOST', signatories: [{ slot: 1, signatoryId: seedId('t:nobody') }] }));
    expect(ghost.status).toBe(400);
    expect(ghost.body.error.fields[0].path).toBe('signatories');

    const same = await h.http.post('/api/v1/certifications').set(admin).send(base({ code: 'SAME', signatories: [{ slot: 1, signatoryId: SIGNATORIES[0].id }, { slot: 2, signatoryId: SIGNATORIES[0].id }] }));
    expect(same.status).toBe(400);

    const policy = await h.http
      .post('/api/v1/certifications')
      .set(admin)
      .send(base({ code: 'POL', approvalPolicy: 'manager', eligibilityRule: { type: 'all', rules: [{ type: 'ai_sessions_count', minCount: 1 }, { type: 'approval', kind: 'trainer' }] } }));
    expect(policy.status).toBe(400);
    expect(policy.body.error.fields[0].message).toContain('trainer');

    const selfRef = await h.http.post('/api/v1/certifications').set(admin).send(base({ code: 'DATE', validity: { kind: 'fixed_date', date: '2020-01-01' } }));
    expect(selfRef.status).toBe(400);
    expect(selfRef.body.error.fields[0].path).toBe('validity.date');
  });

  it('adds the approval requirement implied by the approval policy', async () => {
    const res = await h.http.post('/api/v1/certifications').set(admin).send(base({ code: 'MGR', approvalPolicy: 'manager' }));
    expect(res.status).toBe(201);
    expect(res.body.requirements.map((r: { description: string }) => r.description)).toEqual(['Complete 2 AI role-plays scoring 80+', 'Manager approval']);
  });

  it('evaluates people on events, then lets an authorized person issue manually when automatic issuance is off', async () => {
    const stormId = (await h.http.get('/api/v1/certifications?q=storm').set(admin)).body.items.find((c: { code: string }) => c.code === 'STORM').id;
    const score = (n: number) => ({
      sessionId: seedId(`t:storm:${n}`),
      scenarioId: SCENARIOS[0]!.id,
      scenarioTitle: SCENARIOS[0]!.title,
      scenarioCategory: 'Brush-off',
      difficulty: 'beginner',
      userId: PEOPLE.tyler.id,
      overallScore: 85,
      passed: true,
      passingScore: 75,
      categoryScores: [],
      context: { programId: PROGRAM.id },
      evaluatedAt: new Date().toISOString(),
      promptVersionId: seedId('t:p'),
      rubricVersionId: seedId('t:r'),
    });
    await h.deliver(aiEvents.scoreGenerated, score(1));
    let progress = await h.http.get(`/api/v1/certifications/${stormId}/progress?userId=${PEOPLE.tyler.id}`).set(admin);
    expect(progress.body).toMatchObject({ status: 'in_progress', metCount: 0, totalCount: 1 });
    expect(progress.body.requirements[0].progress).toMatchObject({ current: 1, target: 2 });

    await h.deliver(aiEvents.scoreGenerated, score(2));
    progress = await h.http.get(`/api/v1/certifications/${stormId}/progress?userId=${PEOPLE.tyler.id}`).set(admin);
    expect(progress.body).toMatchObject({ status: 'eligible', metCount: 1, totalCount: 1 });
    // Eligible once; automatic issuance is off so nothing was issued.
    expect((await h.db.selectFrom('issued_certificates').select('id').where('definition_id', '=', stormId).execute())).toHaveLength(0);
    const queue = await h.http.get(`/api/v1/certificates/eligibility?definitionId=${stormId}`).set(admin);
    expect(queue.body.items).toHaveLength(1);
    expect(queue.body.items[0]).toMatchObject({ user: { displayName: 'Tyler Brennan' }, status: 'eligible', metCount: 1, totalCount: 1 });
    const events = await h.db.selectFrom('outbox_events').select('id').where('type', '=', 'certificate.eligible').execute();
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Training administrators can see the queue but issuing needs the certificates.issue permission.
    expect((await h.http.post('/api/v1/certificates').set(admin).send({ definitionId: stormId, userId: PEOPLE.tyler.id })).status).toBe(403);
    const issued = await h.http.post('/api/v1/certificates').set(await h.as('grant')).send({ definitionId: stormId, userId: PEOPLE.tyler.id });
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({ mode: 'manual', overrideReason: null, issuedBy: { displayName: 'Grant Holloway' } });
    expect(issued.body.certificateNumber).toMatch(/^A5-STORM-\d{4}-00001$/);
    expect((await h.http.get(`/api/v1/certificates/eligibility?definitionId=${stormId}`).set(admin)).body.items).toHaveLength(0);
  });

  it('re-evaluates candidates when the requirements of an active certification change', async () => {
    const stormId = (await h.http.get('/api/v1/certifications?q=storm').set(admin)).body.items.find((c: { code: string }) => c.code === 'STORM').id;
    const strict = await h.http
      .patch(`/api/v1/certifications/${stormId}`)
      .set(admin)
      .send({ eligibilityRule: { type: 'all', rules: [{ type: 'ai_sessions_count', minCount: 3, minScore: 80 }] } });
    expect(strict.status).toBe(200);
    expect(strict.body.revision).toBeGreaterThan(1);
    const cand = await h.db.selectFrom('certification_candidates').select(['status', 'met_count']).where('definition_id', '=', stormId).where('user_id', '=', PEOPLE.tyler.id).executeTakeFirstOrThrow();
    // Already certified people keep their certificate; the change does not take it away.
    expect(cand.status).toBe('issued');
  });

  it('archives certifications without touching issued certificates', async () => {
    const stormId = (await h.http.get('/api/v1/certifications?q=storm').set(admin)).body.items.find((c: { code: string }) => c.code === 'STORM').id;
    const archived = await h.http.post(`/api/v1/certifications/${stormId}/archive`).set(admin);
    expect(archived.body.status).toBe('archived');
    expect((await h.http.patch(`/api/v1/certifications/${stormId}`).set(admin).send({ name: 'Renamed' })).status).toBe(422);
    expect((await h.db.selectFrom('issued_certificates').select('status').where('definition_id', '=', stormId).executeTakeFirstOrThrow()).status).toBe('issued');
    expect((await h.http.post('/api/v1/certificates').set(await h.as('grant')).send({ definitionId: stormId, userId: PEOPLE.kayla.id, override: { reason: 'Archived certification test' } })).status).toBe(422);
  });
});

describe('templates', () => {
  it('lists the starter designs and the seeded templates', async () => {
    const starters = await h.http.get('/api/v1/certificate-templates/starters').set(admin);
    expect(starters.body.items.map((s: { key: string }) => s.key)).toEqual(['classic', 'modern']);
    const list = await h.http.get('/api/v1/certificate-templates').set(admin);
    expect(list.body.items.map((t: { name: string; isDefault: boolean }) => [t.name, t.isDefault])).toEqual([
      ['Classic Landscape', true],
      ['Modern Portrait', false],
    ]);
    expect(list.body.items[0]).toMatchObject({ page: { size: 'LETTER', orientation: 'landscape' }, currentVersion: 1 });
    expect(list.body.items[1].page).toEqual({ size: 'LETTER', orientation: 'portrait' });
    expect((await h.http.get('/api/v1/certificate-templates').set(await h.as('marcus'))).status).toBe(403);
  });

  it('creates from a starter, clones, edits (new version), sets default and archives', async () => {
    const created = await h.http.post('/api/v1/certificate-templates').set(admin).send({ name: 'Field Ready', starter: 'modern' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ currentVersion: 1, isDefault: false, status: 'active', page: { orientation: 'portrait' } });
    expect((await h.http.post('/api/v1/certificate-templates').set(admin).send({ name: 'field ready', starter: 'classic' })).status).toBe(409);

    const clone = await h.http.post(`/api/v1/certificate-templates/${created.body.id}/clone`).set(admin).send({ name: 'Field Ready (A4)' });
    expect(clone.status).toBe(201);
    expect(clone.body).toMatchObject({ clonedFromId: created.body.id, currentVersion: 1 });

    const design = structuredClone(clone.body.design);
    design.page.size = 'A4';
    const edited = await h.http.put(`/api/v1/certificate-templates/${clone.body.id}/design`).set(admin).send({ design, changeNote: 'A4 paper' });
    expect(edited.body).toMatchObject({ currentVersion: 2, page: { size: 'A4' } });
    const v1 = await h.http.get(`/api/v1/certificate-templates/${clone.body.id}/versions`).set(admin);
    const first = await h.http.get(`/api/v1/certificate-templates/${clone.body.id}/versions/${v1.body.items[1].id}`).set(admin);
    expect(first.body.design.page.size).toBe('LETTER');

    // Invalid designs are explained, not silently clamped.
    const outside = structuredClone(design);
    outside.elements[0].x = 0;
    const bad = await h.http.put(`/api/v1/certificate-templates/${clone.body.id}/design`).set(admin).send({ design: outside });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields[0].message).toContain('printable area');

    // Placeholders beyond the built-ins must be defined on every certification that uses the template.
    const custom = structuredClone(design);
    custom.elements.push({ id: 'division', type: 'text', content: 'Division: {{division}}', x: 10, y: 80, width: 30, height: 4 });
    await h.http.put(`/api/v1/certificate-templates/${clone.body.id}/design`).set(admin).send({ design: custom });
    const cert = await h.http.post('/api/v1/certifications').set(admin).send(base({ code: 'DIV', templateId: clone.body.id, eligibilityRule: { type: 'all', rules: [{ type: 'ai_sessions_count', minCount: 1 }] } }));
    expect(cert.status).toBe(400);
    expect(cert.body.error.fields[0].message).toContain('{{division}}');
    const withVar = await h.http
      .post('/api/v1/certifications')
      .set(admin)
      .send(base({ code: 'DIV', templateId: clone.body.id, customVariables: [{ key: 'division', label: 'Division', value: 'Residential' }], eligibilityRule: { type: 'all', rules: [{ type: 'ai_sessions_count', minCount: 1 }] } }));
    expect(withVar.status).toBe(201);

    expect((await h.http.post(`/api/v1/certificate-templates/${clone.body.id}/archive`).set(admin)).body.error.code).toBe('TEMPLATE_IN_USE');
    const assign = await h.http.post(`/api/v1/certificate-templates/${created.body.id}/assign`).set(admin).send({ certificationIds: [withVar.body.id] });
    expect(assign.status).toBe(200);
    expect(assign.body.usedBy.map((u: { code: string }) => u.code)).toEqual(['DIV']);
    expect((await h.http.post(`/api/v1/certificate-templates/${created.body.id}/archive`).set(admin)).body.error.code).toBe('TEMPLATE_IN_USE');

    const archived = await h.http.post(`/api/v1/certificate-templates/${clone.body.id}/archive`).set(admin);
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('archived');
    expect((await h.http.put(`/api/v1/certificate-templates/${clone.body.id}/design`).set(admin).send({ design })).body.error.code).toBe('TEMPLATE_ARCHIVED');
    // Rules that need the template's own placeholders are checked on assignment too.
    const reassign = await h.http.post(`/api/v1/certificate-templates/${clone.body.id}/assign`).set(admin).send({ certificationIds: [withVar.body.id] });
    expect(reassign.status).toBe(422);

    const def = await h.http.post(`/api/v1/certificate-templates/${CERTIFICATE_TEMPLATES[1].id}/default`).set(admin);
    expect(def.body.isDefault).toBe(true);
    expect((await h.http.get(`/api/v1/certificate-templates/${CERTIFICATE_TEMPLATES[0].id}`).set(admin)).body.isDefault).toBe(false);
    expect((await h.http.post(`/api/v1/certificate-templates/${CERTIFICATE_TEMPLATES[1].id}/archive`).set(admin)).body.error.code).toBe('TEMPLATE_IS_DEFAULT');
    await h.http.post(`/api/v1/certificate-templates/${CERTIFICATE_TEMPLATES[0].id}/default`).set(admin);
  });

  it('previews with sample data: a PDF and resolved elements for the live HTML preview', async () => {
    const preview = await h.http.post(`/api/v1/certificate-templates/${CERTIFICATE_TEMPLATES[0].id}/preview`).set(admin).send({ certificationId: CERTIFICATION.id });
    expect(preview.status).toBe(200);
    expect(preview.body.page).toEqual({ size: 'LETTER', orientation: 'landscape', widthPt: 792, heightPt: 612 });
    expect(preview.body.warnings).toEqual([]);
    const byId = Object.fromEntries(preview.body.elements.map((e: { id: string }) => [e.id, e]));
    expect(byId.recipient).toMatchObject({ type: 'text', text: 'Jordan Ellis', x: 10, y: 32.5, width: 80, height: 10, fontSize: 38, fontWeight: 'bold' });
    expect(byId.certification.text).toBe(CERTIFICATION.name);
    expect(byId['signatory-1-name'].text).toBe('Priya Raman');
    expect(byId['signature-1'].imageUrl).toMatch(/certification-files\/object\?key=/);
    expect(byId.stamp.imageUrl).not.toBeNull();
    expect(byId.qr.qrValue).toContain('/verify/SAMPLE-PREVIEW');
    expect(preview.body.sampleValues.certificate_number).toMatch(/^A5-SALES-\d{4}-0000\d\d$/);

    const url = new URL(preview.body.pdfUrl);
    const pdf = await h.http.get(`${url.pathname}${url.search}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    const doc = await PDFDocument.load(pdf.body as Buffer);
    expect(doc.getPageCount()).toBe(1);

    // Unsaved designs from the designer can be previewed too, and warn about missing artwork.
    const draft = structuredClone((await h.http.get(`/api/v1/certificate-templates/${CERTIFICATE_TEMPLATES[1].id}`).set(admin)).body.design);
    draft.elements.find((e: { id: string }) => e.id === 'recipient').fontSize = 28;
    draft.elements.push({ id: 'extra', type: 'text', content: '{{unknown_thing}}', x: 10, y: 92, width: 30, height: 3 });
    const unsaved = await h.http.post(`/api/v1/certificate-templates/${CERTIFICATE_TEMPLATES[1].id}/preview`).set(admin).send({ design: draft });
    expect(unsaved.status).toBe(200);
    expect(unsaved.body.elements.find((e: { id: string }) => e.id === 'recipient').fontSize).toBe(28);
    expect(unsaved.body.warnings.join(' ')).toContain('{{unknown_thing}}');
    expect(unsaved.body.page.orientation).toBe('portrait');
  });
});

describe('signatories and stamps', () => {
  it('manages signatories with effective dates and protects those in use', async () => {
    const created = await h.http.post('/api/v1/signatories').set(await h.as('priya')).send({
      name: 'Hector Villanueva',
      title: 'Field Sales Trainer',
      department: 'Sales Training & Enablement',
      userId: PEOPLE.hector.id,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
      allowedCertificationIds: [CERTIFICATION.id],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ active: true, effectiveFrom: '2026-01-01', allowedCertificationIds: [CERTIFICATION.id], currentSignature: null, createdBy: { displayName: 'Priya Raman' } });

    const badRange = await h.http.post('/api/v1/signatories').set(await h.as('priya')).send({ name: 'X Y', title: 'T', effectiveFrom: '2026-05-01', effectiveTo: '2026-01-01' });
    expect(badRange.status).toBe(400);

    // A signatory without a signature image cannot be assigned to an active certification's slot.
    const noSignature = await h.http.patch(`/api/v1/certifications/${CERTIFICATION.id}`).set(admin).send({ signatories: [{ slot: 1, signatoryId: created.body.id }, { slot: 2, signatoryId: SIGNATORIES[1].id }] });
    expect(noSignature.status).toBe(422);
    expect(noSignature.body.error.code).toBe('SIGNATURE_MISSING');
    const wrongList = await h.http.patch(`/api/v1/certifications/${CERTIFICATION.id}`).set(admin).send({ signatories: [{ slot: 1, signatoryId: SIGNATORIES[0].id }] });
    expect(wrongList.status).toBe(422);
    expect(wrongList.body.error.code).toBe('SIGNATORY_MISSING');

    const inUse = await h.http.patch(`/api/v1/signatories/${SIGNATORIES[0].id}`).set(await h.as('priya')).send({ active: false });
    expect(inUse.status).toBe(422);
    expect(inUse.body.error.code).toBe('SIGNATORY_IN_USE');
    const off = await h.http.patch(`/api/v1/signatories/${created.body.id}`).set(await h.as('priya')).send({ active: false, title: 'Senior Trainer' });
    expect(off.body).toMatchObject({ active: false, title: 'Senior Trainer' });
    expect((await h.http.get('/api/v1/signatories?active=true').set(await h.as('priya'))).body.items.map((s: { name: string }) => s.name)).toEqual(['Priya Raman', 'Shelby Hartman']);
  });

  it('manages stamps and protects those in use', async () => {
    const priya = await h.as('priya');
    const stamp = await h.http.post('/api/v1/stamps').set(priya).send({ name: 'Sales Training Seal', kind: 'department', departmentName: 'Sales Training & Enablement' });
    expect(stamp.status).toBe(201);
    expect(stamp.body).toMatchObject({ kind: 'department', active: true, currentImage: null });
    const inUse = await h.http.patch(`/api/v1/stamps/${STAMPS[0].id}`).set(priya).send({ active: false });
    expect(inUse.status).toBe(422);
    expect(inUse.body.error.code).toBe('STAMP_IN_USE');
    const noImage = await h.http.patch(`/api/v1/certifications/${CERTIFICATION.id}`).set(admin).send({ stampId: stamp.body.id });
    expect(noImage.status).toBe(422);
    expect(noImage.body.error.code).toBe('STAMP_IMAGE_MISSING');
    // Shelby manages certifications but not stamps.
    expect((await h.http.post('/api/v1/stamps').set(admin).send({ name: 'Nope', kind: 'company' })).status).toBe(403);
  });
});
