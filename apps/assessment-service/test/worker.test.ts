import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { assessment } from '@a5/contracts';
import { buildEvent, identityEvents, streamFor } from '@a5/events';
import { StreamPublisher } from '@a5/messaging';
import { uuidv7 } from '@a5/observability';
import { PEOPLE, TEAMS, directoryUser } from '@a5/seed-data';
import { waitFor } from '@a5/testing';
import { ExpirySweeper } from '../src/attempts/expiry.sweeper.js';
import {
  createAssessment,
  createAssessmentHarness,
  createBank,
  createQuestion,
  principalDataFor,
  sampleQuestions,
  type AssessmentHarness,
  type Author,
} from './harness.js';

let h: AssessmentHarness;
let author: Author;
let questionId: string;

beforeAll(async () => {
  h = await createAssessmentHarness('worker', { role: 'all' });
  author = { http: h.http, headers: await h.as('shelby') };
  const bank = await createBank(author, 'Worker bank');
  questionId = (await createQuestion(author, bank.id, sampleQuestions.multipleChoice('w'))).id;
});
afterAll(() => h?.close());

async function quiz(title: string, config: Partial<assessment.AssessmentConfig> = {}) {
  return createAssessment(author, { title, config, items: [{ kind: 'question', questionId }] });
}

async function start(person: keyof typeof PEOPLE, assessmentId: string) {
  const headers = await h.as(person);
  const res = await h.http.post('/api/v1/attempts').set(headers).send({ assessmentId });
  expect(res.status).toBe(201);
  return { headers, attempt: res.body as assessment.LearnerAttempt };
}

describe('expiry job', () => {
  it('auto-submits overdue attempts through the BullMQ queue', async () => {
    const a = await quiz('Queue expiry', { timeLimitSeconds: 60 });
    const { attempt, headers } = await start('kayla', a.id);
    await h.http
      .put(`/api/v1/attempts/${attempt.id}/answers/${attempt.questions[0]!.id}`)
      .set(headers)
      .send({ response: { type: 'multiple_choice', optionId: 'a' } })
      .expect(200);
    h.clock.advanceMinutes(2);
    try {
      await h.app.get(ExpirySweeper).enqueueSweep(`test-sweep-${attempt.id}`);
      const row = await waitFor(
        async () => {
          const r = await h.db.selectFrom('attempts').select(['status', 'auto_submitted', 'score_percent', 'submitted_at', 'expires_at']).where('id', '=', attempt.id).executeTakeFirstOrThrow();
          return r.status === 'graded' ? r : null;
        },
        { timeoutMs: 20_000, intervalMs: 200, message: 'the expiry job to auto-submit the attempt' },
      );
      expect(row).toMatchObject({ auto_submitted: true, score_percent: 100 });
      expect(row.submitted_at!.getTime()).toBe(row.expires_at!.getTime());
      const events = await h.db.selectFrom('outbox_events').select('type').where('envelope', '@>', { subject: { id: attempt.id } } as never).execute();
      expect(events.map((e) => e.type).sort()).toEqual(['assessment.attempt.graded', 'assessment.attempt.started', 'assessment.attempt.submitted']);
    } finally {
      h.clock.advanceMinutes(-2);
    }
  });

  it('runs on a schedule without being asked', async () => {
    const a = await quiz('Scheduled expiry', { timeLimitSeconds: 60 });
    const { attempt } = await start('jordan', a.id);
    h.clock.advanceMinutes(2);
    try {
      const row = await waitFor(
        async () => {
          const r = await h.db.selectFrom('attempts').select(['status', 'auto_submitted']).where('id', '=', attempt.id).executeTakeFirstOrThrow();
          return r.status === 'graded' ? r : null;
        },
        { timeoutMs: 30_000, intervalMs: 250, message: 'the repeatable sweep to close the attempt' },
      );
      expect(row.auto_submitted).toBe(true);
    } finally {
      h.clock.advanceMinutes(-2);
    }
  });

  it('finishes grading of attempts whose submission was interrupted', async () => {
    const a = await quiz('Interrupted submit');
    const { attempt, headers } = await start('marcus', a.id);
    await h.http
      .put(`/api/v1/attempts/${attempt.id}/answers/${attempt.questions[0]!.id}`)
      .set(headers)
      .send({ response: { type: 'multiple_choice', optionId: 'a' } })
      .expect(200);
    // Simulate a crash between closing the attempt and grading it.
    await h.db
      .updateTable('attempts')
      .set({ status: 'submitted', submitted_at: new Date(Date.now() - 10 * 60_000) })
      .where('id', '=', attempt.id)
      .execute();
    const outcome = await h.app.get(ExpirySweeper).sweep();
    expect(outcome.graded).toBeGreaterThanOrEqual(1);
    const row = await h.db.selectFrom('attempts').select(['status', 'score_percent']).where('id', '=', attempt.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'graded', score_percent: 100 });
    // The learner opening the attempt also repairs it, and the result is stable.
    const result = await h.http.get(`/api/v1/attempts/${attempt.id}/result`).set(headers);
    expect(result.body).toMatchObject({ status: 'graded', scorePercent: 100 });
  });
});

