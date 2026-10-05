import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ai } from '@a5/contracts';
import { aiEvents } from '@a5/events';
import { PEOPLE } from '@a5/seed-data';
import { waitFor } from '@a5/testing';
import { EvaluationService } from '../src/evaluation/evaluation.service.js';
import { evaluationOutputSchema } from '../src/evaluation/output-schema.js';
import { DevSimulatorProvider } from '../src/providers/simulator/simulator.provider.js';
import { ProviderError } from '../src/providers/types.js';
import { createAiHarness, sendStreaming, startSession, type AiHarness } from './harness.js';

let h: AiHarness;
let evaluation: EvaluationService;
let simulator: DevSimulatorProvider;
const realStructured = DevSimulatorProvider.prototype.structured;

beforeAll(async () => {
  h = await createAiHarness('evaluation', { workers: true });
  evaluation = h.app.get(EvaluationService);
  simulator = h.app.get(DevSimulatorProvider);
});
afterAll(() => h?.close());
afterEach(() => vi.restoreAllMocks());

const STRONG_SCRIPT = [
  "Hi, I'm Caleb with A5 Roofing. I can see you're on your way out, so I'll be quick. Is it okay if I take thirty seconds?",
  'Thank you. What have you noticed on your roof or ceilings since the April hailstorm?',
  "That makes sense, and I'm not going to do that to you. It sounds like the stain and the granules are worth a quick look. Other than the time, is there anything else that would keep you from letting someone check?",
  "Understood, there's nothing to sign. The exterior inspection takes about fifteen minutes and I photograph everything so you keep the pictures. Could I come by Thursday at 6 p.m.?",
];

async function converse(person: Parameters<AiHarness['as']>[0], scenario = 'no-time', script = STRONG_SCRIPT) {
  const headers = await h.as(person);
  const { body: session } = await startSession(h, headers, scenario);
  let last;
  for (const text of script) {
    last = await sendStreaming(h, headers, session.id, { text });
    if (last.events.at(-1)?.data.sessionEnded) break;
  }
  return { headers, session, last: last! };
}

const events = async (type: string, sessionId: string) =>
  (await h.db.selectFrom('outbox_events').select('envelope').where('type', '=', type).execute()).filter(
    (r) => (r.envelope as { subject?: { id: string } }).subject?.id === sessionId,
  );

