import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@a5/database';
import { aiEvents, assessmentEvents, learningEvents } from '@a5/events';
import { ASSESSMENTS, CERTIFICATION, PEOPLE, PHASES, PROGRAM, SCENARIOS, allLessons, seedId, type PersonKey } from '@a5/seed-data';
import { createCertHarness, type CertHarness } from './harness.js';

let h: CertHarness;

beforeAll(async () => {
  h = await createCertHarness('eligibility');
});
afterAll(() => h?.close());

const context = { programId: PROGRAM.id };
const assessment = (key: string) => ASSESSMENTS.find((a) => a.key === key)!;

function graded(person: PersonKey, key: string, score: number, opts: { attempt?: number; at?: Date } = {}) {
  const a = assessment(key);
  return {
    attemptId: seedId(`t:attempt:${person}:${key}:${opts.attempt ?? 1}`),
    assessmentId: a.id,
    assessmentTitle: a.title,
    kind: a.kind,
    userId: PEOPLE[person].id,
    attemptNumber: opts.attempt ?? 1,
    scorePercent: score,
    passed: score >= a.passingPercent,
    passingPercent: a.passingPercent,
    gradedAt: (opts.at ?? new Date()).toISOString(),
    overridden: false,
    context,
    questionResults: [],
  };
}

function aiScore(person: PersonKey, scenarioKey: string, score: number, n: number, at = new Date()) {
  const s = SCENARIOS.find((x) => x.key === scenarioKey)!;
  return {
    sessionId: seedId(`t:ai:${person}:${n}`),
    scenarioId: s.id,
    scenarioTitle: s.title,
    scenarioCategory: s.category,
    difficulty: s.difficulty,
    userId: PEOPLE[person].id,
    overallScore: score,
    passed: score >= s.passingScore,
    passingScore: s.passingScore,
    categoryScores: [],
    context,
    evaluatedAt: at.toISOString(),
    promptVersionId: seedId('t:prompt'),
    rubricVersionId: seedId('t:rubric'),
  };
}

const completed = (person: PersonKey, at = new Date()) => ({
  enrollmentId: seedId(`enrollment:${person}`),
  programId: PROGRAM.id,
  userId: PEOPLE[person].id,
  programTitle: PROGRAM.title,
  completedAt: at.toISOString(),
});

async function outboxOf(type: string, person: PersonKey) {
  return h.db
    .selectFrom('outbox_events')
    .select(['id', 'envelope'])
    .where('type', '=', type)
    .where(sql<boolean>`envelope->'payload'->>'userId' = ${PEOPLE[person].id}`)
    .execute();
}

async function candidateOf(person: PersonKey) {
  return h.db.selectFrom('certification_candidates').selectAll().where('user_id', '=', PEOPLE[person].id).where('definition_id', '=', CERTIFICATION.id).executeTakeFirstOrThrow();
}

const certificatesOf = (person: PersonKey) =>
  h.db.selectFrom('issued_certificates').selectAll().where('user_id', '=', PEOPLE[person].id).where('definition_id', '=', CERTIFICATION.id).execute();

/** Deliver every fact a representative needs, in a deliberately shuffled order. */
async function completeEverything(person: PersonKey) {
  await h.deliver(aiEvents.scoreGenerated, aiScore(person, 'cheaper', 88, 5));
  await h.deliver(assessmentEvents.attemptGraded, graded(person, 'final', 92));
  for (const [i, s] of ['no-time', 'spouse', 'three-estimates', 'no-claim'].entries()) await h.deliver(aiEvents.scoreGenerated, aiScore(person, s, 84 + i, i + 1));
  await h.deliver(assessmentEvents.attemptGraded, graded(person, 'quiz-w3', 90));
  await h.deliver(assessmentEvents.attemptGraded, graded(person, 'quiz-w1', 85));
  await h.deliver(assessmentEvents.attemptGraded, graded(person, 'quiz-w2', 88));
  await h.deliver(learningEvents.programCompleted, completed(person));
}

