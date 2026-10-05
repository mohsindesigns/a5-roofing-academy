import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PEOPLE } from '@a5/seed-data';
import { ProviderError, type AIProvider } from '../src/providers/types.js';
import { DevSimulatorProvider } from '../src/providers/simulator/simulator.provider.js';
import { createAiHarness, replyText, sendStreaming, startSession, type AiHarness } from './harness.js';

let h: AiHarness;
let simulator: DevSimulatorProvider;
const realStream = DevSimulatorProvider.prototype.stream;

beforeAll(async () => {
  h = await createAiHarness('sessions');
  simulator = h.app.get(DevSimulatorProvider);
});
afterAll(() => h?.close());
afterEach(() => vi.restoreAllMocks());

const outbox = async (type: string, sessionId?: string) => {
  const rows = await h.db.selectFrom('outbox_events').select(['type', 'envelope']).where('type', '=', type).execute();
  return rows.filter((r) => !sessionId || (r.envelope as { subject?: { id: string } }).subject?.id === sessionId);
};

describe('catalogue and briefing', () => {
  it('lists published scenarios with filters and never exposes the hidden concern', async () => {
    const marcus = await h.as('marcus');
    const all = await h.http.get('/api/v1/ai/practice/scenarios?pageSize=50').set(marcus);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(10);

    const hidden = await h.db.selectFrom('ai_scenarios').select(['hidden_concern', 'ai_instructions']).execute();
    const raw = JSON.stringify(all.body);
    for (const row of hidden) {
      expect(raw).not.toContain(row.hidden_concern.slice(0, 40));
      expect(raw).not.toContain(row.ai_instructions.slice(0, 40));
    }
    expect(raw).not.toMatch(/hiddenConcern|aiInstructions|expectedBehaviors|forbiddenClaims|openingLine/);

    const beginner = await h.http.get('/api/v1/ai/practice/scenarios?difficulty=beginner&pageSize=50').set(marcus);
    expect(beginner.body.items.map((s: { difficulty: string }) => s.difficulty)).toEqual(Array(beginner.body.items.length).fill('beginner'));
    const insurance = await h.http.get('/api/v1/ai/practice/scenarios?category=Insurance').set(marcus);
    expect(insurance.body.items.map((s: { title: string }) => s.title).sort()).toEqual(['Insurance Already Inspected', 'No Insurance Claim']);
    const search = await h.http.get('/api/v1/ai/practice/scenarios?q=spouse').set(marcus);
    expect(search.body.items.map((s: { title: string }) => s.title)).toEqual(['Talk to My Spouse']);
  });

  it('shows my stats and a brief without internals', async () => {
    const marcus = await h.as('marcus');
    const brief = await h.http.get(`/api/v1/ai/practice/scenarios/${h.scenarioId('roof-fine')}`).set(marcus);
    expect(brief.status).toBe(200);
    expect(brief.body).toMatchObject({ title: 'My Roof Looks Fine', difficulty: 'beginner', passingScore: 75 });
    expect(brief.body.myStats).toMatchObject({ attempts: 1, bestScore: 71, passed: false });
    expect(brief.body.repBrief).toMatch(/Garland/);
    expect(brief.body.scoredOn).toHaveLength(14);
    const hidden = await h.db.selectFrom('ai_scenarios').select('hidden_concern').where('id', '=', h.scenarioId('roof-fine')).executeTakeFirstOrThrow();
    expect(JSON.stringify(brief.body)).not.toContain(hidden.hidden_concern.slice(0, 50));
    expect(JSON.stringify(brief.body)).not.toMatch(/weight|guidance/);
  });

  it('requires the practice permission', async () => {
    const noPermission = await h.asCustom(PEOPLE.marcus.id, ['users.view'], 'own');
    expect((await h.http.get('/api/v1/ai/practice/scenarios').set(noPermission)).status).toBe(403);
    expect((await h.http.post('/api/v1/ai/sessions').set(noPermission).send({ scenarioId: h.scenarioId('no-time') })).status).toBe(403);
    expect((await h.http.get('/api/v1/ai/practice/scenarios')).status).toBe(401);
  });
});