describe('asynchronous evaluation', () => {
  it('scores an ended session through the ai.evaluate worker with a schema-valid, quote-grounded scorecard', async () => {
    const { headers, session, last } = await converse('caleb');
    expect(last.events.at(-1)!.data).toMatchObject({ sessionEnded: true, endReason: 'objective_reached' });

    const scored = await waitFor(
      async () => {
        const res = await h.http.get(`/api/v1/ai/sessions/${session.id}`).set(headers);
        return res.body.status === 'evaluated' ? res.body : null;
      },
      { timeoutMs: 15_000, message: 'session to be evaluated' },
    );
    const card = ai.scorecardSchema.parse(scored.evaluation);
    expect(card.categoryScores.map((c) => c.key)).toEqual([
      'discovery', 'listening', 'rapport', 'empathy', 'communication', 'confidence', 'roofing_knowledge',
      'insurance_knowledge', 'value_presentation', 'objection_isolation', 'objection_handling', 'question_quality',
      'next_step_closing', 'compliance',
    ]);
    expect(card.provider).toEqual({ name: 'dev_simulator', label: 'Development simulator', model: 'a5-dev-simulator-v1', simulated: true });
    expect(card.promptVersionId).toBe(scored.promptVersion.id);

    // The overall score is computed from the rubric weights, not taken from the model.
    const weighted = Math.round(card.categoryScores.reduce((s, c) => s + c.score * c.weight, 0) / card.categoryScores.reduce((s, c) => s + c.weight, 0));
    expect(card.overallScore).toBe(weighted);
    expect(card.passed).toBe(card.overallScore >= card.passingScore);

    // Feedback cites the actual conversation.
    const repLines = scored.messages.filter((m: { role: string }) => m.role === 'rep') as Array<{ seq: number; content: string }>;
    const squash = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
    const cited = [
      ...card.categoryScores.flatMap((c) => c.evidence),
      ...card.strengths.flatMap((s) => s.evidence),
      ...card.missedOpportunities.flatMap((m) => (m.quote ? [{ seq: m.seq!, quote: m.quote }] : [])),
      ...card.riskyStatements,
      ...card.recommendedResponses.flatMap((r) => (r.repSaid ? [{ seq: r.seq!, quote: r.repSaid }] : [])),
    ];
    expect(cited.length).toBeGreaterThan(5);
    for (const e of cited) {
      const line = repLines.find((l) => l.seq === e.seq);
      expect(line, `turn ${e.seq}`).toBeTruthy();
      expect(squash(line!.content)).toContain(squash(e.quote));
    }
    expect(card.strengths.length).toBeGreaterThan(0);
    expect(card.nextGoal).not.toMatch(/great job|keep it up/i);
    expect(card.summary.length).toBeGreaterThan(30);

    // Normalised scores for analytics and a usage row for the evaluation call.
    const rows = await h.db.selectFrom('ai_evaluation_scores').selectAll().where('session_id', '=', session.id).execute();
    expect(rows).toHaveLength(14);
    expect(rows.every((r) => !r.is_test && r.user_id === PEOPLE.caleb.id)).toBe(true);
    const usage = await h.db.selectFrom('ai_usage').selectAll().where('session_id', '=', session.id).where('purpose', '=', 'evaluation').execute();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ success: true, provider: 'dev_simulator', is_test: false });
  });

  it('emits ai.score.generated once with context and category scores, even if the job runs twice', async () => {
    const jasmine = await h.as('jasmine');
    const grant = await h.grant('jasmine', 'no-time');
    const { body: session } = await startSession(h, jasmine, 'no-time', { lessonGrant: grant });
    for (const text of STRONG_SCRIPT) {
      const res = await sendStreaming(h, jasmine, session.id, { text });
      if (res.events.at(-1)?.data.sessionEnded) break;
    }
    await waitFor(async () => (await h.db.selectFrom('ai_sessions').select('status').where('id', '=', session.id).executeTakeFirstOrThrow()).status === 'evaluated', {
      timeoutMs: 15_000,
      message: 'evaluation',
    });

    // Run the job again, concurrently and sequentially: nothing is duplicated.
    const results = await Promise.all([evaluation.evaluate(session.id), evaluation.evaluate(session.id)]);
    expect(results).toEqual(['skipped', 'skipped']);
    await evaluation.enqueue(session.id, { replace: true });
    await new Promise((r) => setTimeout(r, 300));

    const generated = await events('ai.score.generated', session.id);
    expect(generated).toHaveLength(1);
    const envelope = generated[0]!.envelope as { type: string; version: number; payload: Record<string, unknown> };
    const payload = aiEvents.scoreGenerated.payload.parse(envelope.payload);
    expect(payload).toMatchObject({
      sessionId: session.id,
      userId: PEOPLE.jasmine.id,
      scenarioTitle: 'The Busy Homeowner',
      scenarioCategory: 'Brush-off',
      difficulty: 'beginner',
      passingScore: 75,
      context: { programId: '0190a3b2-0000-7000-8000-00000000aa01', lessonId: '0190a3b2-0000-7000-8000-00000000aa03' },
    });
    expect(payload.categoryScores).toHaveLength(14);
    expect(payload.categoryScores[0]).toEqual({ key: 'discovery', label: 'Discovery', score: expect.any(Number) });
    const stored = await h.db.selectFrom('ai_evaluations').select(['overall_score', 'passed']).where('session_id', '=', session.id).execute();
    expect(stored).toHaveLength(1);
    expect(payload.overallScore).toBe(stored[0]!.overall_score);
    expect(payload.passed).toBe(stored[0]!.passed);
  });

  it('evaluates concurrently-started jobs for a fresh session exactly once', async () => {
    const { session } = await converse('isaiah');
    await waitFor(async () => (await h.db.selectFrom('ai_sessions').select('status').where('id', '=', session.id).executeTakeFirstOrThrow()).status === 'evaluated', {
      timeoutMs: 15_000,
      message: 'evaluation',
    });
    const stored = await h.db.selectFrom('ai_evaluations').select('id').where('session_id', '=', session.id).execute();
    expect(stored).toHaveLength(1);
    expect(await events('ai.score.generated', session.id)).toHaveLength(1);
    expect(await events('ai.session.completed', session.id)).toHaveLength(1);
  });

  it('retries transient provider failures with backoff', async () => {
    let calls = 0;
    vi.spyOn(simulator, 'structured').mockImplementation(async (schema, messages, options) => {
      if (calls++ < 2) throw new ProviderError('dev_simulator', 'overloaded', 'busy', 529);
      return realStructured.call(simulator, schema, messages, options);
    });
    const { session } = await converse('colton');
    await waitFor(async () => (await h.db.selectFrom('ai_sessions').select('status').where('id', '=', session.id).executeTakeFirstOrThrow()).status === 'evaluated', {
      timeoutMs: 20_000,
      message: 'evaluation after retries',
    });
    expect(calls).toBe(3);
    const usage = await h.db.selectFrom('ai_usage').select('success').where('session_id', '=', session.id).where('purpose', '=', 'evaluation').orderBy('created_at').execute();
    expect(usage.map((u) => u.success)).toEqual([false, false, true]);
    expect(await events('ai.score.generated', session.id)).toHaveLength(1);
  });

  it('marks the evaluation failed with a helpful message and lets the learner retry it', async () => {
    const spy = vi.spyOn(simulator, 'structured').mockRejectedValue(new ProviderError('dev_simulator', 'auth', 'bad key', 401));
    const { headers, session } = await converse('kayla');
    const failed = await waitFor(
      async () => {
        const res = await h.http.get(`/api/v1/ai/sessions/${session.id}`).set(headers);
        return res.body.status === 'evaluation_failed' ? res.body : null;
      },
      { timeoutMs: 15_000, message: 'evaluation_failed' },
    );
    expect(failed.evaluation).toBeNull();
    expect(failed.evaluationError).toMatch(/rejected its credentials/);
    expect(await events('ai.score.generated', session.id)).toHaveLength(0);

    // Retrying is only allowed for failed evaluations and only for the owner.
    expect((await h.http.post(`/api/v1/ai/sessions/${session.id}/evaluation/retry`).set(await h.as('marcus'))).status).toBe(404);
    spy.mockRestore();
    const retry = await h.http.post(`/api/v1/ai/sessions/${session.id}/evaluation/retry`).set(headers);
    expect(retry.status).toBe(200);
    expect(['ended', 'evaluating', 'evaluated']).toContain(retry.body.status);
    const scored = await waitFor(
      async () => {
        const res = await h.http.get(`/api/v1/ai/sessions/${session.id}`).set(headers);
        return res.body.status === 'evaluated' ? res.body : null;
      },
      { timeoutMs: 15_000, message: 'evaluation after retry' },
    );
    expect(scored.evaluation.overallScore).toBeGreaterThan(0);
    expect(scored.evaluationError).toBeNull();
    expect(await events('ai.score.generated', session.id)).toHaveLength(1);

    const again = await h.http.post(`/api/v1/ai/sessions/${session.id}/evaluation/retry`).set(headers);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('EVALUATION_NOT_FAILED');
  });

  it('scores admin test runs without events or analytics rows', async () => {
    const admin = await h.as('grant');
    const { body: session } = await h.http.post(`/api/v1/ai/scenarios/${h.scenarioId('no-time')}/test-sessions`).set(admin);
    expect(session.isTest).toBe(true);
    for (const text of STRONG_SCRIPT) {
      const res = await sendStreaming(h, admin, session.id, { text });
      if (res.events.at(-1)?.data.sessionEnded) break;
    }
    await h.http.post(`/api/v1/ai/sessions/${session.id}/end`).set(admin);
    await waitFor(async () => (await h.db.selectFrom('ai_sessions').select('status').where('id', '=', session.id).executeTakeFirstOrThrow()).status === 'evaluated', {
      timeoutMs: 15_000,
      message: 'test evaluation',
    }).catch(() => undefined);
    const row = await h.db.selectFrom('ai_sessions').select('status').where('id', '=', session.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('evaluated');
    const scores = await h.db.selectFrom('ai_evaluation_scores').select('is_test').where('session_id', '=', session.id).execute();
    expect(scores.length).toBe(14);
    expect(scores.every((s) => s.is_test)).toBe(true);
    for (const type of ['ai.session.started', 'ai.session.completed', 'ai.score.generated']) {
      expect(await events(type, session.id)).toHaveLength(0);
    }
    const history = await h.http.get('/api/v1/ai/me/sessions').set(admin);
    expect(history.body.items.map((s: { id: string }) => s.id)).not.toContain(session.id);
  });

  it('validates the evaluator output contract', () => {
    expect(evaluationOutputSchema.safeParse({}).success).toBe(false);
    expect(
      evaluationOutputSchema.safeParse({
        categoryScores: [{ key: 'discovery', score: 101, rationale: 'x', evidence: [] }],
        strengths: [], missedOpportunities: [], questionsToAsk: [], riskyStatements: [], recommendedResponses: [], nextGoal: 'g', summary: 's',
      }).success,
    ).toBe(false);
  });
});
