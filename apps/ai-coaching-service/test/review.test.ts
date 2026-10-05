import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEAMS, PEOPLE } from '@a5/seed-data';
import { createAiHarness, type AiHarness } from './harness.js';

let h: AiHarness;

beforeAll(async () => {
  h = await createAiHarness('review');
});
afterAll(() => h?.close());

const sessionOf = async (person: keyof typeof PEOPLE, scenarioKey: string, index = 0) => {
  const rows = await h.db
    .selectFrom('ai_sessions')
    .select('id')
    .where('user_id', '=', PEOPLE[person].id)
    .where('scenario_id', '=', h.scenarioId(scenarioKey))
    .orderBy('started_at')
    .execute();
  return rows[index]!.id;
};

const learners = (body: { items: Array<{ learner: { displayName: string } }> }) =>
  [...new Set(body.items.map((i) => i.learner.displayName))].sort();

describe('data scope', () => {
  it('shows a trainer only the sessions of assigned trainees', async () => {
    // Hector coaches Naomi, Isaiah, Ethan, Devon and Caleb. Of those, Naomi (4) and Caleb (1) have practiced.
    const res = await h.http
      .get('/api/v1/ai/review/sessions?pageSize=100')
      .set(await h.as('hector'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(learners(res.body)).toEqual(['Caleb Ramirez', 'Naomi Fischer']);
    expect(res.body.items[0]).toMatchObject({
      reviewCount: 0,
      lastReviewedAt: null,
      provider: { label: 'Development simulator' },
    });

    // Shelby coaches a different group plus has organization-wide scope as a training administrator.
    const shelby = await h.http
      .get('/api/v1/ai/review/sessions?pageSize=100')
      .set(await h.as('shelby'));
    expect(shelby.body.total).toBe(28);
  });

  it("limits a manager to their team's members", async () => {
    const res = await h.http
      .get('/api/v1/ai/review/sessions?pageSize=100')
      .set(await h.as('danielle'));
    // Dallas Residential A: Marcus (1), Ashlyn (5); the manager has no sessions of their own.
    expect(learners(res.body)).toEqual(['Ashlyn Pierce', 'Marcus Delgado']);
    expect(res.body.total).toBe(6);
    const andre = await h.http
      .get('/api/v1/ai/review/sessions?pageSize=100')
      .set(await h.as('andre'));
    // Dallas Residential B: Brianna (5) and Caleb (1).
    expect(learners(andre.body)).toEqual(['Brianna Castillo', 'Caleb Ramirez']);
    const teamFilter = await h.http
      .get(`/api/v1/ai/review/sessions?teamId=${TEAMS[0].id}&pageSize=100`)
      .set(await h.as('shelby'));
    expect(learners(teamFilter.body)).toEqual(['Ashlyn Pierce', 'Marcus Delgado']);
  });

  it('answers 404 for sessions outside the caller scope, and 403 without the permission', async () => {
    const marcusSession = await sessionOf('marcus', 'roof-fine');
    const naomiSession = await sessionOf('naomi', 'no-time');
    const hector = await h.as('hector');
    expect(
      (await h.http.get(`/api/v1/ai/review/sessions/${marcusSession}`).set(hector)).status,
    ).toBe(404);
    expect(
      (
        await h.http
          .post(`/api/v1/ai/review/sessions/${marcusSession}/reviews`)
          .set(hector)
          .send({ comment: 'Nice try', recommendation: 'ready' })
      ).status,
    ).toBe(404);
    expect(
      (await h.http.get(`/api/v1/ai/review/sessions/${naomiSession}`).set(hector)).status,
    ).toBe(200);

    const rep = await h.as('naomi');
    expect((await h.http.get('/api/v1/ai/review/sessions').set(rep)).status).toBe(403);
    expect((await h.http.get(`/api/v1/ai/review/sessions/${naomiSession}`).set(rep)).status).toBe(
      403,
    );
    // Out-of-scope filters cannot be used to peek.
    const peek = await h.http
      .get(`/api/v1/ai/review/sessions?userId=${PEOPLE.marcus.id}`)
      .set(hector);
    expect(peek.body.total).toBe(0);
    expect(
      (
        await h.http
          .get('/api/v1/ai/review/sessions')
          .set(await h.asCustom(PEOPLE.hector.id, ['ai_sessions.view'], 'own'))
      ).body.total,
    ).toBe(0);
  });

  it('never crosses organizations', async () => {
    const stranger = await h.http.get('/api/v1/ai/review/sessions').set(
      await (async () => {
        const { principalHeaders } = await import('@a5/nest-kit/testing');
        return principalHeaders({
          userId: PEOPLE.priya.id,
          organizationId: '0190a3b2-0000-7000-8000-0000000000ff',
          permissions: ['ai_sessions.view'],
          scope: 'platform',
        });
      })(),
    );
    expect(stranger.body.total).toBe(0);
  });
});

describe('listing and detail', () => {
  it('filters by learner, scenario, score range and date', async () => {
    const shelby = await h.as('shelby');
    const get = async (query: string) =>
      (await h.http.get(`/api/v1/ai/review/sessions?pageSize=100&${query}`).set(shelby)).body;

    const byUser = await get(`userId=${PEOPLE.naomi.id}`);
    expect(byUser.total).toBe(4);
    const byScenario = await get(`scenarioId=${h.scenarioId('cheaper')}`);
    expect(byScenario.total).toBe(4);
    expect(
      byScenario.items.every(
        (s: { scenario: { title: string } }) => s.scenario.title === 'Another Roofer Is Cheaper',
      ),
    ).toBe(true);
    const low = await get('maxScore=75');
    expect(low.items.map((s: { overallScore: number }) => s.overallScore).sort()).toEqual([71, 72]);
    const high = await get('minScore=90');
    expect(high.items.map((s: { overallScore: number }) => s.overallScore).sort()).toEqual([
      90, 91,
    ]);
    const band = await get('minScore=84&maxScore=86');
    expect(
      band.items.every(
        (s: { overallScore: number }) => s.overallScore >= 84 && s.overallScore <= 86,
      ),
    ).toBe(true);

    // SEED_NOW is 2026-10-05; Marcus practiced 5 days earlier, Caleb 3 and Jasmine 2.
    const recent = await get('from=2026-09-29');
    expect(learners(recent)).toEqual(['Caleb Ramirez', 'Jasmine Reyes', 'Marcus Delgado']);
    const window = await get('from=2026-09-01&to=2026-09-25');
    expect(
      window.items.every(
        (s: { startedAt: string }) => s.startedAt >= '2026-09-01' && s.startedAt < '2026-09-26',
      ),
    ).toBe(true);
    const search = await get('q=Ashlyn');
    expect(search.total).toBe(5);
    expect((await get('reviewed=false')).total).toBe(28);
    expect((await get('reviewed=true')).total).toBe(0);
    expect((await h.http.get('/api/v1/ai/review/sessions?minScore=abc').set(shelby)).status).toBe(
      400,
    );
  });

  it('returns the transcript and scorecard of a session in scope', async () => {
    const id = await sessionOf('naomi', 'spouse', 0);
    const res = await h.http.get(`/api/v1/ai/review/sessions/${id}`).set(await h.as('hector'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      learner: { id: PEOPLE.naomi.id, displayName: 'Naomi Fischer' },
      status: 'evaluated',
      mode: 'assigned',
      evaluation: { overallScore: 72, passed: false, passingScore: 75 },
      reviews: [],
    });
    expect(res.body.messages.length).toBeGreaterThanOrEqual(9);
    expect(res.body.evaluation.riskyStatements[0].quote).toContain('insurance will pay');
    expect(res.body.evaluation.categoryScores).toHaveLength(14);
  });
});

describe('coaching reviews', () => {
  it('lets a trainer in scope review a session, emits ai.session.reviewed and shows it to the learner', async () => {
    const id = await sessionOf('naomi', 'spouse', 0);
    const hector = await h.as('hector');
    const res = await h.http.post(`/api/v1/ai/review/sessions/${id}/reviews`).set(hector).send({
      comment:
        'Your recovery after the insurance comment was good, but never make that promise. Practice again before the field ride-along.',
      recommendation: 'practice_again',
    });
    expect(res.status).toBe(201);
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.reviews[0]).toMatchObject({
      reviewer: { id: PEOPLE.hector.id, displayName: 'Hector Villanueva' },
      recommendation: 'practice_again',
    });

    const events = (
      await h.db
        .selectFrom('outbox_events')
        .select('envelope')
        .where('type', '=', 'ai.session.reviewed')
        .execute()
    ).map((e) => e.envelope as { payload: Record<string, unknown>; subject: { id: string } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      subject: { id },
      payload: {
        sessionId: id,
        scenarioTitle: 'Talk to My Spouse',
        userId: PEOPLE.naomi.id,
        reviewerId: PEOPLE.hector.id,
      },
    });

    // The learner sees the feedback on their own session; the list shows review counts.
    const own = await h.http.get(`/api/v1/ai/sessions/${id}`).set(await h.as('naomi'));
    expect(own.body.reviews).toHaveLength(1);
    const list = await h.http
      .get(`/api/v1/ai/review/sessions?userId=${PEOPLE.naomi.id}&reviewed=true`)
      .set(hector);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id, reviewCount: 1 });

    // Reviews are append-only history.
    await expect(
      h.db.updateTable('ai_session_reviews').set({ comment: 'edited' }).execute(),
    ).rejects.toThrow(/immutable/);
    await h.http
      .post(`/api/v1/ai/review/sessions/${id}/reviews`)
      .set(await h.as('shelby'))
      .send({
        comment: 'Agree. Schedule a role-play with me this week.',
        recommendation: 'retrain',
      })
      .expect(201);
    const detail = await h.http.get(`/api/v1/ai/review/sessions/${id}`).set(hector);
    expect(detail.body.reviews.map((r: { recommendation: string }) => r.recommendation)).toEqual([
      'practice_again',
      'retrain',
    ]);
  });

  it('validates reviews and requires the review permission', async () => {
    const id = await sessionOf('caleb', 'no-time');
    const hector = await h.as('hector');
    const url = `/api/v1/ai/review/sessions/${id}/reviews`;
    expect(
      (await h.http.post(url).set(hector).send({ comment: '', recommendation: 'ready' })).status,
    ).toBe(400);
    expect(
      (await h.http.post(url).set(hector).send({ comment: 'Fine', recommendation: 'promote' }))
        .status,
    ).toBe(400);
    // Auditors can view sessions but not review them.
    const ruth = await h.as('ruth');
    expect((await h.http.get(`/api/v1/ai/review/sessions/${id}`).set(ruth)).status).toBe(200);
    expect(
      (await h.http.post(url).set(ruth).send({ comment: 'Looks fine', recommendation: 'ready' }))
        .status,
    ).toBe(403);
    // A manager outside the learner's team cannot review.
    expect(
      (
        await h.http
          .post(url)
          .set(await h.as('danielle'))
          .send({ comment: 'Not mine', recommendation: 'ready' })
      ).status,
    ).toBe(404);
  });
});