describe('session lifecycle with streaming', () => {
  it('runs a conversation end to end: SSE deltas, hidden concern only after discovery, marker stripped', async () => {
    const tyler = await h.as('tyler');
    const started = await startSession(h, tyler, 'no-time');
    expect(started.status).toBe(201);
    const session = started.body;
    expect(session).toMatchObject({ status: 'active', mode: 'practice', isTest: false, turnCount: 0, maxTurns: 10, turnsRemaining: 10, awaitingReply: false });
    expect(session.provider).toEqual({ name: 'dev_simulator', label: 'Development simulator', model: 'a5-dev-simulator-v1', simulated: true });
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toMatchObject({ seq: 1, role: 'homeowner', content: expect.stringContaining("don't have time") });
    expect(session.evaluation).toBeNull();

    // 1. A pitch does not earn the hidden concern.
    const first = await sendStreaming(h, tyler, session.id, { text: "Hi, I'm Tyler with A5 Roofing. Is it okay if I take thirty seconds?" });
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(first.headers['cache-control']).toMatch(/no-cache/);
    expect(first.events.map((e) => e.event)).toEqual(['accepted', ...Array(first.events.length - 2).fill('delta'), 'done']);
    expect(first.events[0]!.data).toMatchObject({ retried: false, repMessage: { seq: 2, role: 'rep' } });
    const firstReply = replyText(first.events);
    expect(firstReply.length).toBeGreaterThan(5);
    expect(firstReply).not.toContain('kitchen table');
    expect(firstReply).not.toContain('[[END');
    const done1 = first.events.at(-1)!.data;
    expect(done1).toMatchObject({ sessionEnded: false, endReason: null, status: 'active', turnCount: 1, turnsRemaining: 9 });
    expect((done1.message as { content: string }).content).toBe(firstReply);

    // 2. A genuine discovery question earns it.
    const second = await sendStreaming(h, tyler, session.id, {
      text: 'Thank you. What have you noticed on your roof or ceilings since the April hailstorm?',
    });
    expect(replyText(second.events)).toContain('kitchen table');

    // 3. Empathy then a specific next step ends the conversation with the marker removed.
    const third = await sendStreaming(h, tyler, session.id, { text: "That makes sense, and I won't do that to you. Could I come by Thursday at 6 p.m. for a fifteen minute exterior inspection?" });
    const reply = replyText(third.events);
    expect(reply).toMatch(/Thursday at 6/i);
    expect(reply).not.toContain('[[');
    expect(third.events.at(-1)!.data).toMatchObject({ sessionEnded: true, endReason: 'objective_reached', status: 'ended', turnCount: 3, turnsRemaining: 0 });

    const stored = (await h.http.get(`/api/v1/ai/sessions/${session.id}`).set(tyler)).body;
    expect(stored).toMatchObject({ status: 'ended', endReason: 'objective_reached', turnCount: 3 });
    expect(stored.messages.map((m: { role: string }) => m.role)).toEqual(['homeowner', 'rep', 'homeowner', 'rep', 'homeowner', 'rep', 'homeowner']);
    expect(stored.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(JSON.stringify(stored.messages)).not.toContain('[[END');

    // Events: started + completed (scoring is asynchronous).
    expect(await outbox('ai.session.started', session.id)).toHaveLength(1);
    const completed = await outbox('ai.session.completed', session.id);
    expect(completed).toHaveLength(1);
    expect((completed[0]!.envelope as { payload: Record<string, unknown> }).payload).toMatchObject({ userId: PEOPLE.tyler.id, endReason: 'objective_reached', turnCount: 3 });
    expect(await outbox('ai.score.generated', session.id)).toHaveLength(0);

    // The conversation is over.
    const late = await h.http.post(`/api/v1/ai/sessions/${session.id}/messages`).set(tyler).send({ text: 'One more thing' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('SESSION_ENDED');
    expect((await h.http.post(`/api/v1/ai/sessions/${session.id}/end`).set(tyler)).status).toBe(409);
  });

  it('returns JSON instead of a stream when the client asks for it', async () => {
    const kayla = await h.as('kayla');
    const { body: session } = await startSession(h, kayla, 'roof-fine');
    const res = await h.http
      .post(`/api/v1/ai/sessions/${session.id}/messages`)
      .set(kayla)
      .set('Accept', 'application/json')
      .send({ text: "Hi, I'm Kayla with A5 Roofing. How has the roof been since the April hailstorm?" });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toMatchObject({
      repMessage: { seq: 2, role: 'rep' },
      reply: { seq: 3, role: 'homeowner' },
      sessionEnded: false,
      status: 'active',
      turnCount: 1,
      error: null,
    });
    expect(res.body.reply.content).toContain('sell the house');
  });

  it('ends with homeowner_ended after repeated pressure and promises, with the marker stripped', async () => {
    const jordan = await h.as('jordan');
    const { body: session } = await startSession(h, jordan, 'no-claim');
    const warning = await sendStreaming(h, jordan, session.id, { text: "Don't worry, insurance will pay for the whole roof." });
    expect(replyText(warning.events)).toMatch(/nobody can promise/i);
    expect(warning.events.at(-1)!.data).toMatchObject({ sessionEnded: false });
    const ended = await sendStreaming(h, jordan, session.id, { text: 'You need to decide today, this price is only good today.' });
    expect(ended.events.at(-1)!.data).toMatchObject({ sessionEnded: true, endReason: 'homeowner_ended', status: 'ended' });
    expect(replyText(ended.events)).not.toContain('[[');
  });

  it('ends at the turn limit', async () => {
    const admin = await h.as('grant');
    const copy = await h.http.post(`/api/v1/ai/scenarios/${h.scenarioId('leave-card')}/duplicate`).set(admin).send({ title: 'Two-turn drill' });
    expect(copy.status).toBe(201);
    await h.http.patch(`/api/v1/ai/scenarios/${copy.body.id}`).set(admin).send({ maxTurns: 2 }).expect(200);
    await h.http.post(`/api/v1/ai/scenarios/${copy.body.id}/publish`).set(admin).expect(200);

    const devon = await h.as('devon');
    const { body: session } = await h.http.post('/api/v1/ai/sessions').set(devon).send({ scenarioId: copy.body.id });
    expect(session).toMatchObject({ maxTurns: 2, turnsRemaining: 2 });
    const one = await sendStreaming(h, devon, session.id, { text: 'Hi, I am Devon with A5 Roofing.' });
    expect(one.events.at(-1)!.data).toMatchObject({ sessionEnded: false, turnsRemaining: 1 });
    const two = await sendStreaming(h, devon, session.id, { text: 'Could you tell me what you have noticed on the roof?' });
    expect(two.events.at(-1)!.data).toMatchObject({ sessionEnded: true, endReason: 'max_turns', status: 'ended', turnsRemaining: 0 });
    expect((await h.http.post(`/api/v1/ai/sessions/${session.id}/messages`).set(devon).send({ text: 'More?' })).status).toBe(409);
  });

  it('lets the representative end a session, and abandons empty ones', async () => {
    const isaiah = await h.as('isaiah');
    const { body: spoken } = await startSession(h, isaiah, 'spouse');
    await sendStreaming(h, isaiah, spoken.id, { text: 'Hi, I am Isaiah with A5 Roofing.' });
    const ended = await h.http.post(`/api/v1/ai/sessions/${spoken.id}/end`).set(isaiah);
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ status: 'ended', endReason: 'rep_ended', turnCount: 1 });
    expect(ended.body.endedAt).toBeTruthy();
    expect(await outbox('ai.session.completed', spoken.id)).toHaveLength(1);

    const { body: empty } = await startSession(h, isaiah, 'spouse');
    const abandoned = await h.http.post(`/api/v1/ai/sessions/${empty.id}/end`).set(isaiah);
    expect(abandoned.body).toMatchObject({ status: 'abandoned', endReason: 'rep_ended', turnCount: 0 });
    expect(await outbox('ai.session.completed', empty.id)).toHaveLength(0);
  });

  it('validates messages', async () => {
    const colton = await h.as('colton');
    const { body: session } = await startSession(h, colton, 'spouse');
    const url = `/api/v1/ai/sessions/${session.id}/messages`;
    expect((await h.http.post(url).set(colton).send({})).status).toBe(400);
    expect((await h.http.post(url).set(colton).send({ text: '   ' })).status).toBe(400);
    expect((await h.http.post(url).set(colton).send({ text: 'x'.repeat(2001) })).status).toBe(400);
    const nothingToRetry = await h.http.post(url).set(colton).send({ retry: true });
    expect(nothingToRetry.status).toBe(409);
    expect(nothingToRetry.body.error.code).toBe('NOTHING_TO_RETRY');
    const voice = await h.http.post(url).set(colton).send({ audioRef: 'uploads/clip.webm' });
    expect(voice.status).toBe(422);
    expect(voice.body.error.code).toBe('VOICE_NOT_AVAILABLE');
    expect((await startSession(h, colton, 'spouse', { modality: 'voice' })).status).toBe(422);
    expect((await h.http.post('/api/v1/ai/sessions').set(colton).send({ scenarioId: 'nope' })).status).toBe(400);
    expect((await h.http.post('/api/v1/ai/sessions').set(colton).send({ scenarioId: '0190a3b2-0000-7000-8000-000000000999' })).status).toBe(404);
  });
});

describe('robustness', () => {
  function failing(error: ProviderError, times = Infinity): AIProvider['stream'] {
    let calls = 0;
    return (messages, options) => {
      if (calls++ < times) {
        return (async function* () {
          yield* [] as never[];
          throw error;
        })();
      }
      return realStream.call(simulator, messages, options);
    };
  }

  it('persists the rep message when the provider fails, shows the helpful error, and recovers on retry', async () => {
    const sofia = await h.as('sofia');
    const { body: session } = await startSession(h, sofia, 'no-time');
    const spy = vi.spyOn(simulator, 'stream').mockImplementation(failing(new ProviderError('dev_simulator', 'server', 'boom', 503)));

    const failed = await sendStreaming(h, sofia, session.id, { text: "Hi, I'm Sofia with A5 Roofing. Is it okay if I take thirty seconds?", clientMessageId: '0190a3b2-0000-7000-8000-0000000c0001' });
    expect(failed.status).toBe(200);
    expect(failed.events.map((e) => e.event)).toEqual(['accepted', 'error']);
    expect(failed.events[1]!.data).toEqual({
      code: 'AI_PROVIDER_SERVER',
      message: 'The homeowner simulator is unavailable. Your conversation is saved — retry.',
      retryable: true,
    });
    expect(spy).toHaveBeenCalledTimes(3); // initial attempt + 2 retries with backoff

    const stored = (await h.http.get(`/api/v1/ai/sessions/${session.id}`).set(sofia)).body;
    expect(stored.status).toBe('active');
    expect(stored.awaitingReply).toBe(true);
    expect(stored.messages.map((m: { role: string }) => m.role)).toEqual(['homeowner', 'rep']);
    expect(stored.messages[1].content).toContain("I'm Sofia");

    const failedUsage = await h.db.selectFrom('ai_usage').select(['success', 'error_code']).where('session_id', '=', session.id).execute();
    expect(failedUsage).toEqual(Array(3).fill({ success: false, error_code: 'AI_PROVIDER_SERVER' }));

    // Retrying answers the same message without duplicating it.
    spy.mockRestore();
    const retried = await sendStreaming(h, sofia, session.id, { retry: true });
    expect(retried.events[0]).toMatchObject({ event: 'accepted', data: { retried: true, repMessage: { seq: 2 } } });
    expect(retried.events.at(-1)!.event).toBe('done');
    const after = (await h.http.get(`/api/v1/ai/sessions/${session.id}`).set(sofia)).body;
    expect(after.messages.map((m: { role: string }) => m.role)).toEqual(['homeowner', 'rep', 'homeowner']);
    expect(after.awaitingReply).toBe(false);
    expect(after.turnCount).toBe(1);
  });

  it('resending a client message id answers it instead of duplicating it', async () => {
    const naomi = await h.as('naomi');
    const { body: session } = await startSession(h, naomi, 'no-time');
    const id = '0190a3b2-0000-7000-8000-0000000c0002';
    vi.spyOn(simulator, 'stream').mockImplementation(failing(new ProviderError('dev_simulator', 'auth', 'bad key', 401)));
    const failed = await sendStreaming(h, naomi, session.id, { text: 'Hi, I am Naomi with A5 Roofing.', clientMessageId: id });
    expect(failed.events.at(-1)!.data).toMatchObject({
      code: 'AI_PROVIDER_AUTH',
      retryable: false,
      message: expect.stringContaining('Your conversation is saved'),
    });
    vi.restoreAllMocks();
    const again = await sendStreaming(h, naomi, session.id, { text: 'Hi, I am Naomi with A5 Roofing.', clientMessageId: id });
    expect(again.events[0]!.data).toMatchObject({ retried: true });
    expect(again.events.at(-1)!.event).toBe('done');
    const reps = await h.db.selectFrom('ai_messages').select('id').where('session_id', '=', session.id).where('role', '=', 'rep').execute();
    expect(reps).toHaveLength(1);
    // Once answered, the id cannot be replayed.
    const replay = await h.http.post(`/api/v1/ai/sessions/${session.id}/messages`).set(naomi).send({ text: 'Hi, I am Naomi with A5 Roofing.', clientMessageId: id });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('MESSAGE_ALREADY_SENT');
  });

  it('hides transient failures behind backoff retries', async () => {
    const ethan = await h.as('ethan');
    const { body: session } = await startSession(h, ethan, 'no-time');
    const spy = vi.spyOn(simulator, 'stream').mockImplementation(failing(new ProviderError('dev_simulator', 'rate_limited', 'slow down', 429), 1));
    const res = await sendStreaming(h, ethan, session.id, { text: 'Hi, I am Ethan with A5 Roofing.' });
    expect(res.events.map((e) => e.event)).toContain('done');
    expect(res.events.map((e) => e.event)).not.toContain('error');
    expect(spy).toHaveBeenCalledTimes(2);
    const usage = await h.db.selectFrom('ai_usage').select(['success']).where('session_id', '=', session.id).orderBy('created_at').execute();
    expect(usage.map((u) => u.success)).toEqual([false, true]);
  });

  it('refuses a second message while one is being answered', async () => {
    const darius = await h.as('darius');
    const { body: session } = await startSession(h, darius, 'no-time');
    vi.spyOn(simulator, 'stream').mockImplementation((messages, options) =>
      (async function* () {
        await new Promise((r) => setTimeout(r, 400));
        yield* realStream.call(simulator, messages, options);
      })(),
    );
    const slow = sendStreaming(h, darius, session.id, { text: 'Hi, I am Darius with A5 Roofing.' });
    await new Promise((r) => setTimeout(r, 120));
    const blocked = await h.http.post(`/api/v1/ai/sessions/${session.id}/messages`).set(darius).send({ text: 'Are you there?' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('TURN_IN_PROGRESS');
    expect((await slow).events.at(-1)!.event).toBe('done');
    const reps = await h.db.selectFrom('ai_messages').select('id').where('session_id', '=', session.id).where('role', '=', 'rep').execute();
    expect(reps).toHaveLength(1);
  });
});

describe('limits and lesson grants', () => {
  it('enforces the daily session limit from AI settings', async () => {
    const admin = await h.as('grant');
    const saved = await h.http.put('/api/v1/ai/settings').set(admin).send({ maxSessionsPerLearnerPerDay: 2 });
    expect(saved.status).toBe(200);
    expect(saved.body.maxSessionsPerLearnerPerDay).toBe(2);

    const caleb = await h.as('caleb');
    expect((await startSession(h, caleb, 'leave-card')).status).toBe(201);
    expect((await startSession(h, caleb, 'leave-card')).status).toBe(201);
    const third = await startSession(h, caleb, 'leave-card');
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('DAILY_SESSION_LIMIT');
    expect(third.body.error.message).toMatch(/limit of 2 practice sessions/);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);

    // Other learners and admin test runs are unaffected.
    expect((await startSession(h, await h.as('brianna'), 'leave-card')).status).toBe(201);
    const test = await h.http.post(`/api/v1/ai/scenarios/${h.scenarioId('leave-card')}/test-sessions`).set(admin);
    expect(test.status).toBe(201);

    // Raising the limit takes effect immediately.
    await h.http.put('/api/v1/ai/settings').set(admin).send({ maxSessionsPerLearnerPerDay: 3 }).expect(200);
    expect((await startSession(h, caleb, 'leave-card')).status).toBe(201);
    await h.http.put('/api/v1/ai/settings').set(admin).send({ maxSessionsPerLearnerPerDay: 20 }).expect(200);
  });

  it('starts an assigned session from a valid lesson grant', async () => {
    const jasmine = await h.as('jasmine');
    const grant = await h.grant('jasmine', 'spouse');
    const res = await startSession(h, jasmine, 'spouse', { lessonGrant: grant });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      mode: 'assigned',
      context: { programId: '0190a3b2-0000-7000-8000-00000000aa01', enrollmentId: '0190a3b2-0000-7000-8000-00000000aa02', lessonId: '0190a3b2-0000-7000-8000-00000000aa03' },
    });
    const started = await outbox('ai.session.started', res.body.id);
    expect((started[0]!.envelope as { payload: Record<string, unknown> }).payload).toMatchObject({ mode: 'assigned', context: { lessonId: '0190a3b2-0000-7000-8000-00000000aa03' } });
  });

  it('rejects grants for another scenario, learner, resource type or secret', async () => {
    const marcus = await h.as('marcus');
    const wrongScenario = await startSession(h, marcus, 'spouse', { lessonGrant: await h.grant('marcus', 'cheaper') });
    expect(wrongScenario.status).toBe(403);
    expect(wrongScenario.body.error.code).toBe('GRANT_MISMATCH');

    const otherLearner = await startSession(h, marcus, 'spouse', { lessonGrant: await h.grant('tyler', 'spouse') });
    expect(otherLearner.status).toBe(403);
    expect(otherLearner.body.error.code).toBe('GRANT_MISMATCH');

    const media = await startSession(h, marcus, 'spouse', { lessonGrant: await h.grant('marcus', 'spouse', { resourceType: 'media' }) });
    expect(media.body.error.code).toBe('GRANT_MISMATCH');

    const forged = await startSession(h, marcus, 'spouse', { lessonGrant: await h.grant('marcus', 'spouse', { secret: 'x'.repeat(40) }) });
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe('GRANT_INVALID');

    const garbage = await startSession(h, marcus, 'spouse', { lessonGrant: 'not-a-token-at-all-but-long-enough' });
    expect(garbage.body.error.code).toBe('GRANT_INVALID');
    const none = await h.db.selectFrom('ai_sessions').select('id').where('user_id', '=', PEOPLE.marcus.id).where('started_at', '>', new Date(Date.now() - 60_000)).execute();
    expect(none).toHaveLength(0);
  });
});

