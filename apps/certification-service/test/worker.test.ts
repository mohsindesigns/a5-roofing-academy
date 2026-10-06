import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { aiEvents, buildEvent, identityEvents, streamFor } from '@a5/events';
import { QueueFactory, RedisNamespace, StreamPublisher } from '@a5/messaging';
import { uuidv7 } from '@a5/observability';
import { waitFor } from '@a5/testing';
import {
  CERTIFICATION,
  ORGANIZATION,
  PEOPLE,
  PROGRAM,
  SCENARIOS,
  directoryUser,
  seedId,
} from '@a5/seed-data';
import { QUEUES } from '../src/jobs/queues.js';
import { createCertHarness, type CertHarness } from './harness.js';

let h: CertHarness;
let grant: Record<string, string>;
const override = { reason: 'Worker pipeline test issuance for the PDF queue' };

beforeAll(async () => {
  // `all` starts the PDF worker, the schedulers, the outbox relay and the event consumers.
  h = await createCertHarness('worker', {
    role: 'all',
    env: { CERT_PDF_STUCK_AFTER_SECONDS: '0' },
  });
  grant = await h.as('grant');
});
afterAll(() => h?.close());

const issue = async (userId: string) => {
  const res = await h.http
    .post('/api/v1/certificates')
    .set(grant)
    .send({ definitionId: CERTIFICATION.id, userId, override });
  expect(res.status).toBe(201);
  return res.body.id as string;
};
const row = (id: string) =>
  h.db.selectFrom('issued_certificates').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const queue = () => h.app.get(QueueFactory, { strict: false }).queue(QUEUES.pdf);

describe('PDF worker', () => {
  it('generates the PDF for every issued certificate through the queue, with the certificate id as job id', async () => {
    const id = await issue(PEOPLE.devon.id);
    const done = await waitFor(
      async () => {
        const c = await row(id);
        return c.pdf_status === 'ready' ? c : null;
      },
      { timeoutMs: 20_000, message: 'PDF to be generated' },
    );
    expect(done.pdf_sha256).toMatch(/^[0-9a-f]{64}$/);
    const bytes = await h.storage.getBytes(done.pdf_storage_key!);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    expect((await queue().getJob(id))?.id).toBe(id);
    const generated = await h.db
      .selectFrom('outbox_events')
      .select('envelope')
      .where('type', '=', 'certificate.generated')
      .execute();
    expect(
      generated.filter(
        (e) => (e.envelope as { payload: { certificateId: string } }).payload.certificateId === id,
      ),
    ).toHaveLength(1);
  });

  it('relays committed events to the stream', async () => {
    await waitFor(
      async () =>
        (
          await h.db
            .selectFrom('outbox_events')
            .select('id')
            .where('published_at', 'is', null)
            .execute()
        ).length === 0,
      { timeoutMs: 15_000, message: 'outbox to drain' },
    );
    const entries = await h.redis.xrange(
      new RedisNamespace(h.namespace).stream(streamFor('certification-service')),
      '-',
      '+',
    );
    const types = entries.map(([, fields]) => fields[fields.indexOf('type') + 1]);
    expect(types).toEqual(
      expect.arrayContaining(['certificate.issued', 'certificate.generated', 'audit.recorded']),
    );
  });

  it('sweeper re-enqueues certificates stuck in pending, replacing a finished job that holds the id', async () => {
    const id = await issue(PEOPLE.isaiah.id);
    await waitFor(async () => (await row(id)).pdf_status === 'ready', { timeoutMs: 20_000 });
    // Simulate a lost render: the status went back to pending although the finished job still exists.
    await h.db
      .updateTable('issued_certificates')
      .set({ pdf_status: 'pending', pdf_generated_at: null })
      .where('id', '=', id)
      .execute();
    const swept = await h.jobs.sweep(new Date(Date.now() + 60_000));
    expect(swept.pdfRequeued).toBeGreaterThanOrEqual(1);
    await waitFor(async () => (await row(id)).pdf_status === 'ready', {
      timeoutMs: 20_000,
      message: 'sweeper-requeued PDF',
    });
  });

  it('marks a certificate failed after the final attempt and lets an administrator retry', async () => {
    const id = await issue(PEOPLE.ethan.id);
    await waitFor(async () => (await row(id)).pdf_status === 'ready', { timeoutMs: 20_000 });
    await h.db
      .updateTable('issued_certificates')
      .set({ pdf_status: 'pending' })
      .where('id', '=', id)
      .execute();
    await h.pdf.recordFailure(id, new Error('Snapshot image is missing'), true);
    expect(await row(id)).toMatchObject({
      pdf_status: 'failed',
      pdf_error: 'Snapshot image is missing',
    });
    expect((await h.http.get('/api/v1/certificates/dashboard').set(grant)).body.pdfFailed).toBe(1);
    const owner = await h.http
      .post(`/api/v1/certificates/me/${id}/download`)
      .set(await h.as('ethan'));
    expect(owner.body.error.code).toBe('PDF_FAILED');

    const retried = await h.http.post(`/api/v1/certificates/${id}/pdf/retry`).set(grant);
    expect(retried.status).toBe(200);
    await waitFor(async () => (await row(id)).pdf_status === 'ready', {
      timeoutMs: 20_000,
      message: 'retried PDF',
    });
    expect((await h.http.get('/api/v1/certificates/dashboard').set(grant)).body.pdfFailed).toBe(0);
    const download = await h.http
      .post(`/api/v1/certificates/me/${id}/download`)
      .set(await h.as('ethan'));
    expect(download.status).toBe(200);
  });
});

