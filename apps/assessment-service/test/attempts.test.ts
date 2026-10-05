import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signLessonGrant } from '@a5/auth';
import type { assessment } from '@a5/contracts';
import { TEST_INTERNAL_SECRET } from '@a5/nest-kit/testing';
import { PEOPLE, PROGRAM, allLessons } from '@a5/seed-data';
import {
  answerAttempt,
  createAssessment,
  createAssessmentHarness,
  createBank,
  createQuestion,
  definitionOf,
  principalDataFor,
  sampleQuestions,
  saveAnswer,
  type AssessmentHarness,
  type Author,
} from './harness.js';

let h: AssessmentHarness;
let author: Author;
let bankId: string;
const ids: Record<string, string> = {};
const defs: Record<string, assessment.QuestionDefinition> = {};
let nextTitle = 0;

const bodies: Record<string, Record<string, unknown> & { type: string; config: unknown }> = {};

beforeAll(async () => {
  h = await createAssessmentHarness('attempts');
  author = { http: h.http, headers: await h.as('shelby') };
  bankId = (await createBank(author, 'Attempt tests')).id;
  const samples: Record<string, Record<string, unknown> & { type: string; config: unknown }> = {
    mc: sampleQuestions.multipleChoice('mc'),
    msAll: sampleQuestions.multipleSelect('msAll', 'all_or_nothing'),
    msPartial: sampleQuestions.multipleSelect('msPartial', 'partial'),
    tf: sampleQuestions.trueFalse('tf'),
    sa: sampleQuestions.shortAnswer('sa'),
    sc: sampleQuestions.scenarioChoice('sc'),
    ord: sampleQuestions.ordering('ord'),
    match: sampleQuestions.matching('match'),
    open: sampleQuestions.scenarioOpen('open'),
    essay: sampleQuestions.longAnswer('essay'),
  };
  for (const [label, body] of Object.entries(samples)) {
    bodies[label] = body;
    ids[label] = (await createQuestion(author, bankId, body)).id;
    defs[label] = definitionOf(body);
  }
});
afterAll(() => h?.close());

async function make(labels: string[], config: Partial<assessment.AssessmentConfig> = {}, kind: assessment.AssessmentKind = 'quiz') {
  return createAssessment(author, {
    title: `Attempt test ${++nextTitle}`,
    kind,
    config,
    items: labels.map((l) => ({ kind: 'question', questionId: ids[l] })),
  });
}

async function start(person: keyof typeof PEOPLE, assessmentId: string, via: 'grant' | 'standalone' = 'standalone') {
  const headers = await h.as(person);
  const body = via === 'grant' ? { grant: await h.grantFor(person, assessmentId) } : { assessmentId };
  const res = await h.http.post('/api/v1/attempts').set(headers).send(body);
  return { res, headers, attempt: res.body as assessment.LearnerAttempt };
}

async function submit(headers: Record<string, string>, attemptId: string) {
  return h.http.post(`/api/v1/attempts/${attemptId}/submit`).set(headers);
}

async function outbox(type: string, attemptId: string) {
  const rows = await h.db.selectFrom('outbox_events').select('envelope').where('type', '=', type).execute();
  return rows.map((r) => r.envelope as { payload: Record<string, unknown>; subject: { id: string } | null; actor: { id: string | null } }).filter((e) => e.subject?.id === attemptId);
}

