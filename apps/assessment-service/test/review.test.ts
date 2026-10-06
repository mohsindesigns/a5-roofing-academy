import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { assessment } from '@a5/contracts';
import { PEOPLE } from '@a5/seed-data';
import {
  answerAttempt,
  createAssessment,
  createAssessmentHarness,
  createBank,
  createQuestion,
  definitionOf,
  sampleQuestions,
  type AssessmentHarness,
  type Author,
} from './harness.js';

let h: AssessmentHarness;
let author: Author;
let written: assessment.AssessmentDetail;
const ids: Record<string, string> = {};
const defs: Record<string, assessment.QuestionDefinition> = {};

beforeAll(async () => {
  h = await createAssessmentHarness('review');
  author = { http: h.http, headers: await h.as('shelby') };
  const bank = await createBank(author, 'Review tests');
  const samples = {
    mc: sampleQuestions.multipleChoice('mc'),
    essay: sampleQuestions.longAnswer('essay'),
    open: sampleQuestions.scenarioOpen('open'),
  };
  for (const [label, body] of Object.entries(samples)) {
    ids[label] = (await createQuestion(author, bank.id, body)).id;
    defs[label] = definitionOf(body);
  }
  written = await createAssessment(author, {
    title: 'Written responses',
    config: { passingPercent: 70, maxAttempts: 10, revealCorrectAnswers: 'after_submit' },
    items: [
      { kind: 'question', questionId: ids.mc },
      { kind: 'question', questionId: ids.essay },
      { kind: 'question', questionId: ids.open },
    ],
  });
});
afterAll(() => h?.close());

async function outbox(type: string, attemptId: string) {
  const rows = await h.db
    .selectFrom('outbox_events')
    .select('envelope')
    .where('type', '=', type)
    .orderBy('created_at')
    .execute();
  return rows
    .map(
      (r) =>
        r.envelope as {
          payload: Record<string, unknown>;
          subject: { id: string } | null;
          actor: { id: string | null };
        },
    )
    .filter((e) => e.subject?.id === attemptId);
}

/** A learner answers every question and submits; the written answers wait for a trainer. */
async function submitWritten(person: keyof typeof PEOPLE, assessmentId = written.id) {
  const headers = await h.as(person);
  const started = await h.http.post('/api/v1/attempts').set(headers).send({ assessmentId });
  expect(started.status).toBe(201);
  await answerAttempt(h, headers, started.body, defs);
  const submitted = await h.http.post(`/api/v1/attempts/${started.body.id}/submit`).set(headers);
  expect(submitted.status).toBe(200);
  return {
    id: started.body.id as string,
    headers,
    result: submitted.body as assessment.AttemptResult,
    attempt: started.body as assessment.LearnerAttempt,
  };
}

async function review(attemptId: string, viewer: keyof typeof PEOPLE = 'priya') {
  return h.http.get(`/api/v1/attempts/${attemptId}/review`).set(await h.as(viewer));
}

function openQuestions(detail: assessment.ReviewAttemptDetail) {
  return detail.questions.filter((q) => q.needsReview);
}

