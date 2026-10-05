import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PEOPLE } from '@a5/seed-data';
import { buildProgram, enroll, lessonStates, outline } from './fixtures.js';
import { createLearningHarness, type LearningHarness } from './harness.js';

let h: LearningHarness;
let admin: Record<string, string>;

beforeAll(async () => {
  h = await createLearningHarness('approvals');
  admin = await h.as('grant');
});
afterAll(() => h?.close());

const queue = async (who: Record<string, string>, query = '') => {
  const res = await h.http.get(`/api/v1/learning/approvals${query}`).set(who);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as Array<{ id: string; kind: string; status: string; learner: { id: string; displayName: string }; lesson: { title: string }; submission: { body: string } | null }>;
};

describe('assignment reviews and manager sign-off', () => {
  it('moves a learner from submission through rejection and approval to program completion', async () => {
    const built = await buildProgram(h, admin, {
      title: 'Field Readiness',
      phases: [
        {
          key: 'p1',
          lessons: [
            { key: 'task', type: 'assignment', title: 'Ride-along reflection', config: { instructions: 'Describe what you observed.', minWords: 5 } },
            { key: 'signoff', type: 'manager_approval', title: 'Manager sign-off', config: { instructions: 'Confirm the rep is field-ready.' } },
          ],
        },
      ],
    });
    const [{ enrollmentId }] = (await enroll(h, admin, built.id, ['marcus'])).items as [{ enrollmentId: string }];
    const rep = await h.as('marcus');
    const danielle = await h.as('danielle');
    const submitUrl = `/api/v1/learning/me/lessons/${built.lessons.task}/submission`;

    expect(Object.values(lessonStates(await outline(h, rep, built.id)))).toEqual(['available', 'locked']);
    // The sign-off is not requested until the learner reaches it.
    expect(await queue(danielle)).toEqual([]);

    const short = await h.http.post(submitUrl).set(rep).send({ body: 'Too short' });
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('SUBMISSION_TOO_SHORT');
    expect(short.body.error.message).toContain('at least 5 words');

    await h.clearOutbox();
    const first = await h.http.post(submitUrl).set(rep).send({ body: 'I watched how the rep opened each door and photographed every slope.' });
    expect(first.status).toBe(201);
    expect(first.body.submission).toMatchObject({ status: 'submitted', wordCount: 12 });
    expect(first.body.approval).toMatchObject({ kind: 'assignment_review', status: 'pending' });
    expect((await h.outbox('approval.requested'))[0]!.payload).toMatchObject({
      kind: 'assignment_review',
      lessonTitle: 'Ride-along reflection',
      programTitle: 'Field Readiness',
      userId: PEOPLE.marcus.id,
    });
    const dup = await h.http.post(submitUrl).set(rep).send({ body: 'Trying to submit a second answer while the first is waiting.' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SUBMISSION_PENDING');

    // Who sees the review: the learner's manager and trainer, not other managers or trainers.
    const approvalId = first.body.approval.id;
    expect((await queue(danielle)).map((a) => [a.id, a.kind, a.learner.displayName, a.submission?.body.slice(0, 12)])).toEqual([[approvalId, 'assignment_review', 'Marcus Delgado', 'I watched ho']]);
    expect((await queue(await h.as('shelby'))).map((a) => a.id)).toEqual([approvalId]);
    expect(await queue(await h.as('andre'))).toEqual([]);
    expect(await queue(await h.as('hector'))).toEqual([]);
    expect((await queue(admin)).map((a) => a.id)).toEqual([approvalId]);

    const decisionUrl = `/api/v1/learning/approvals/${approvalId}/decision`;
    expect((await h.http.post(decisionUrl).set(await h.as('andre')).send({ decision: 'approved' })).status).toBe(404);
    expect((await h.http.post(decisionUrl).set(rep).send({ decision: 'approved' })).status).toBe(403);
    const noComment = await h.http.post(decisionUrl).set(danielle).send({ decision: 'rejected' });
    expect(noComment.status).toBe(400);
    expect(noComment.body.error.fields[0].path).toBe('comment');

    // Rejection: the learner sees the feedback and may resubmit; nothing completes.
    await h.clearOutbox();
    const rejected = await h.http.post(decisionUrl).set(danielle).send({ decision: 'rejected', comment: 'Add what you would do differently.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: 'rejected', comment: 'Add what you would do differently.', decidedBy: { displayName: 'Danielle Okafor' } });
    expect((await h.outbox('approval.decided'))[0]!.payload).toMatchObject({ decision: 'rejected', kind: 'assignment_review', decidedBy: PEOPLE.danielle.id, comment: 'Add what you would do differently.' });
    const afterReject = await h.http.get(`/api/v1/learning/me/lessons/${built.lessons.task}`).set(rep);
    expect(afterReject.body).toMatchObject({
      state: 'in_progress',
      approval: { status: 'rejected', comment: 'Add what you would do differently.' },
      submission: { status: 'rejected', feedback: 'Add what you would do differently.' },
    });
    expect((await h.http.post(decisionUrl).set(danielle).send({ decision: 'approved' })).status).toBe(409);
    expect(await queue(danielle)).toEqual([]);
    expect((await queue(danielle, '?status=rejected')).map((a) => a.id)).toEqual([approvalId]);

    // Second submission, approved by the trainer: the lesson completes and the sign-off opens.
    const second = await h.http.post(submitUrl).set(rep).send({ body: 'This time I also describe what I would do differently at the door.' });
    expect(second.status).toBe(201);
    await h.clearOutbox();
    const approved = await h.http.post(`/api/v1/learning/approvals/${second.body.approval.id}/decision`).set(await h.as('shelby')).send({ decision: 'approved', comment: 'Much better.' });
    expect(approved.body).toMatchObject({ status: 'approved', decidedBy: { displayName: 'Shelby Hartman' } });
    expect((await h.db.selectFrom('lesson_progress').select(['completion_source', 'completed_by']).where('lesson_id', '=', built.lessons.task!).executeTakeFirstOrThrow())).toEqual({
      completion_source: 'approval',
      completed_by: PEOPLE.shelby.id,
    });
    expect((await outline(h, rep, built.id)).phases[0]!.modules[0]!.lessons.map((l) => l.state)).toEqual(['completed', 'available']);
    const opened = (await h.outbox('approval.requested'))[0]!.payload;
    expect(opened).toMatchObject({ kind: 'manager_approval', lessonTitle: 'Manager sign-off' });

    // Sign-off is a manager decision: the trainer neither sees nor decides it.
    const signoff = (await queue(danielle)).find((a) => a.kind === 'manager_approval')!;
    expect(signoff.lesson.title).toBe('Manager sign-off');
    expect((await queue(await h.as('shelby'))).filter((a) => a.kind === 'manager_approval')).toEqual([]);
    expect((await h.http.post(`/api/v1/learning/approvals/${signoff.id}/decision`).set(await h.as('shelby')).send({ decision: 'approved' })).status).toBe(404);

    // Sent back once, requested again (idempotent while pending), then approved.
    expect((await h.http.post(`/api/v1/learning/approvals/${signoff.id}/decision`).set(danielle).send({ decision: 'rejected', comment: 'Shadow two more inspections first.' })).status).toBe(200);
    const requestUrl = `/api/v1/learning/me/lessons/${built.lessons.signoff}/approval-request`;
    const again = await h.http.post(requestUrl).set(rep).send({ note: 'Done two more ride-alongs.' });
    expect(again.body).toMatchObject({ kind: 'manager_approval', status: 'pending' });
    expect((await h.http.post(requestUrl).set(rep).send({})).body.id).toBe(again.body.id);
    await h.clearOutbox();
    expect((await h.http.post(`/api/v1/learning/approvals/${again.body.id}/decision`).set(danielle).send({ decision: 'approved' })).status).toBe(200);
    expect(await h.outbox('program.completed')).toHaveLength(1);
    const detail = await h.http.get(`/api/v1/enrollments/${enrollmentId}`).set(admin);
    expect(detail.body).toMatchObject({ status: 'completed', progressPercent: 100 });
    expect(detail.body.approvals.map((a: { kind: string; status: string }) => `${a.kind}:${a.status}`).sort()).toEqual([
      'assignment_review:approved',
      'assignment_review:rejected',
      'manager_approval:approved',
      'manager_approval:rejected',
    ]);
    expect((await h.http.post(requestUrl).set(rep).send({})).status).toBe(409);
  });

  it('opens a manager sign-off as soon as the learner reaches it and keeps people from approving themselves', async () => {
    const built = await buildProgram(h, admin, {
      title: 'Sign-off First',
      phases: [{ key: 'p1', lessons: [{ key: 'signoff', type: 'manager_approval', title: 'Team lead sign-off', config: { instructions: 'Confirm.' } }] }],
    });
    await h.clearOutbox();
    // Danielle is a manager and also takes the program herself.
    await enroll(h, admin, built.id, ['danielle', 'kayla']);
    const requests = await h.db.selectFrom('approval_requests').select(['user_id', 'status', 'kind']).where('program_id', '=', built.id).execute();
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.status === 'pending' && r.kind === 'manager_approval')).toBe(true);
    expect(await h.outbox('approval.requested')).toHaveLength(2);

    const danielle = await h.as('danielle');
    const mine = (await queue(danielle)).filter((a) => a.lesson.title === 'Team lead sign-off');
    expect(mine.map((a) => a.learner.displayName)).toEqual(['Kayla Simmons']);
    const own = await h.db.selectFrom('approval_requests').select('id').where('user_id', '=', PEOPLE.danielle.id).executeTakeFirstOrThrow();
    const self = await h.http.post(`/api/v1/learning/approvals/${own.id}/decision`).set(danielle).send({ decision: 'approved' });
    expect(self.status).toBe(403);
    expect(self.body.error.message).toContain('your own training');
    // An administrator can decide for her.
    expect((await h.http.post(`/api/v1/learning/approvals/${own.id}/decision`).set(admin).send({ decision: 'approved' })).status).toBe(200);
  });

  it('rejects assignment and approval actions on the wrong lesson type', async () => {
    const built = await buildProgram(h, admin, {
      title: 'Wrong Type',
      settings: { navigationMode: 'free' },
      phases: [{ key: 'p1', lessons: [{ key: 'read', type: 'article' }] }],
    });
    await enroll(h, admin, built.id, ['tyler']);
    const rep = await h.as('tyler');
    const base = `/api/v1/learning/me/lessons/${built.lessons.read}`;
    expect((await h.http.post(`${base}/submission`).set(rep).send({ body: 'Hello there everyone' })).body.error.code).toBe('WRONG_LESSON_TYPE');
    expect((await h.http.post(`${base}/acknowledge`).set(rep).send({ typedName: 'Tyler Brennan' })).body.error.code).toBe('WRONG_LESSON_TYPE');
    expect((await h.http.post(`${base}/approval-request`).set(rep).send({})).body.error.code).toBe('WRONG_LESSON_TYPE');
  });
});