describe('lesson grants', () => {
  it('starts an attempt from a valid grant and stores the learning context', async () => {
    const a = await make(['mc', 'tf']);
    const { res, attempt } = await start('kayla', a.id, 'grant');
    const lesson = allLessons().find((l) => l.key === 'w1-quiz')!;
    expect(res.status).toBe(201);
    expect(attempt).toMatchObject({
      assessmentId: a.id,
      attemptNumber: 1,
      status: 'in_progress',
      resumed: false,
      questionCount: 2,
      context: { programId: PROGRAM.id, enrollmentId: PEOPLE.kayla.id, lessonId: lesson.id },
    });
    const row = await h.db.selectFrom('attempts').select(['context', 'user_id']).where('id', '=', attempt.id).executeTakeFirstOrThrow();
    expect(row.context).toEqual(attempt.context);
    expect(row.user_id).toBe(PEOPLE.kayla.id);
  });

  it('never sends answer keys to the learner', async () => {
    const a = await make(['mc', 'msPartial', 'ord', 'match', 'sc', 'sa']);
    const { attempt } = await start('jordan', a.id);
    const text = JSON.stringify(attempt);
    expect(text).not.toContain('"correct"');
    expect(text).not.toContain('acceptedAnswers');
    expect(text).not.toContain('explanation');
    expect(text).not.toContain('rubric');
    expect(text).not.toContain('sampleAnswer');
  });

  it('rejects a grant issued to a different learner', async () => {
    const a = await make(['mc']);
    const foreign = await h.grantFor('isaiah', a.id);
    const res = await h.http.post('/api/v1/attempts').set(await h.as('colton')).send({ grant: foreign });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('GRANT_MISMATCH');
    expect(res.body.error.message).toMatch(/different learner/);
    expect(await h.db.selectFrom('attempts').select('id').where('assessment_id', '=', a.id).execute()).toHaveLength(0);
  });

  it('rejects a grant from another organization', async () => {
    const a = await make(['mc']);
    const grant = await h.grantFor('devon', a.id, 'w1-quiz', { organizationId: '0190a3b2-0000-7000-8000-0000000000aa' });
    const res = await h.http.post('/api/v1/attempts').set(await h.as('devon')).send({ grant });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('GRANT_MISMATCH');
  });

  it('rejects grants for other resources and for a different assessment', async () => {
    const a = await make(['mc']);
    const other = await make(['tf']);
    const media = await h.grantFor('ethan', a.id, 'w1-welcome', { resource: { type: 'media', id: a.id } });
    const wrongType = await h.http.post('/api/v1/attempts').set(await h.as('ethan')).send({ grant: media });
    expect(wrongType.status).toBe(403);
    expect(wrongType.body.error.code).toBe('GRANT_MISMATCH');

    const grantForOther = await h.grantFor('ethan', other.id);
    const intro = await h.http.get(`/api/v1/assessments/${a.id}/intro`).query({ grant: grantForOther }).set(await h.as('ethan'));
    expect(intro.status).toBe(403);
    expect(intro.body.error.message).toMatch(/different assessment/);
  });

  it('rejects expired, tampered and malformed grants', async () => {
    const a = await make(['mc']);
    const data = principalDataFor('darius');
    const short = await signLessonGrant(
      {
        userId: data.userId,
        organizationId: data.organizationId,
        programId: PROGRAM.id,
        enrollmentId: data.userId,
        lessonId: PROGRAM.id,
        resource: { type: 'assessment', id: a.id },
        policy: {},
      },
      TEST_INTERNAL_SECRET,
      1,
    );
    await new Promise((r) => setTimeout(r, 2100));
    const expired = await h.http.post('/api/v1/attempts').set(await h.as('darius')).send({ grant: short });
    expect(expired.status).toBe(403);
    expect(expired.body.error.code).toBe('GRANT_EXPIRED');

    const good = await h.grantFor('darius', a.id);
    const tampered = await h.http.post('/api/v1/attempts').set(await h.as('darius')).send({ grant: `${good.slice(0, -4)}AAAA` });
    expect(tampered.body.error.code).toBe('GRANT_INVALID');
    const garbage = await h.http.post('/api/v1/attempts').set(await h.as('darius')).send({ grant: 'x'.repeat(40) });
    expect(garbage.body.error.code).toBe('GRANT_INVALID');
    const neither = await h.http.post('/api/v1/attempts').set(await h.as('darius')).send({});
    expect(neither.status).toBe(400);
  });

  it('allows standalone attempts only when the assessment says so', async () => {
    const closed = await make(['mc'], { allowStandalone: false });
    const refused = await h.http.post('/api/v1/attempts').set(await h.as('kayla')).send({ assessmentId: closed.id });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('STANDALONE_NOT_ALLOWED');
    expect(refused.body.error.message).toMatch(/from its lesson/);
    const viaGrant = await start('kayla', closed.id, 'grant');
    expect(viaGrant.res.status).toBe(201);

    const open = await make(['mc'], { allowStandalone: true });
    const ok = await start('kayla', open.id);
    expect(ok.res.status).toBe(201);
    expect(ok.attempt.context).toEqual({});
  });

  it('hides drafts and unknown assessments', async () => {
    const draft = await createAssessment(author, { title: 'Draft only', items: [{ kind: 'question', questionId: ids.mc }], publish: false });
    const res = await h.http.post('/api/v1/attempts').set(await h.as('kayla')).send({ assessmentId: draft.id });
    expect(res.status).toBe(404);
    const missing = await h.http.post('/api/v1/attempts').set(await h.as('kayla')).send({ assessmentId: '0190a3b2-0000-7000-8000-0000000000bb' });
    expect(missing.status).toBe(404);
  });
});