describe('open answers go to review', () => {
  it('holds the attempt in pending_review and tells the learner what happens next', async () => {
    const a = await submitWritten('kayla');
    expect(a.result.status).toBe('pending_review');
    expect(a.result.scoreVisible).toBe(false);
    expect(a.result.scorePercent).toBeNull();
    expect(a.result.passed).toBeNull();
    expect(a.result.message).toMatch(/trainer will review your written answers/);
    const byLabel = Object.fromEntries(a.result.questions.map((q) => [q.prompt.split(':')[0]!, q]));
    expect(byLabel.mc).toMatchObject({ outcome: 'correct' });
    expect(byLabel.essay).toMatchObject({ outcome: 'pending_review', awardedPoints: null });
    expect(byLabel.open).toMatchObject({ outcome: 'pending_review' });

    const [submitted] = await outbox('assessment.attempt.submitted', a.id);
    expect(submitted!.payload.needsReview).toBe(true);
    expect(await outbox('assessment.attempt.graded', a.id)).toHaveLength(0);
    // Automatic grading of the multiple choice question is already stored.
    const detail = (await review(a.id)).body as assessment.ReviewAttemptDetail;
    expect(detail).toMatchObject({
      status: 'pending_review',
      pendingReviewCount: 2,
      scorePercent: null,
      maxPoints: 7,
    });
    expect(detail.questions.find((q) => q.prompt.startsWith('mc'))).toMatchObject({
      isCorrect: true,
      awardedPoints: 1,
      needsReview: false,
    });
  });

  it('shows reviewers the answer, the rubric and the question version the learner saw', async () => {
    const a = await submitWritten('marcus');
    const detail = (await review(a.id)).body as assessment.ReviewAttemptDetail;
    const essay = detail.questions.find((q) => q.prompt.startsWith('essay'))!;
    expect(essay.response).toMatchObject({ type: 'long_answer' });
    expect(essay.definition).toMatchObject({
      type: 'long_answer',
      config: { rubric: expect.stringContaining('ACV') },
    });
    expect(essay).toMatchObject({ version: 1, points: 4, needsReview: true, gradedAt: null });
    expect(detail.learner).toEqual({ id: PEOPLE.marcus.id, displayName: 'Marcus Delgado' });
    expect(detail.config).toMatchObject({
      title: 'Written responses',
      passingPercent: 70,
      kind: 'quiz',
    });
  });
});