describe('schedulers', () => {
  it('registers the daily lifecycle and reminder schedulers and processes their jobs', async () => {
    const factory = h.app.get(QueueFactory, { strict: false });
    for (const [name, pattern] of [
      [QUEUES.expiry, h.config.certification.lifecycleCron],
      [QUEUES.reminders, h.config.certification.remindersCron],
    ] as const) {
      const schedulers = await factory.queue(name).getJobSchedulers();
      expect(schedulers.map((s) => [s.key, s.pattern])).toEqual([['daily', pattern]]);
    }
    const job = await factory.queue(QUEUES.expiry).add('run', {} as never);
    const result = await waitFor(
      async () => {
        const fresh = await factory.queue(QUEUES.expiry).getJob(job.id!);
        return fresh && (await fresh.getState()) === 'completed' ? fresh.returnvalue : null;
      },
      { timeoutMs: 15_000, message: 'daily lifecycle job' },
    );
    expect(result).toMatchObject({
      expired: expect.any(Number),
      renewalsOpened: expect.any(Number),
      reminders: expect.any(Number),
    });
  });
});

describe('event consumers', () => {
  it('apply stream events to the fact projections exactly once', async () => {
    const s = SCENARIOS[0]!;
    const envelope = buildEvent(
      aiEvents.scoreGenerated,
      {
        sessionId: seedId('t:stream:session'),
        scenarioId: s.id,
        scenarioTitle: s.title,
        scenarioCategory: s.category,
        difficulty: s.difficulty,
        userId: PEOPLE.kayla.id,
        overallScore: 87,
        passed: true,
        passingScore: s.passingScore,
        categoryScores: [],
        context: { programId: PROGRAM.id },
        evaluatedAt: new Date().toISOString(),
        promptVersionId: seedId('t:p'),
        rubricVersionId: seedId('t:r'),
      },
      {
        id: uuidv7(),
        producer: 'ai-coaching-service',
        organizationId: ORGANIZATION.id,
        actor: { type: 'system', id: null },
      },
    );
    const publisher = new StreamPublisher(h.redis, new RedisNamespace(h.namespace));
    await publisher.publish([{ stream: streamFor('ai-coaching-service'), envelope }]);
    await publisher.publish([{ stream: streamFor('ai-coaching-service'), envelope }]);

    await waitFor(
      async () =>
        (
          await h.db
            .selectFrom('learner_ai_results')
            .select('session_id')
            .where('user_id', '=', PEOPLE.kayla.id)
            .execute()
        ).length === 1,
      { timeoutMs: 15_000, message: 'projection' },
    );
    await waitFor(
      async () =>
        (
          await h.db
            .selectFrom('inbox_events')
            .select('event_id')
            .where('event_id', '=', envelope.id)
            .execute()
        ).length === 1,
      { timeoutMs: 5_000 },
    );
    const progress = await h.http
      .get(`/api/v1/certifications/${CERTIFICATION.id}/progress?userId=${PEOPLE.kayla.id}`)
      .set(grant);
    expect(
      progress.body.requirements.find((r: { type: string }) => r.type === 'ai_sessions_count')
        .progress,
    ).toMatchObject({ current: 1, target: 5 });
  });

  it('keeps the identity directory projection current and ignores stale revisions', async () => {
    const publisher = new StreamPublisher(h.redis, new RedisNamespace(h.namespace));
    const record = directoryUser('hector');
    const publish = (revision: number, jobTitle: string) =>
      publisher.publish([
        {
          stream: streamFor('identity-service'),
          envelope: buildEvent(
            identityEvents.directoryUserUpserted,
            { user: { ...record, jobTitle }, revision },
            {
              id: uuidv7(),
              producer: 'identity-service',
              organizationId: ORGANIZATION.id,
              actor: { type: 'system', id: null },
            },
          ),
        },
      ]);
    await publish(3, 'Senior Field Sales Trainer');
    await publish(2, 'Stale Title');
    const title = () =>
      h.db
        .selectFrom('dir_users')
        .select('job_title')
        .where('id', '=', PEOPLE.hector.id)
        .executeTakeFirstOrThrow()
        .then((r) => r.job_title);
    await waitFor(async () => (await title()) === 'Senior Field Sales Trainer', {
      timeoutMs: 15_000,
      message: 'directory update',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await title()).toBe('Senior Field Sales Trainer');
  });
});