describe('outbox relay', () => {
  it('publishes attempt events to the assessment stream', async () => {
    const a = await quiz('Relay');
    const { attempt, headers } = await start('tyler', a.id);
    await h.http.post(`/api/v1/attempts/${attempt.id}/submit`).set(headers).expect(200);
    const types = await waitFor(
      async () => {
        const entries = await h.redis.xrange(h.ns.stream(streamFor('assessment-service')), '-', '+');
        const mine = entries
          .map(([, fields]) => JSON.parse(fields[fields.indexOf('envelope') + 1]!) as { type: string; subject: { id: string } | null; producer: string })
          .filter((e) => e.subject?.id === attempt.id);
        return mine.length >= 3 ? mine : null;
      },
      { timeoutMs: 15_000, intervalMs: 200, message: 'the relay to publish the attempt events' },
    );
    expect(types.map((e) => e.type)).toEqual(['assessment.attempt.started', 'assessment.attempt.submitted', 'assessment.attempt.graded']);
    expect(types.every((e) => e.producer === 'assessment-service')).toBe(true);
    // The relay stamps published_at right after appending to the stream.
    await waitFor(
      async () => {
        const pending = await h.db.selectFrom('outbox_events').select('id').where('published_at', 'is', null).where('envelope', '@>', { subject: { id: attempt.id } } as never).execute();
        return pending.length === 0;
      },
      { timeoutMs: 10_000, intervalMs: 100, message: 'the relay to mark the events as published' },
    );
  });
});

describe('directory events', () => {
  const publisher = () => new StreamPublisher(h.redis, h.ns);
  const userEvent = (person: keyof typeof PEOPLE, revision: number, patch: Partial<ReturnType<typeof directoryUser>>, id = uuidv7()) =>
    buildEvent(
      identityEvents.directoryUserUpserted,
      { user: { ...directoryUser(person), ...patch }, revision },
      { id, producer: 'identity-service', organizationId: principalDataFor(person).organizationId, actor: { type: 'system', id: null }, subject: { type: 'user', id: PEOPLE[person].id } },
    );
  const publish = (event: ReturnType<typeof userEvent>) => publisher().publish([{ stream: streamFor('identity-service'), envelope: event }]);
  const jobTitle = async (person: keyof typeof PEOPLE) =>
    (await h.db.selectFrom('dir_users').select('job_title').where('id', '=', PEOPLE[person].id).executeTakeFirstOrThrow()).job_title;

  it('updates the projection, ignores stale revisions and applies each event once', async () => {
    const promoted = userEvent('devon', 5, { jobTitle: 'Senior Sales Representative' });
    await publish(promoted);
    await waitFor(async () => (await jobTitle('devon')) === 'Senior Sales Representative', { timeoutMs: 15_000, intervalMs: 100, message: 'the directory update' });

    await publish(userEvent('devon', 3, { jobTitle: 'Outdated Title' }));
    await publish(promoted);
    const marker = userEvent('ethan', 2, { jobTitle: 'Marker' });
    await publish(marker);
    await waitFor(async () => (await jobTitle('ethan')) === 'Marker', { timeoutMs: 15_000, intervalMs: 100, message: 'the marker event' });
    expect(await jobTitle('devon')).toBe('Senior Sales Representative');
    const inbox = await h.db.selectFrom('inbox_events').select('event_id').where('event_id', '=', promoted.id).execute();
    expect(inbox).toHaveLength(1);
  });

  it('moves a learner’s attempts into a different manager’s review scope when their team changes', async () => {
    const a = await quiz('Team change');
    const { attempt, headers } = await start('isaiah', a.id);
    await h.http.post(`/api/v1/attempts/${attempt.id}/submit`).set(headers).expect(200);
    // Danielle's principal is the seeded one: Isaiah is not among her direct reports, so she can
    // only see him through the team membership in the directory projection.
    const dallasManager = await h.as('danielle');
    const visible = async (viewer: Record<string, string>) =>
      (await h.http.get('/api/v1/attempts').query({ assessmentId: a.id }).set(viewer)).body.total as number;
    const luisBefore = await h.as('luis');
    // Isaiah starts on the Fort Worth storm team (managed by Luis).
    expect(await visible(luisBefore)).toBe(1);
    expect(await visible(dallasManager)).toBe(0);

    const dallasA = TEAMS.find((t) => t.name === 'Dallas Residential A')!;
    await publish(userEvent('isaiah', 9, { teamIds: [dallasA.id], displayName: 'Isaiah Grant' }));
    await waitFor(async () => (await visible(dallasManager)) === 1, { timeoutMs: 15_000, intervalMs: 100, message: 'the team change to reach the review scope' });
    // Identity recomputes Luis's principal after the move: Isaiah is no longer his report.
    const luis = principalDataFor('luis');
    const luisAfter = await h.as('luis', { managedUserIds: luis.managedUserIds.filter((id) => id !== PEOPLE.isaiah.id) });
    expect(await visible(luisAfter)).toBe(0);
    expect((await h.http.get(`/api/v1/attempts/${attempt.id}/review`).set(luisAfter)).status).toBe(404);
    expect((await h.http.get(`/api/v1/attempts/${attempt.id}/review`).set(dallasManager)).status).toBe(200);
  });
});