describe('grading open answers', () => {
  it('refuses to let a reviewer grade or override their own attempt', async () => {
    const a = await submitWritten('shelby');
    const detail = (await review(a.id, 'priya')).body as assessment.ReviewAttemptDetail;
    const [essay] = openQuestions(detail);
    const own = await h.as('shelby');
    const grade = await h.http
      .post(`/api/v1/attempts/${a.id}/grades`)
      .set(own)
      .send({ grades: [{ attemptQuestionId: essay!.attemptQuestionId, awardedPoints: 4 }] });
    expect(grade.status).toBe(403);
    const override = await h.http
      .post(`/api/v1/attempts/${a.id}/override`)
      .set(own)
      .send({ scorePercent: 100, reason: 'Giving myself full marks' });
    expect(override.status).toBe(403);
  });

  it('finishes the attempt once every written answer is graded and publishes attempt.graded', async () => {
    const a = await submitWritten('tyler');
    const detail = (await review(a.id, 'shelby')).body as assessment.ReviewAttemptDetail;
    const [essay, open] = openQuestions(detail);
    const trainer = await h.as('shelby');

    // Grade one answer: the attempt stays open for review.
    const partial = await h.http
      .post(`/api/v1/attempts/${a.id}/grades`)
      .set(trainer)
      .send({
        grades: [
          {
            attemptQuestionId: essay!.attemptQuestionId,
            awardedPoints: 4,
            feedback: 'Clear and accurate.',
          },
        ],
      });
    expect(partial.status).toBe(200);
    expect(partial.body).toMatchObject({
      status: 'pending_review',
      pendingReviewCount: 1,
      scorePercent: null,
    });
    expect(await outbox('assessment.attempt.graded', a.id)).toHaveLength(0);

    const done = await h.http
      .post(`/api/v1/attempts/${a.id}/grades`)
      .set(trainer)
      .send({
        grades: [
          {
            attemptQuestionId: open!.attemptQuestionId,
            awardedPoints: 1,
            feedback: 'Good tone; offer a specific time.',
          },
        ],
      });
    expect(done.status).toBe(200);
    const graded = done.body as assessment.ReviewAttemptDetail;
    // 1 (mc) + 4 + 1 = 6 of 7 points
    expect(graded).toMatchObject({
      status: 'graded',
      scorePercent: 85.71,
      passed: true,
      overridden: false,
      pendingReviewCount: 0,
      gradedScorePercent: 85.71,
    });
    const gradedEssay = graded.questions.find((q) => q.prompt.startsWith('essay'))!;
    expect(gradedEssay).toMatchObject({
      awardedPoints: 4,
      isCorrect: true,
      feedback: 'Clear and accurate.',
      gradedBy: { id: PEOPLE.shelby.id, displayName: 'Shelby Hartman' },
    });
    expect(graded.questions.find((q) => q.prompt.startsWith('open'))).toMatchObject({
      awardedPoints: 1,
      isCorrect: false,
    });

    const events = await outbox('assessment.attempt.graded', a.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      scorePercent: 85.71,
      passed: true,
      overridden: false,
      attemptNumber: 1,
      userId: PEOPLE.tyler.id,
    });
    expect(events[0]!.payload.questionResults).toHaveLength(3);
    expect(events[0]!.actor.id).toBe(PEOPLE.shelby.id);

    // The learner now sees the result with the trainer's feedback.
    const result = (await h.http.get(`/api/v1/attempts/${a.id}/result`).set(a.headers))
      .body as assessment.AttemptResult;
    expect(result).toMatchObject({ status: 'graded', scorePercent: 85.71, passed: true });
    expect(result.questions.find((q) => q.prompt.startsWith('essay'))).toMatchObject({
      outcome: 'correct',
      feedback: 'Clear and accurate.',
    });

    const audits = (
      await h.db
        .selectFrom('outbox_events')
        .select('envelope')
        .where('type', '=', 'audit.recorded')
        .execute()
    ).map(
      (r) =>
        r.envelope as { payload: { action: string; resourceId: string; actorDisplay: string } },
    );
    const forAttempt = audits
      .filter((x) => x.payload.resourceId === a.id)
      .map((x) => x.payload.action);
    expect(forAttempt).toEqual(
      expect.arrayContaining([
        'assessment.attempt.answers_graded',
        'assessment.attempt.review_completed',
      ]),
    );
  });

  it('can grade both answers in one request', async () => {
    const a = await submitWritten('jordan');
    const detail = (await review(a.id)).body as assessment.ReviewAttemptDetail;
    const grades = openQuestions(detail).map((q) => ({
      attemptQuestionId: q.attemptQuestionId,
      awardedPoints: 0,
      feedback: null,
    }));
    const res = await h.http
      .post(`/api/v1/attempts/${a.id}/grades`)
      .set(await h.as('priya'))
      .send({ grades });
    expect(res.body).toMatchObject({ status: 'graded', scorePercent: 14.29, passed: false });
    const [graded] = await outbox('assessment.attempt.graded', a.id);
    expect(graded!.payload).toMatchObject({
      passed: false,
      notifyManagerIds: [PEOPLE.danielle.id],
    });
  });

  it('validates grades', async () => {
    const a = await submitWritten('isaiah');
    const detail = (await review(a.id)).body as assessment.ReviewAttemptDetail;
    const [essay] = openQuestions(detail);
    const mc = detail.questions.find((q) => q.prompt.startsWith('mc'))!;
    const trainer = await h.as('shelby');
    const tooMany = await h.http
      .post(`/api/v1/attempts/${a.id}/grades`)
      .set(trainer)
      .send({ grades: [{ attemptQuestionId: essay!.attemptQuestionId, awardedPoints: 5 }] });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.fields[0].message).toMatch(/at most 4 points/);
    const auto = await h.http
      .post(`/api/v1/attempts/${a.id}/grades`)
      .set(trainer)
      .send({ grades: [{ attemptQuestionId: mc.attemptQuestionId, awardedPoints: 1 }] });
    expect(auto.status).toBe(400);
    expect(auto.body.error.fields[0].message).toMatch(/graded automatically/);
    const unknown = await h.http
      .post(`/api/v1/attempts/${a.id}/grades`)
      .set(trainer)
      .send({
        grades: [{ attemptQuestionId: '0190a3b2-0000-7000-8000-0000000000dd', awardedPoints: 1 }],
      });
    expect(unknown.status).toBe(400);
    const duplicate = await h.http
      .post(`/api/v1/attempts/${a.id}/grades`)
      .set(trainer)
      .send({
        grades: [
          { attemptQuestionId: essay!.attemptQuestionId, awardedPoints: 1 },
          { attemptQuestionId: essay!.attemptQuestionId, awardedPoints: 2 },
        ],
      });
    expect(duplicate.status).toBe(400);
    const empty = await h.http
      .post(`/api/v1/attempts/${a.id}/grades`)
      .set(trainer)
      .send({ grades: [] });
    expect(empty.status).toBe(400);
    // Nothing was stored by the rejected requests.
    expect(((await review(a.id)).body as assessment.ReviewAttemptDetail).pendingReviewCount).toBe(
      2,
    );
  });

  it('cannot grade attempts that are not submitted or are already graded', async () => {
    const headers = await h.as('colton');
    const started = await h.http
      .post('/api/v1/attempts')
      .set(headers)
      .send({ assessmentId: written.id });
    const open = await h.http
      .post(`/api/v1/attempts/${started.body.id}/grades`)
      .set(await h.as('priya'))
      .send({ grades: [{ attemptQuestionId: started.body.questions[1].id, awardedPoints: 1 }] });
    expect(open.status).toBe(409);
    expect(open.body.error.code).toBe('ATTEMPT_NOT_SUBMITTED');

    const a = await submitWritten('devon');
    const detail = (await review(a.id)).body as assessment.ReviewAttemptDetail;
    const grades = openQuestions(detail).map((q) => ({
      attemptQuestionId: q.attemptQuestionId,
      awardedPoints: 2,
    }));
    await h.http
      .post(`/api/v1/attempts/${a.id}/grades`)
      .set(await h.as('priya'))
      .send({ grades })
      .expect(200);
    const again = await h.http
      .post(`/api/v1/attempts/${a.id}/grades`)
      .set(await h.as('priya'))
      .send({ grades });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ATTEMPT_ALREADY_GRADED');
  });
});