describe('starting and resuming', () => {
  it('resumes the open attempt instead of creating a second one', async () => {
    const a = await make(['mc', 'tf']);
    const first = await start('marcus', a.id);
    const again = await start('marcus', a.id);
    expect(first.res.status).toBe(201);
    expect(again.res.status).toBe(200);
    expect(again.attempt.id).toBe(first.attempt.id);
    expect(again.attempt.resumed).toBe(true);
    const rows = await h.db.selectFrom('attempts').select('id').where('assessment_id', '=', a.id).execute();
    expect(rows).toHaveLength(1);
  });

  it('creates only one attempt when starts race', async () => {
    const a = await make(['mc']);
    const headers = await h.as('tyler');
    const results = await Promise.all(Array.from({ length: 6 }, () => h.http.post('/api/v1/attempts').set(headers).send({ assessmentId: a.id })));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await h.db.selectFrom('attempts').select('id').where('assessment_id', '=', a.id).execute()).toHaveLength(1);
  });

  it('keeps the drawn questions and option order stable on resume', async () => {
    const labels = ['mc', 'msAll', 'msPartial', 'tf', 'sa', 'sc', 'ord', 'match'];
    const a = await make(labels, { randomizeQuestions: true, randomizeOptions: true });
    const { attempt, headers } = await start('naomi', a.id);
    const shape = (q: assessment.LearnerAttempt) =>
      q.questions.map((x) => [x.id, 'options' in x ? x.options.map((o) => o.id) : 'items' in x ? x.items.map((o) => o.id) : 'choices' in x ? x.choices.map((o) => o.id) : []]);
    const original = shape(attempt);
    for (let i = 0; i < 3; i++) {
      const resumed = await h.http.post('/api/v1/attempts').set(headers).send({ assessmentId: a.id });
      expect(shape(resumed.body)).toEqual(original);
      const fetched = await h.http.get(`/api/v1/attempts/${attempt.id}`).set(headers);
      expect(shape(fetched.body)).toEqual(original);
    }
    // The snapshot is stored, not recomputed: it is what the database holds.
    const stored = await h.db.selectFrom('attempt_questions').select(['id', 'position', 'option_order']).where('attempt_id', '=', attempt.id).orderBy('position').execute();
    expect(stored.map((s) => s.id)).toEqual(attempt.questions.map((q) => q.id));
    // Two learners get independent random draws.
    const other = await start('isaiah', a.id);
    expect(other.attempt.questions.map((q) => q.prompt)).not.toEqual(attempt.questions.map((q) => q.prompt));
  });

  it('only the learner can open their attempt', async () => {
    const a = await make(['mc']);
    const { attempt } = await start('ethan', a.id);
    expect((await h.http.get(`/api/v1/attempts/${attempt.id}`).set(await h.as('devon'))).status).toBe(404);
    expect((await saveAnswer(h, await h.as('devon'), attempt.id, attempt.questions[0]!.id, null)).status).toBe(404);
    expect((await submit(await h.as('devon'), attempt.id)).status).toBe(404);
  });
});

describe('autosave', () => {
  it('is idempotent and returns progress', async () => {
    const a = await make(['mc', 'tf']);
    const { attempt, headers } = await start('colton', a.id);
    const [q1, q2] = attempt.questions;
    const answer = { type: 'multiple_choice' as const, optionId: 'a' };
    const first = await saveAnswer(h, headers, attempt.id, q1!.id, answer);
    const second = await saveAnswer(h, headers, attempt.id, q1!.id, answer);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toMatchObject({ answered: true, applied: true, answeredCount: 1 });
    expect(second.body).toMatchObject({ answered: true, applied: true, answeredCount: 1 });
    expect((await saveAnswer(h, headers, attempt.id, q2!.id, { type: 'true_false', value: true })).body.answeredCount).toBe(2);
    const cleared = await saveAnswer(h, headers, attempt.id, q1!.id, null);
    expect(cleared.body).toMatchObject({ answered: false, answeredCount: 1 });
    const fetched = await h.http.get(`/api/v1/attempts/${attempt.id}`).set(headers);
    expect(fetched.body.answeredCount).toBe(1);
    expect(fetched.body.questions.find((q: { id: string }) => q.id === q2!.id).response).toEqual({ type: 'true_false', value: true });
  });

  it('ignores stale autosaves that arrive out of order', async () => {
    const a = await make(['mc']);
    const { attempt, headers } = await start('jasmine', a.id);
    const q = attempt.questions[0]!;
    await saveAnswer(h, headers, attempt.id, q.id, { type: 'multiple_choice', optionId: 'b' }, 5);
    const stale = await saveAnswer(h, headers, attempt.id, q.id, { type: 'multiple_choice', optionId: 'c' }, 4);
    expect(stale.status).toBe(200);
    expect(stale.body.applied).toBe(false);
    const fetched = await h.http.get(`/api/v1/attempts/${attempt.id}`).set(headers);
    expect(fetched.body.questions[0].response).toEqual({ type: 'multiple_choice', optionId: 'b' });
  });

  it('explains invalid answers', async () => {
    const a = await make(['mc', 'ord']);
    const { attempt, headers } = await start('kayla', a.id);
    const [mc, ord] = attempt.questions;
    const wrongType = await saveAnswer(h, headers, attempt.id, mc!.id, { type: 'true_false', value: true });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.message).toMatch(/does not fit the question type/);
    const unknown = await saveAnswer(h, headers, attempt.id, mc!.id, { type: 'multiple_choice', optionId: 'nope' });
    expect(unknown.status).toBe(400);
    const incomplete = await saveAnswer(h, headers, attempt.id, ord!.id, { type: 'ordering', order: ['one'] });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.error.message).toMatch(/every item exactly once/);
    const missing = await saveAnswer(h, headers, attempt.id, '0190a3b2-0000-7000-8000-0000000000cc', null);
    expect(missing.status).toBe(404);
  });
});

