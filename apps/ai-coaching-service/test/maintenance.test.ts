import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueFactory } from '@a5/messaging';
import { PEOPLE } from '@a5/seed-data';
import { MaintenanceService } from '../src/sessions/maintenance.service.js';
import { createAiHarness, sendStreaming, startSession, type AiHarness } from './harness.js';

let h: AiHarness;
let maintenance: MaintenanceService;

beforeAll(async () => {
  h = await createAiHarness('maintenance');
  maintenance = h.app.get(MaintenanceService);
});
afterAll(() => h?.close());

describe('maintenance sweep', () => {
  it('ends idle sessions with reason timeout and queues scoring for those with replies', async () => {
    const tyler = await h.as('tyler');
    const { body: spoken } = await startSession(h, tyler, 'roof-fine');
    await sendStreaming(h, tyler, spoken.id, { text: "Hi, I'm Tyler with A5 Roofing." });
    const { body: silent } = await startSession(h, tyler, 'roof-fine');
    const longAgo = new Date(Date.now() - 3 * 3_600_000);
    await h.db
      .updateTable('ai_sessions')
      .set({ last_activity_at: longAgo })
      .where('id', 'in', [spoken.id, silent.id])
      .execute();

    const result = await maintenance.sweep();
    expect(result.timedOut).toBeGreaterThanOrEqual(2);

    const a = (await h.http.get(`/api/v1/ai/sessions/${spoken.id}`).set(tyler)).body;
    expect(a).toMatchObject({ status: 'ended', endReason: 'timeout', turnCount: 1 });
    const b = (await h.http.get(`/api/v1/ai/sessions/${silent.id}`).set(tyler)).body;
    expect(b).toMatchObject({ status: 'abandoned', endReason: 'timeout' });
    const completed = await h.db
      .selectFrom('outbox_events')
      .select('envelope')
      .where('type', '=', 'ai.session.completed')
      .execute();
    const ids = completed.map((e) => (e.envelope as { subject: { id: string } }).subject.id);
    expect(ids).toContain(spoken.id);
    expect(ids).not.toContain(silent.id);
    const job = await h.app.get(QueueFactory).queue('ai.evaluate').getJob(spoken.id);
    expect(job?.id).toBe(spoken.id);

    // A second sweep finds nothing to do.
    expect((await maintenance.sweep()).timedOut).toBe(0);
    // Active sessions that are still fresh are left alone.
    const { body: fresh } = await startSession(h, tyler, 'roof-fine');
    await maintenance.sweep();
    expect((await h.http.get(`/api/v1/ai/sessions/${fresh.id}`).set(tyler)).body.status).toBe(
      'active',
    );
  });

  it('re-queues sessions whose evaluation job was lost', async () => {
    const kayla = await h.as('kayla');
    const { body: session } = await startSession(h, kayla, 'roof-fine');
    await sendStreaming(h, kayla, session.id, { text: "Hi, I'm Kayla with A5 Roofing." });
    await h.http.post(`/api/v1/ai/sessions/${session.id}/end`).set(kayla).expect(200);
    const queue = h.app.get(QueueFactory).queue('ai.evaluate');
    await (await queue.getJob(session.id))?.remove();
    expect(await queue.getJob(session.id)).toBeUndefined();
    await h.db
      .updateTable('ai_sessions')
      .set({ ended_at: new Date(Date.now() - 10 * 60_000) })
      .where('id', '=', session.id)
      .execute();
    const result = await maintenance.sweep();
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    expect((await queue.getJob(session.id))?.id).toBe(session.id);
  });

  it('purges transcripts past the retention period but keeps scores', async () => {
    const admin = await h.as('grant');
    await h.http
      .put('/api/v1/ai/settings')
      .set(admin)
      .send({ transcriptRetentionDays: 365 })
      .expect(200);
    const result = await maintenance.sweep();
    // Ashlyn (570 days ago), Sofia (700) and Destiny (458-470) practiced more than a year ago.
    const old = await h.db
      .selectFrom('ai_sessions')
      .select('id')
      .where('user_id', 'in', [PEOPLE.ashlyn.id, PEOPLE.sofia.id, PEOPLE.destiny.id])
      .where('ended_at', '<', new Date(Date.now() - 366 * 86_400_000))
      .execute();
    expect(result.purged).toBeGreaterThanOrEqual(old.length);
    expect(old.length).toBeGreaterThan(10);

    const sessionId = (
      await h.db
        .selectFrom('ai_sessions')
        .select('id')
        .where('user_id', '=', PEOPLE.ashlyn.id)
        .limit(1)
        .executeTakeFirstOrThrow()
    ).id;
    const purged = (await h.http.get(`/api/v1/ai/sessions/${sessionId}`).set(await h.as('ashlyn')))
      .body;
    expect(purged.transcriptPurged).toBe(true);
    expect(purged.messages).toEqual([]);
    expect(purged.evaluation.overallScore).toBeGreaterThan(0);
    expect(
      await h.db
        .selectFrom('ai_messages')
        .select('id')
        .where('session_id', '=', sessionId)
        .execute(),
    ).toEqual([]);

    // Recent transcripts are untouched.
    const caleb = await h.db
      .selectFrom('ai_sessions')
      .select('id')
      .where('user_id', '=', PEOPLE.caleb.id)
      .executeTakeFirstOrThrow();
    expect(
      (await h.http.get(`/api/v1/ai/sessions/${caleb.id}`).set(await h.as('caleb'))).body.messages
        .length,
    ).toBeGreaterThan(5);
  });
});