describe('score overrides', () => {
  async function gradedAttempt(person: keyof typeof PEOPLE, points = 0) {
    const a = await submitWritten(person);
    const detail = (await review(a.id)).body as assessment.ReviewAttemptDetail;
    const grades = openQuestions(detail).map((q) => ({
      attemptQuestionId: q.attemptQuestionId,
      awardedPoints: points,
    }));
    await h.http
      .post(`/api/v1/attempts/${a.id}/grades`)
      .set(await h.as('priya'))
      .send({ grades })
      .expect(200);
    return a;
  }

  it('records the override, leaves the original grading untouched and emits graded with overridden=true', async () => {
    const a = await gradedAttempt('ethan');
    const before = await h.db
      .selectFrom('attempts')
      .select(['score_points', 'score_percent', 'passed', 'graded_at'])
      .where('id', '=', a.id)
      .executeTakeFirstOrThrow();
    expect(before).toMatchObject({ score_percent: 14.29, passed: false });

    const res = await h.http
      .post(`/api/v1/attempts/${a.id}/override`)
      .set(await h.as('grant'))
      .send({
        scorePercent: 90,
        reason: 'Trainer re-read the written answers after the learner appealed.',
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      scorePercent: 90,
      passed: true,
      overridden: true,
      gradedScorePercent: 14.29,
      gradedPassed: false,
    });
    expect(res.body.overrides).toHaveLength(1);
    expect(res.body.overrides[0]).toMatchObject({
      previousScorePercent: 14.29,
      previousPassed: false,
      newScorePercent: 90,
      newPassed: true,
      reason: 'Trainer re-read the written answers after the learner appealed.',
      actor: { id: PEOPLE.grant.id, displayName: 'Grant Holloway' },
    });

    // The graded attempt row is unchanged; the override is a separate record.
    const after = await h.db
      .selectFrom('attempts')
      .select(['score_points', 'score_percent', 'passed', 'graded_at'])
      .where('id', '=', a.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
    expect(
      await h.db
        .selectFrom('score_overrides')
        .select('id')
        .where('attempt_id', '=', a.id)
        .execute(),
    ).toHaveLength(1);

    const events = await outbox('assessment.attempt.graded', a.id);
    expect(events).toHaveLength(2);
    expect(events[0]!.payload.overridden).toBe(false);
    expect(events[1]!.payload).toMatchObject({
      overridden: true,
      scorePercent: 90,
      passed: true,
      userId: PEOPLE.ethan.id,
    });
    expect(events[1]!.actor.id).toBe(PEOPLE.grant.id);

    const audit = (
      await h.db
        .selectFrom('outbox_events')
        .select('envelope')
        .where('type', '=', 'audit.recorded')
        .execute()
    )
      .map((r) => r.envelope as { payload: Record<string, unknown> })
      .find(
        (e) => e.payload.action === 'assessment.score.overridden' && e.payload.resourceId === a.id,
      );
    expect(audit!.payload).toMatchObject({
      resourceType: 'assessment_attempt',
      actorDisplay: 'Grant Holloway',
      before: { scorePercent: 14.29, passed: false },
      after: { scorePercent: 90, passed: true },
      reason: 'Trainer re-read the written answers after the learner appealed.',
    });

    // The learner and the review list see the effective result.
    const result = (await h.http.get(`/api/v1/attempts/${a.id}/result`).set(a.headers))
      .body as assessment.AttemptResult;
    expect(result).toMatchObject({ scorePercent: 90, passed: true, overridden: true });
    const list = (
      await h.http
        .get('/api/v1/attempts')
        .query({ userId: PEOPLE.ethan.id })
        .set(await h.as('priya'))
    ).body;
    expect(list.items.find((i: { id: string }) => i.id === a.id)).toMatchObject({
      scorePercent: 90,
      passed: true,
      overridden: true,
    });
  });

  it('uses the latest override as the effective score and chains previous values', async () => {
    const a = await gradedAttempt('darius');
    const admin = await h.as('priya');
    await h.http
      .post(`/api/v1/attempts/${a.id}/override`)
      .set(admin)
      .send({ scorePercent: 75, reason: 'First correction after calibration.' })
      .expect(200);
    const second = await h.http
      .post(`/api/v1/attempts/${a.id}/override`)
      .set(admin)
      .send({ scorePercent: 60, passed: false, reason: 'Second correction: policy breach noted.' });
    expect(second.body).toMatchObject({ scorePercent: 60, passed: false, overridden: true });
    expect(
      second.body.overrides.map((o: { newScorePercent: number }) => o.newScorePercent),
    ).toEqual([60, 75]);
    expect(second.body.overrides[0]).toMatchObject({
      previousScorePercent: 75,
      previousPassed: true,
      newPassed: false,
    });
    expect(second.body.gradedScorePercent).toBe(14.29);
    const [, , latest] = await outbox('assessment.attempt.graded', a.id);
    expect(latest!.payload).toMatchObject({ overridden: true, scorePercent: 60, passed: false });
  });

  it('requires the override permission, a graded attempt, a real change and a reason', async () => {
    const a = await gradedAttempt('caleb');
    const body = { scorePercent: 88, reason: 'Appeal upheld by the training manager.' };
    // Trainers can grade but not override.
    expect(
      (
        await h.http
          .post(`/api/v1/attempts/${a.id}/override`)
          .set(await h.as('hector'))
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (
        await h.http
          .post(`/api/v1/attempts/${a.id}/override`)
          .set(await h.as('danielle'))
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (await h.http.post(`/api/v1/attempts/${a.id}/override`).set(a.headers).send(body)).status,
    ).toBe(403);

    const admin = await h.as('priya');
    const short = await h.http
      .post(`/api/v1/attempts/${a.id}/override`)
      .set(admin)
      .send({ scorePercent: 88, reason: 'ok' });
    expect(short.status).toBe(400);
    expect(short.body.error.fields[0].message).toMatch(/at least 10 characters/);
    expect(
      (
        await h.http
          .post(`/api/v1/attempts/${a.id}/override`)
          .set(admin)
          .send({ scorePercent: 101, reason: 'Out of range value here.' })
      ).status,
    ).toBe(400);

    const same = await h.http
      .post(`/api/v1/attempts/${a.id}/override`)
      .set(admin)
      .send({ scorePercent: 14.29, reason: 'Same as before, no change.' });
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe('OVERRIDE_UNCHANGED');

    const pending = await submitWritten('kayla');
    const early = await h.http
      .post(`/api/v1/attempts/${pending.id}/override`)
      .set(admin)
      .send(body);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('ATTEMPT_NOT_GRADED');
    expect(
      await h.db
        .selectFrom('score_overrides')
        .select('id')
        .where('attempt_id', 'in', [a.id, pending.id])
        .execute(),
    ).toHaveLength(0);
  });

  it('scope applies to overrides: unknown attempts are 404', async () => {
    const res = await h.http
      .post('/api/v1/attempts/0190a3b2-0000-7000-8000-0000000000ee/override')
      .set(await h.as('priya'))
      .send({ scorePercent: 50, reason: 'Does not exist at all.' });
    expect(res.status).toBe(404);
  });
});

describe('data scope', () => {
  const people = ['kayla', 'marcus', 'naomi', 'caleb', 'jasmine'] as const;
  const attempts: Record<string, string> = {};
  let scoped: assessment.AssessmentDetail;

  beforeAll(async () => {
    scoped = await createAssessment(author, {
      title: 'Scope check',
      config: { maxAttempts: 10 },
      items: [
        { kind: 'question', questionId: ids.mc },
        { kind: 'question', questionId: ids.essay },
      ],
    });
    for (const person of people) attempts[person] = (await submitWritten(person, scoped.id)).id;
  });

  const listFor = async (viewer: keyof typeof PEOPLE, query: Record<string, string> = {}) => {
    const res = await h.http
      .get('/api/v1/attempts')
      .query({ assessmentId: scoped.id, pageSize: '100', ...query })
      .set(await h.as(viewer));
    expect(res.status).toBe(200);
    return (res.body.items as Array<{ learner: { id: string }; id: string }>)
      .map((i) => i.learner.id)
      .sort();
  };
  const ids_ = (names: Array<keyof typeof PEOPLE>) => names.map((n) => PEOPLE[n].id).sort();

  it('managers see only attempts of people on the teams they manage', async () => {
    expect(await listFor('danielle')).toEqual(ids_(['kayla', 'marcus']));
    expect(await listFor('luis')).toEqual(ids_(['naomi']));
    expect(await listFor('andre')).toEqual(ids_(['caleb']));
    expect(await listFor('meilin')).toEqual(ids_(['jasmine']));
  });

  it('trainers see their assigned trainees across teams', async () => {
    expect(await listFor('hector')).toEqual(ids_(['naomi', 'caleb']));
    expect(await listFor('shelby')).toEqual(ids_([...people]));
  });

  it('administrators and auditors see the whole organization', async () => {
    expect(await listFor('priya')).toEqual(ids_([...people]));
    expect(await listFor('ruth')).toEqual(ids_([...people]));
  });

  it('answers 404 for attempts outside the reviewer’s scope, without disclosing them', async () => {
    const outside = await h.http
      .get(`/api/v1/attempts/${attempts.naomi}/review`)
      .set(await h.as('danielle'));
    expect(outside.status).toBe(404);
    expect(outside.body.error.code).toBe('NOT_FOUND');
    const unknown = await h.http
      .get('/api/v1/attempts/0190a3b2-0000-7000-8000-0000000000ff/review')
      .set(await h.as('danielle'));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.message).toBe(outside.body.error.message);
    expect(
      (await h.http.get(`/api/v1/attempts/${attempts.kayla}/review`).set(await h.as('danielle')))
        .status,
    ).toBe(200);
    expect(
      (await h.http.get(`/api/v1/attempts/${attempts.kayla}/review`).set(await h.as('hector')))
        .status,
    ).toBe(404);
    expect(
      (await h.http.get(`/api/v1/attempts/${attempts.naomi}/review`).set(await h.as('hector')))
        .status,
    ).toBe(200);
  });

  it('filters cannot widen the scope', async () => {
    expect(await listFor('danielle', { userId: PEOPLE.naomi.id })).toEqual([]);
    expect(await listFor('danielle', { q: 'Naomi' })).toEqual([]);
    expect(await listFor('danielle', { q: 'Kayla' })).toEqual(ids_(['kayla']));
  });

  it('grading is limited to the trainer’s scope and the grade permission', async () => {
    const detail = (await review(attempts.naomi!, 'priya')).body as assessment.ReviewAttemptDetail;
    const grades = openQuestions(detail).map((q) => ({
      attemptQuestionId: q.attemptQuestionId,
      awardedPoints: 2,
    }));
    // Managers can view but not grade.
    expect(
      (
        await h.http
          .post(`/api/v1/attempts/${attempts.naomi}/grades`)
          .set(await h.as('luis'))
          .send({ grades })
      ).status,
    ).toBe(403);
    // Hector is not Kayla’s trainer.
    const kaylaDetail = (await review(attempts.kayla!, 'priya'))
      .body as assessment.ReviewAttemptDetail;
    const kaylaGrades = openQuestions(kaylaDetail).map((q) => ({
      attemptQuestionId: q.attemptQuestionId,
      awardedPoints: 2,
    }));
    expect(
      (
        await h.http
          .post(`/api/v1/attempts/${attempts.kayla}/grades`)
          .set(await h.as('hector'))
          .send({ grades: kaylaGrades })
      ).status,
    ).toBe(404);
    // Hector is Naomi’s trainer.
    expect(
      (
        await h.http
          .post(`/api/v1/attempts/${attempts.naomi}/grades`)
          .set(await h.as('hector'))
          .send({ grades })
      ).status,
    ).toBe(200);
  });

  it('learners cannot use the review APIs', async () => {
    const rep = await h.as('kayla');
    expect((await h.http.get('/api/v1/attempts').set(rep)).status).toBe(403);
    expect((await h.http.get(`/api/v1/attempts/${attempts.kayla}/review`).set(rep)).status).toBe(
      403,
    );
    expect(
      (await h.http.post(`/api/v1/attempts/${attempts.kayla}/grades`).set(rep).send({ grades: [] }))
        .status,
    ).toBe(403);
  });
});

describe('review list filters', () => {
  it('filters by status, pending review, assessment, learner and date and paginates', async () => {
    const pendingOnly = await h.http
      .get('/api/v1/attempts')
      .query({ pendingReview: 'true', assessmentId: written.id, pageSize: '100' })
      .set(await h.as('priya'));
    expect(pendingOnly.status).toBe(200);
    expect(pendingOnly.body.items.length).toBeGreaterThan(0);
    expect(
      pendingOnly.body.items.every(
        (i: { status: string; pendingReviewCount: number }) =>
          i.status === 'pending_review' && i.pendingReviewCount > 0,
      ),
    ).toBe(true);

    const graded = await h.http
      .get('/api/v1/attempts')
      .query({ status: 'graded', assessmentId: written.id, pageSize: '100' })
      .set(await h.as('priya'));
    expect(graded.body.items.every((i: { status: string }) => i.status === 'graded')).toBe(true);

    const none = await h.http
      .get('/api/v1/attempts')
      .query({ submittedTo: '2000-01-01T00:00:00Z', assessmentId: written.id })
      .set(await h.as('priya'));
    expect(none.body.total).toBe(0);

    const page1 = await h.http
      .get('/api/v1/attempts')
      .query({ assessmentId: written.id, pageSize: '2', page: '1', sort: 'learner' })
      .set(await h.as('priya'));
    const page2 = await h.http
      .get('/api/v1/attempts')
      .query({ assessmentId: written.id, pageSize: '2', page: '2', sort: 'learner' })
      .set(await h.as('priya'));
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.total).toBeGreaterThan(2);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
    const names = [...page1.body.items, ...page2.body.items].map(
      (i: { learner: { displayName: string } }) => i.learner.displayName,
    );
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y)));
  });

  it('searches by learner and assessment title', async () => {
    const byLearner = await h.http
      .get('/api/v1/attempts')
      .query({ q: 'Tyler Brennan' })
      .set(await h.as('priya'));
    expect(byLearner.body.items.length).toBeGreaterThan(0);
    expect(
      byLearner.body.items.every(
        (i: { learner: { displayName: string } }) => i.learner.displayName === 'Tyler Brennan',
      ),
    ).toBe(true);
    const byTitle = await h.http
      .get('/api/v1/attempts')
      .query({ q: 'Written responses', pageSize: '100' })
      .set(await h.as('priya'));
    expect(
      byTitle.body.items.every(
        (i: { assessment: { title: string } }) => i.assessment.title === 'Written responses',
      ),
    ).toBe(true);
  });
});