describe('submitting and grading', () => {
  it('grades every objective question type and reports per-question results', async () => {
    const labels = ['mc', 'msAll', 'msPartial', 'tf', 'sa', 'sc', 'ord', 'match'];
    const a = await make(labels, { revealCorrectAnswers: 'after_submit', passingPercent: 40 });
    const { attempt, headers } = await start('jordan', a.id);
    const answers: Record<string, assessment.AnswerResponse> = {
      mc: { type: 'multiple_choice', optionId: 'a' },
      msAll: { type: 'multiple_select', optionIds: ['d'] },
      msPartial: { type: 'multiple_select', optionIds: ['a', 'b'] },
      tf: { type: 'true_false', value: false },
      sa: { type: 'short_answer', text: '  ONE hundred. ' },
      sc: { type: 'scenario', optionId: 'b' },
      ord: { type: 'ordering', order: ['two', 'one', 'three', 'four'] },
      match: { type: 'matching', matches: { l1: 'r1', l2: 'r3', l3: 'r2', l4: 'r4' } },
    };
    for (const q of attempt.questions) {
      const label = q.prompt.split(':')[0]!;
      expect((await saveAnswer(h, headers, attempt.id, q.id, answers[label]!)).status).toBe(200);
    }
    const res = await submit(headers, attempt.id);
    expect(res.status).toBe(200);
    const result = res.body as assessment.AttemptResult;
    expect(result.status).toBe('graded');
    expect(result.maxPoints).toBe(21);
    expect(result.scorePoints).toBeCloseTo(9.67, 2);
    expect(result.scorePercent).toBeCloseTo(46.05, 1);
    expect(result.passed).toBe(true);
    const byLabel = Object.fromEntries(result.questions.map((q) => [q.prompt.split(':')[0]!, q]));
    expect(byLabel.mc).toMatchObject({ outcome: 'correct', awardedPoints: 1 });
    expect(byLabel.msAll).toMatchObject({ outcome: 'incorrect', awardedPoints: 0 });
    expect(byLabel.msPartial).toMatchObject({ outcome: 'partial', awardedPoints: 2.67 });
    expect(byLabel.tf).toMatchObject({ outcome: 'correct' });
    expect(byLabel.sa).toMatchObject({ outcome: 'correct' });
    expect(byLabel.sc).toMatchObject({ outcome: 'incorrect' });
    expect(byLabel.ord).toMatchObject({ outcome: 'partial', awardedPoints: 2 });
    expect(byLabel.match).toMatchObject({ outcome: 'partial', awardedPoints: 2 });
    expect(byLabel.mc!.correctAnswer).toEqual({ type: 'multiple_choice', optionId: 'a' });
    expect(byLabel.mc!.explanation).toMatch(/Underlayment/);
  });

  it('marks unanswered questions and fails below the pass mark', async () => {
    const a = await make(['mc', 'tf'], { passingPercent: 100 });
    const { attempt, headers } = await start('devon', a.id);
    await saveAnswer(h, headers, attempt.id, attempt.questions[0]!.id, { type: 'multiple_choice', optionId: 'a' });
    const result = (await submit(headers, attempt.id)).body as assessment.AttemptResult;
    expect(result.passed).toBe(false);
    expect(result.scorePercent).toBe(50);
    expect(result.questions.map((q) => q.outcome).sort()).toEqual(['correct', 'unanswered']);
    expect(result.message).toMatch(/did not reach the passing score of 100%/);
    expect(result.attemptsRemaining).toBe(2);
  });

  it('is idempotent: submitting again returns the same result and no second event', async () => {
    const a = await make(['mc', 'tf'], { notifyManagerOn: ['failed', 'passed'] });
    const { attempt, headers } = await start('kayla', a.id);
    await answerAttempt(h, headers, attempt, defs, () => 'right');
    const first = await submit(headers, attempt.id);
    const second = await submit(headers, attempt.id);
    const third = await h.http.get(`/api/v1/attempts/${attempt.id}/result`).set(headers);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(third.body).toEqual(first.body);
    expect(await outbox('assessment.attempt.started', attempt.id)).toHaveLength(1);
    expect(await outbox('assessment.attempt.submitted', attempt.id)).toHaveLength(1);
    expect(await outbox('assessment.attempt.graded', attempt.id)).toHaveLength(1);
  });

  it('survives concurrent submits', async () => {
    const a = await make(['mc']);
    const { attempt, headers } = await start('isaiah', a.id);
    await answerAttempt(h, headers, attempt, defs);
    const results = await Promise.all(Array.from({ length: 5 }, () => submit(headers, attempt.id)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(await outbox('assessment.attempt.graded', attempt.id)).toHaveLength(1);
  });

  it('refuses answers after submission with a clear message', async () => {
    const a = await make(['mc', 'tf'], {}, 'quiz');
    const { attempt, headers } = await start('ethan', a.id);
    await submit(headers, attempt.id);
    const late = await saveAnswer(h, headers, attempt.id, attempt.questions[0]!.id, { type: 'multiple_choice', optionId: 'a' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ATTEMPT_SUBMITTED');
    expect(late.body.error.message).toBe('This quiz attempt has already been submitted.');

    const exam = await make(['mc'], {}, 'exam');
    const examAttempt = await start('ethan', exam.id);
    await submit(examAttempt.headers, examAttempt.attempt.id);
    const lateExam = await saveAnswer(h, examAttempt.headers, examAttempt.attempt.id, examAttempt.attempt.questions[0]!.id, null);
    expect(lateExam.body.error.message).toBe('This exam attempt has already been submitted.');
  });

  it('does not show a result while the attempt is in progress', async () => {
    const a = await make(['mc']);
    const { attempt, headers } = await start('darius', a.id);
    const res = await h.http.get(`/api/v1/attempts/${attempt.id}/result`).set(headers);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ATTEMPT_IN_PROGRESS');
  });

  it('publishes started, submitted and graded events with question results', async () => {
    const a = await make(['mc', 'tf'], { notifyManagerOn: ['failed'], passingPercent: 100 });
    const { attempt, headers } = await start('kayla', a.id, 'grant');
    await answerAttempt(h, headers, attempt, defs, (l) => (l === 'tf' ? 'wrong' : 'right'));
    await submit(headers, attempt.id);

    const [started] = await outbox('assessment.attempt.started', attempt.id);
    expect(started!.payload).toMatchObject({ attemptId: attempt.id, assessmentId: a.id, userId: PEOPLE.kayla.id, attemptNumber: 1, context: { programId: PROGRAM.id } });
    const [submitted] = await outbox('assessment.attempt.submitted', attempt.id);
    expect(submitted!.payload).toMatchObject({ needsReview: false, assessmentTitle: a.title });
    const [graded] = await outbox('assessment.attempt.graded', attempt.id);
    expect(graded!.payload).toMatchObject({
      scorePercent: 50,
      passed: false,
      passingPercent: 100,
      overridden: false,
      kind: 'quiz',
      attemptNumber: 1,
      // Kayla's team manager is notified because the policy says "failed".
      notifyManagerIds: [PEOPLE.danielle.id],
    });
    const results = graded!.payload.questionResults as Array<{ correct: boolean | null; awardedPoints: number; possiblePoints: number; questionId: string; questionVersionId: string }>;
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.correct).sort()).toEqual([false, true]);
    expect(results.every((r) => r.questionVersionId && r.possiblePoints === 1)).toBe(true);
    expect(graded!.actor.id).toBe(PEOPLE.kayla.id);
  });

  it('does not notify managers when the policy does not cover the outcome', async () => {
    const a = await make(['mc'], { notifyManagerOn: ['failed'] });
    const { attempt, headers } = await start('jordan', a.id);
    await answerAttempt(h, headers, attempt, defs);
    await submit(headers, attempt.id);
    const [graded] = await outbox('assessment.attempt.graded', attempt.id);
    expect(graded!.payload.notifyManagerIds).toEqual([]);
  });
});

describe('server-side time limit', () => {
  it('reports the remaining time from the server clock', async () => {
    const a = await make(['mc', 'tf'], { timeLimitSeconds: 600 });
    const { attempt } = await start('marcus', a.id);
    expect(attempt.timeLimitSeconds).toBe(600);
    expect(attempt.timeRemainingSeconds).toBeGreaterThan(590);
    expect(new Date(attempt.expiresAt!).getTime() - new Date(attempt.startedAt).getTime()).toBe(600_000);
    h.clock.advanceMinutes(4);
    const later = await h.http.get(`/api/v1/attempts/${attempt.id}`).set(await h.as('marcus'));
    expect(later.body.timeRemainingSeconds).toBeLessThan(361);
    expect(later.body.timeRemainingSeconds).toBeGreaterThan(300);
    h.clock.advanceMinutes(-4);
  });

  it('auto-submits with the saved answers when the time is up (on access)', async () => {
    const a = await make(['mc', 'tf'], { timeLimitSeconds: 600 });
    const { attempt, headers } = await start('tyler', a.id);
    await saveAnswer(h, headers, attempt.id, attempt.questions[0]!.id, { type: 'multiple_choice', optionId: 'a' });
    await saveAnswer(h, headers, attempt.id, attempt.questions[1]!.id, { type: 'true_false', value: false });
    h.clock.advanceMinutes(11);
    try {
      const fetched = await h.http.get(`/api/v1/attempts/${attempt.id}`).set(headers);
      expect(fetched.body).toMatchObject({ status: 'graded', autoSubmitted: true, timeRemainingSeconds: null });
      const result = (await h.http.get(`/api/v1/attempts/${attempt.id}/result`).set(headers)).body as assessment.AttemptResult;
      expect(result).toMatchObject({ autoSubmitted: true, scorePercent: 100, passed: true });
      expect(result.message).toMatch(/Time ran out/);
      // Submitted at the deadline, not when the learner came back.
      expect(new Date(result.submittedAt!).getTime() - new Date(attempt.startedAt).getTime()).toBe(600_000);
    } finally {
      h.clock.advanceMinutes(-11);
    }
  });

  it('refuses autosave after the deadline and submits the attempt', async () => {
    const a = await make(['mc', 'tf'], { timeLimitSeconds: 60 });
    const { attempt, headers } = await start('caleb', a.id);
    await saveAnswer(h, headers, attempt.id, attempt.questions[0]!.id, { type: 'multiple_choice', optionId: 'a' });
    h.clock.advanceMinutes(2);
    try {
      const late = await saveAnswer(h, headers, attempt.id, attempt.questions[1]!.id, { type: 'true_false', value: false });
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('ATTEMPT_EXPIRED');
      expect(late.body.error.message).toMatch(/Time ran out on this quiz attempt/);
      const row = await h.db.selectFrom('attempts').select(['status', 'auto_submitted', 'score_percent']).where('id', '=', attempt.id).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ status: 'graded', auto_submitted: true, score_percent: 50 });
      const stored = await h.db.selectFrom('attempt_answers').select('response').where('attempt_id', '=', attempt.id).execute();
      expect(stored.filter((s) => s.response).length).toBe(1);
    } finally {
      h.clock.advanceMinutes(-2);
    }
  });

  it('treats a submit after the deadline as an automatic submission', async () => {
    const a = await make(['mc'], { timeLimitSeconds: 60 });
    const { attempt, headers } = await start('brianna', a.id);
    await answerAttempt(h, headers, attempt, defs);
    h.clock.advanceMinutes(5);
    try {
      const res = await submit(headers, attempt.id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ autoSubmitted: true, status: 'graded' });
    } finally {
      h.clock.advanceMinutes(-5);
    }
  });

  it('the sweeper submits overdue attempts and leaves current ones alone', async () => {
    const a = await make(['mc'], { timeLimitSeconds: 60 });
    const overdue = await start('ashlyn', a.id);
    const current = await start('sofia', a.id);
    h.clock.advanceMinutes(1);
    const { ExpirySweeper } = await import('../src/attempts/expiry.sweeper.js');
    const sweeper = h.app.get(ExpirySweeper);
    // Give the second learner plenty of time (an administrator extending a deadline), so only the first is overdue.
    await h.db
      .updateTable('attempts')
      .set({ expires_at: new Date(Date.now() + 10 * 60_000) })
      .where('id', '=', current.attempt.id)
      .execute();
    try {
      const outcome = await sweeper.sweep();
      expect(outcome.expired).toBe(1);
      const rows = await h.db.selectFrom('attempts').select(['id', 'status', 'auto_submitted']).where('assessment_id', '=', a.id).execute();
      expect(rows.find((r) => r.id === overdue.attempt.id)).toMatchObject({ status: 'graded', auto_submitted: true });
      expect(rows.find((r) => r.id === current.attempt.id)).toMatchObject({ status: 'in_progress' });
      expect(await outbox('assessment.attempt.graded', overdue.attempt.id)).toHaveLength(1);
      expect((await sweeper.sweep()).expired).toBe(0);
    } finally {
      h.clock.advanceMinutes(-1);
    }
  });
});