describe('eligibility from projected events', () => {
  it('moves a learner through requirements, approval and automatic issuance exactly once', async () => {
    const kayla = 'kayla';
    expect((await candidateOf(kayla)).status).toBe('in_progress');

    // Not eligible: neither the API nor the engine may issue.
    const early = await h.http.post('/api/v1/certificates').set(await h.as('grant')).send({ definitionId: CERTIFICATION.id, userId: PEOPLE.kayla.id });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('NOT_ELIGIBLE');
    expect(await certificatesOf(kayla)).toHaveLength(0);

    // Re-delivering the program catalogue is harmless (version guard) and a newer version is applied.
    const lessons = allLessons();
    const publish = (version: number) => ({
      programId: PROGRAM.id,
      title: PROGRAM.title,
      version,
      phases: PHASES.map((p, i) => ({ phaseId: p.id, title: p.title, position: i + 1 })),
      requiredLessonIds: lessons.filter((l) => l.required).map((l) => l.id),
      assessments: ASSESSMENTS.map((a) => ({ assessmentId: a.id, lessonId: lessons.find((l) => l.key === a.lessonKey)!.id, kind: a.kind, required: true, title: a.title })),
      aiScenarios: [],
    });
    await h.deliver(learningEvents.programPublished, publish(2));
    await h.deliver(learningEvents.programPublished, publish(1));
    expect((await h.db.selectFrom('program_catalog').select('version').where('program_id', '=', PROGRAM.id).executeTakeFirstOrThrow()).version).toBe(2);

    await h.deliver(learningEvents.enrollmentProgressed, {
      enrollmentId: seedId('enrollment:kayla'),
      programId: PROGRAM.id,
      userId: PEOPLE.kayla.id,
      progressPercent: 60,
      requiredCompleted: 18,
      requiredTotal: 30,
      currentPhaseId: null,
    });

    // Duplicates of the very same event (same id) are processed once.
    const finalAttempt = await h.deliver(assessmentEvents.attemptGraded, graded(kayla, 'final', 92));
    await h.consumer.dispatch(finalAttempt);
    await h.consumer.dispatch(finalAttempt);
    expect(await h.db.selectFrom('inbox_events').select('event_id').where('event_id', '=', finalAttempt.id).execute()).toHaveLength(1);

    await completeEverything(kayla);
    // Out-of-order: an older progress event must not undo completion.
    await h.deliver(
      learningEvents.enrollmentProgressed,
      { enrollmentId: seedId('enrollment:kayla'), programId: PROGRAM.id, userId: PEOPLE.kayla.id, progressPercent: 40, requiredCompleted: 12, requiredTotal: 30, currentPhaseId: null },
      { occurredAt: new Date(Date.now() - 86_400_000) },
    );

    let candidate = await candidateOf(kayla);
    expect(candidate).toMatchObject({ status: 'pending_approval', met_count: 5, total_count: 6, auto_requirements_met: true });
    const pending = candidate.requirements.filter((r) => !r.satisfied);
    expect(pending.map((r) => r.description)).toEqual(['Manager approval']);

    // Replaying everything again (new event ids, same facts) does not duplicate approvals or events.
    await completeEverything(kayla);
    expect(await outboxOf('certificate.eligible', kayla)).toHaveLength(1);
    expect(await outboxOf('certificate.approval_requested', kayla)).toHaveLength(1);
    const approvals = await h.db.selectFrom('certificate_approvals').selectAll().where('user_id', '=', PEOPLE.kayla.id).execute();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ status: 'pending', kind: 'manager', cycle: 1 });
    expect(await certificatesOf(kayla)).toHaveLength(0);

    // Even an administrator cannot issue while the approval is outstanding, unless they override with a reason.
    const blocked = await h.http.post('/api/v1/certificates').set(await h.as('grant')).send({ definitionId: CERTIFICATION.id, userId: PEOPLE.kayla.id });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toContain('Manager approval');

    // The manager sees the request with the breakdown and approves it.
    const danielle = await h.as('danielle');
    const queue = await h.http.get('/api/v1/certificates/approvals').set(danielle);
    const mine = queue.body.items.find((a: { user: { id: string } }) => a.user.id === PEOPLE.kayla.id);
    expect(mine).toMatchObject({ status: 'pending', progress: { metCount: 5, totalCount: 6 } });
    const decision = await h.http.post(`/api/v1/certificates/approvals/${mine.id}/decision`).set(danielle).send({ decision: 'approved', comment: 'Ready for the field.' });
    expect(decision.status).toBe(200);
    expect(decision.body).toMatchObject({ status: 'approved', decidedBy: { displayName: 'Danielle Okafor' }, comment: 'Ready for the field.' });
    expect(decision.body.certificateId).not.toBeNull();

    const certs = await certificatesOf(kayla);
    expect(certs).toHaveLength(1);
    expect(certs[0]).toMatchObject({ status: 'issued', mode: 'approval', pdf_status: 'pending' });
    candidate = await candidateOf(kayla);
    expect(candidate).toMatchObject({ status: 'issued', certificate_id: certs[0]!.id, met_count: 6, total_count: 6 });
    expect(certs[0]!.certificate_number).toMatch(/^A5-SALES-\d{4}-\d{6}$/);
    expect(certs[0]!.verification_token.length).toBeGreaterThanOrEqual(43);

    // Events: decision, issuance and audit entries share the same outbox.
    expect(await outboxOf('certificate.approval_decided', kayla)).toHaveLength(1);
    expect(await outboxOf('certificate.issued', kayla)).toHaveLength(1);
    const audits = await h.db.selectFrom('outbox_events').select('envelope').where('type', '=', 'audit.recorded').execute();
    const actions = audits.map((a) => (a.envelope as { payload: { action: string } }).payload.action);
    expect(actions).toEqual(expect.arrayContaining(['certificate_approval.approved', 'certificate.issued']));

    // Deciding twice, and re-running the evaluation, never creates another certificate.
    const again = await h.http.post(`/api/v1/certificates/approvals/${mine.id}/decision`).set(danielle).send({ decision: 'approved' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_DECIDED');
    await h.eligibility.evaluate(CERTIFICATION.id, PEOPLE.kayla.id);
    await completeEverything(kayla);
    expect(await certificatesOf(kayla)).toHaveLength(1);
  });

  it('withdraws an approval request when scores regress and re-requests it when they recover', async () => {
    const jordan = 'jordan';
    const t0 = new Date(Date.now() - 3_600_000);
    await completeEverything(jordan);
    expect((await candidateOf(jordan)).status).toBe('pending_approval');

    // A score override re-grades the final below the threshold.
    await h.deliver(assessmentEvents.attemptGraded, { ...graded(jordan, 'final', 70), gradedAt: new Date(t0.getTime() + 7_200_000).toISOString(), overridden: true });
    expect((await candidateOf(jordan)).status).toBe('in_progress');
    expect((await h.db.selectFrom('certificate_approvals').select('status').where('user_id', '=', PEOPLE.jordan.id).executeTakeFirstOrThrow()).status).toBe('cancelled');

    await h.deliver(assessmentEvents.attemptGraded, { ...graded(jordan, 'final', 90, { attempt: 2 }), gradedAt: new Date().toISOString() });
    expect((await candidateOf(jordan)).status).toBe('pending_approval');
    const approvals = await h.db.selectFrom('certificate_approvals').select(['status', 'cycle']).where('user_id', '=', PEOPLE.jordan.id).execute();
    expect(approvals).toEqual([{ status: 'pending', cycle: 1 }]);
    expect(await outboxOf('certificate.approval_requested', jordan)).toHaveLength(2);
    // The eligible event is emitted once per cycle, not on every recovery.
    expect(await outboxOf('certificate.eligible', jordan)).toHaveLength(1);
  });

  it('rejects with a required comment, reopens a new cycle on new activity and blocks self-approval', async () => {
    const jordan = await candidateOf('jordan');
    const approval = await h.db.selectFrom('certificate_approvals').selectAll().where('candidate_id', '=', jordan.id).executeTakeFirstOrThrow();
    const danielle = await h.as('danielle');

    const noComment = await h.http.post(`/api/v1/certificates/approvals/${approval.id}/decision`).set(danielle).send({ decision: 'rejected' });
    expect(noComment.status).toBe(400);

    const selfHeaders = await h.principal({
      userId: PEOPLE.jordan.id,
      displayName: 'Jordan Whitfield',
      permissions: { 'certificate_approvals.decide': 'organization', 'certificates.view_own': 'own' },
    });
    expect((await h.http.post(`/api/v1/certificates/approvals/${approval.id}/decision`).set(selfHeaders).send({ decision: 'approved' })).status).toBe(403);

    const outsider = await h.as('luis');
    expect((await h.http.post(`/api/v1/certificates/approvals/${approval.id}/decision`).set(outsider).send({ decision: 'approved' })).status).toBe(404);

    const rejected = await h.http
      .post(`/api/v1/certificates/approvals/${approval.id}/decision`)
      .set(danielle)
      .send({ decision: 'rejected', comment: 'Needs another ride-along before sign-off.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');
    expect((await candidateOf('jordan')).status).toBe('rejected');
    expect(await certificatesOf('jordan')).toHaveLength(0);

    // Re-evaluating without new activity keeps the rejection.
    await h.eligibility.evaluate(CERTIFICATION.id, PEOPLE.jordan.id);
    expect((await candidateOf('jordan')).status).toBe('rejected');

    // New learning activity starts cycle 2 with a fresh approval request.
    await h.deliver(aiEvents.scoreGenerated, aiScore('jordan', 'leave-card', 91, 9));
    const reopened = await candidateOf('jordan');
    expect(reopened).toMatchObject({ status: 'pending_approval', cycle: 2 });
    const approvals = await h.db.selectFrom('certificate_approvals').select(['status', 'cycle']).where('user_id', '=', PEOPLE.jordan.id).orderBy('cycle').execute();
    expect(approvals).toEqual([
      { status: 'rejected', cycle: 1 },
      { status: 'pending', cycle: 2 },
    ]);
    expect(await outboxOf('certificate.eligible', 'jordan')).toHaveLength(2);
  });

  it('serves the requirement breakdown behind “6 / 8 requirements complete”', async () => {
    const res = await h.http.get(`/api/v1/certifications/${CERTIFICATION.id}/progress?userId=${PEOPLE.naomi.id}`).set(await h.as('luis'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'in_progress', totalCount: 6 });
    const byType = Object.fromEntries(res.body.requirements.map((r: { type: string }) => [r.type, r]));
    expect(byType.program_assessments_score).toMatchObject({ satisfied: true, progress: { current: 3, target: 3, unit: 'count' } });
    expect(byType.ai_sessions_count).toMatchObject({ satisfied: false, progress: { current: 4, target: 5 } });
    expect(byType.assessment_score).toMatchObject({ satisfied: false, progress: { current: 0, target: 85 } });
    expect(byType.approval.description).toBe('Manager approval');
    expect(res.body.metCount).toBe(res.body.requirements.filter((r: { satisfied: boolean }) => r.satisfied).length);
  });

  it('describes requirements in plain language on the definition', async () => {
    const res = await h.http.get(`/api/v1/certifications/${CERTIFICATION.id}`).set(await h.as('shelby'));
    expect(res.status).toBe(200);
    expect(res.body.requirements.map((r: { description: string }) => r.description)).toEqual([
      'Complete A5 New Hire Sales Academy',
      'Score 80% or higher on every required quizzes in A5 New Hire Sales Academy',
      'Score 85% or higher on "Final Sales Readiness Assessment"',
      'Complete 5 AI role-plays',
      'Average 80 or higher across AI role-plays',
      'Manager approval',
    ]);
    expect(res.body.numberPreview).toMatch(/^A5-SALES-\d{4}-0000\d\d$/);
    expect(res.body.signatories.map((s: { name: string }) => s.name)).toEqual(['Priya Raman', 'Shelby Hartman']);
  });
});