describe('privacy and history', () => {
  it("keeps other learners' sessions private", async () => {
    const naomiSession = await h.db
      .selectFrom('ai_sessions')
      .select('id')
      .where('user_id', '=', PEOPLE.naomi.id)
      .limit(1)
      .executeTakeFirstOrThrow();
    const marcus = await h.as('marcus');
    expect((await h.http.get(`/api/v1/ai/sessions/${naomiSession.id}`).set(marcus)).status).toBe(404);
    expect((await h.http.post(`/api/v1/ai/sessions/${naomiSession.id}/messages`).set(marcus).send({ text: 'hi' })).status).toBe(404);
    expect((await h.http.post(`/api/v1/ai/sessions/${naomiSession.id}/end`).set(marcus)).status).toBe(404);
    expect((await h.http.get('/api/v1/ai/review/sessions').set(marcus)).status).toBe(403);
    expect((await h.http.get(`/api/v1/ai/review/sessions/${naomiSession.id}`).set(marcus)).status).toBe(403);
  });

  it('lists my history newest first with scores', async () => {
    const naomi = await h.as('naomi');
    const res = await h.http.get('/api/v1/ai/me/sessions').set(naomi);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(4);
    const seeded = res.body.items.filter((s: { overallScore: number | null }) => s.overallScore !== null);
    expect(seeded.map((s: { scenario: { title: string }; overallScore: number }) => [s.scenario.title, s.overallScore])).toEqual([
      ['Three Estimates', 77],
      ['Talk to My Spouse', 81],
      ['Talk to My Spouse', 72],
      ['The Busy Homeowner', 80],
    ]);
    expect(seeded[2]).toMatchObject({ passed: false, mode: 'assigned', provider: { label: 'Development simulator' } });
    const filtered = await h.http.get(`/api/v1/ai/me/sessions?scenarioId=${h.scenarioId('spouse')}`).set(naomi);
    expect(filtered.body.items).toHaveLength(2);
  });

  it('records token usage and estimated cost for every call', async () => {
    const rows = await h.db.selectFrom('ai_usage').selectAll().where('purpose', '=', 'conversation').where('success', '=', true).where('created_at', '>', new Date(Date.now() - 600_000)).execute();
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) {
      expect(row).toMatchObject({ provider: 'dev_simulator', model: 'a5-dev-simulator-v1', organization_id: expect.any(String), priced: true });
      expect(row.input_tokens).toBeGreaterThan(0);
      expect(row.output_tokens).toBeGreaterThan(0);
    }
    const admin = await h.as('grant');
    const report = await h.http.get('/api/v1/ai/usage?from=2024-01-01').set(admin);
    expect(report.status).toBe(200);
    expect(report.body.totals.calls).toBeGreaterThan(100);
    expect(report.body.byModel).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'dev_simulator', model: 'a5-dev-simulator-v1' })]));
    expect(report.body.byPurpose.map((p: { purpose: string }) => p.purpose)).toEqual(['conversation', 'evaluation']);
    expect(report.body.byDay.length).toBeGreaterThan(1);
    expect((await h.http.get('/api/v1/ai/usage').set(await h.as('marcus'))).status).toBe(403);
    expect((await h.http.get('/api/v1/ai/usage').set(await h.as('danielle'))).status).toBe(403);
  });
});