describe('attempt limits and cooldown', () => {
  it('stops at the maximum number of attempts', async () => {
    const a = await make(['mc'], { maxAttempts: 2, retryCooldownMinutes: 0 });
    const headers = await h.as('kayla');
    for (let i = 1; i <= 2; i++) {
      const { attempt } = await start('kayla', a.id);
      expect(attempt.attemptNumber).toBe(i);
      await submit(headers, attempt.id);
    }
    const third = await h.http.post('/api/v1/attempts').set(headers).send({ assessmentId: a.id });
    expect(third.status).toBe(422);
    expect(third.body.error.code).toBe('ATTEMPTS_EXHAUSTED');
    expect(third.body.error.message).toBe('You have used all 2 attempts for this quiz. Ask your trainer if you need another attempt.');
    const intro = await h.http.get(`/api/v1/assessments/${a.id}/intro`).set(headers);
    expect(intro.body).toMatchObject({ attemptsUsed: 2, attemptsRemaining: 0, canStart: false, blockedReason: { code: 'ATTEMPTS_EXHAUSTED' } });
    expect(intro.body.attempts).toHaveLength(2);
  });

  it('supports unlimited attempts', async () => {
    const a = await make(['mc'], { maxAttempts: null });
    const headers = await h.as('jordan');
    for (let i = 0; i < 4; i++) {
      const { attempt } = await start('jordan', a.id);
      await submit(headers, attempt.id);
    }
    const intro = await h.http.get(`/api/v1/assessments/${a.id}/intro`).set(headers);
    expect(intro.body).toMatchObject({ attemptsUsed: 4, attemptsRemaining: null, canStart: true, assessment: { maxAttempts: null } });
  });

  it('enforces the retry cooldown and tells the learner how long to wait', async () => {
    const a = await make(['mc'], { retryCooldownMinutes: 30, maxAttempts: 5 });
    const headers = await h.as('colton');
    const { attempt } = await start('colton', a.id);
    await submit(headers, attempt.id);
    try {
      const blocked = await h.http.post('/api/v1/attempts').set(headers).send({ assessmentId: a.id });
      expect(blocked.status).toBe(422);
      expect(blocked.body.error.code).toBe('COOLDOWN_ACTIVE');
      expect(blocked.body.error.message).toBe('You can start another attempt in 30 minutes.');
      expect(blocked.body.error.details.availableAt).toBeTruthy();
      const intro = await h.http.get(`/api/v1/assessments/${a.id}/intro`).set(headers);
      expect(intro.body).toMatchObject({ canStart: false, blockedReason: { code: 'COOLDOWN_ACTIVE' } });
      expect(intro.body.cooldownUntil).toBeTruthy();

      h.clock.advanceMinutes(29);
      const almost = await h.http.post('/api/v1/attempts').set(headers).send({ assessmentId: a.id });
      expect(almost.body.error.message).toBe('You can start another attempt in 1 minute.');

      h.clock.advanceMinutes(2);
      const ready = await h.http.post('/api/v1/attempts').set(headers).send({ assessmentId: a.id });
      expect(ready.status).toBe(201);
      expect(ready.body.attemptNumber).toBe(2);
    } finally {
      h.clock.advanceMinutes(-31);
    }
  });

  it('resuming is allowed during a cooldown that started from another attempt', async () => {
    const a = await make(['mc'], { retryCooldownMinutes: 60, maxAttempts: 5 });
    const { attempt } = await start('jasmine', a.id);
    const resumed = await h.http.post('/api/v1/attempts').set(await h.as('jasmine')).send({ assessmentId: a.id });
    expect(resumed.status).toBe(200);
    expect(resumed.body.id).toBe(attempt.id);
  });

  it('shows the best score and pass status in the intro', async () => {
    const a = await make(['mc', 'tf'], { passingPercent: 100, maxAttempts: 3 });
    const headers = await h.as('marcus');
    const first = await start('marcus', a.id);
    await answerAttempt(h, headers, first.attempt, defs, (l) => (l === 'tf' ? 'wrong' : 'right'));
    await submit(headers, first.attempt.id);
    let intro = (await h.http.get(`/api/v1/assessments/${a.id}/intro`).set(headers)).body as assessment.AssessmentIntro;
    expect(intro).toMatchObject({ bestScorePercent: 50, passed: false, attemptsRemaining: 2, canStart: true });
    const second = await start('marcus', a.id);
    await answerAttempt(h, headers, second.attempt, defs);
    await submit(headers, second.attempt.id);
    intro = (await h.http.get(`/api/v1/assessments/${a.id}/intro`).set(headers)).body as assessment.AssessmentIntro;
    expect(intro).toMatchObject({ bestScorePercent: 100, passed: true, attemptsUsed: 2 });
    expect(intro.attempts.map((x) => x.attemptNumber)).toEqual([2, 1]);
  });
});

describe('reveal policies', () => {
  async function finish(person: keyof typeof PEOPLE, assessmentId: string, mode: 'right' | 'wrong') {
    const { attempt, headers } = await start(person, assessmentId);
    await answerAttempt(h, headers, attempt, defs, () => mode);
    const result = (await submit(headers, attempt.id)).body as assessment.AttemptResult;
    return { attempt, headers, result };
  }

  it('never reveals answers but still shows the score', async () => {
    const a = await make(['mc', 'tf'], { revealCorrectAnswers: 'never' });
    const { result } = await finish('kayla', a.id, 'wrong');
    expect(result).toMatchObject({ answersRevealed: false, scoreVisible: true, scorePercent: 0 });
    expect(result.questions.every((q) => q.correctAnswer === null && q.explanation === null)).toBe(true);
    expect(result.questions.every((q) => q.outcome === 'incorrect')).toBe(true);
  });

  it('reveals after submit', async () => {
    const a = await make(['mc', 'tf'], { revealCorrectAnswers: 'after_submit' });
    const { result } = await finish('jordan', a.id, 'wrong');
    expect(result.answersRevealed).toBe(true);
    expect(result.questions.every((q) => q.correctAnswer !== null && q.explanation)).toBe(true);
  });

  it('reveals after a pass only', async () => {
    const a = await make(['mc', 'tf'], { revealCorrectAnswers: 'after_pass', maxAttempts: 3 });
    const failed = await finish('isaiah', a.id, 'wrong');
    expect(failed.result).toMatchObject({ passed: false, answersRevealed: false });
    expect(failed.result.questions.every((q) => q.correctAnswer === null)).toBe(true);
    const passed = await finish('isaiah', a.id, 'right');
    expect(passed.result).toMatchObject({ passed: true, answersRevealed: true });
    expect(passed.result.questions.every((q) => q.correctAnswer !== null)).toBe(true);
  });

  it('reveals after the final attempt has been used', async () => {
    const a = await make(['mc', 'tf'], { revealCorrectAnswers: 'after_final_attempt', maxAttempts: 2 });
    const first = await finish('colton', a.id, 'wrong');
    expect(first.result.answersRevealed).toBe(false);
    const second = await finish('colton', a.id, 'wrong');
    expect(second.result).toMatchObject({ answersRevealed: true, attemptsRemaining: 0 });
    // Once the last attempt is used, earlier results can be reviewed too.
    const again = await h.http.get(`/api/v1/attempts/${first.attempt.id}/result`).set(first.headers);
    expect(again.body.answersRevealed).toBe(true);
    expect(again.body.message).toMatch(/no attempts left/);
  });

  it('hides the numeric score and per-question correctness when scores are not revealed', async () => {
    const a = await make(['mc', 'tf'], { revealScore: false, revealCorrectAnswers: 'after_submit' });
    const { result, attempt, headers } = await finish('devon', a.id, 'right');
    expect(result).toMatchObject({ scoreVisible: false, scorePercent: null, scorePoints: null, maxPoints: null, passed: true });
    expect(result.questions.every((q) => q.outcome === null && q.awardedPoints === null)).toBe(true);
    expect(result.message).not.toMatch(/\d+%\.?$/);
    const mine = await h.http.get('/api/v1/attempts/mine').query({ assessmentId: a.id }).set(headers);
    expect(mine.body.items[0]).toMatchObject({ id: attempt.id, scorePercent: null, passed: true });
    const intro = await h.http.get(`/api/v1/assessments/${a.id}/intro`).set(headers);
    expect(intro.body.bestScorePercent).toBeNull();
  });

  it('suggests when the learner can retry after a failure', async () => {
    const a = await make(['mc'], { retryCooldownMinutes: 45, maxAttempts: 3 });
    const { result } = await finish('ethan', a.id, 'wrong');
    expect(result.retakeAvailableAt).toBeTruthy();
    expect(result.message).toMatch(/try again in 45 minutes/);
  });
});

describe('listing my attempts', () => {
  it('returns only the caller’s attempts, newest first', async () => {
    const a = await make(['mc'], { maxAttempts: 5 });
    const headers = await h.as('naomi');
    const first = await start('naomi', a.id);
    await submit(headers, first.attempt.id);
    const second = await start('naomi', a.id);
    await start('darius', a.id);
    const mine = await h.http.get('/api/v1/attempts/mine').query({ assessmentId: a.id }).set(headers);
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((x: { id: string }) => x.id)).toEqual([second.attempt.id, first.attempt.id]);
  });
});
