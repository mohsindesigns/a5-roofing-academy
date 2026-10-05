import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { assessment } from '@a5/contracts';
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

beforeAll(async () => {
  h = await createAssessmentHarness('qbank', { seed: false });
  author = { http: h.http, headers: await h.as('shelby') };
});
afterAll(() => h?.close());

const admin = () => ({ http: h.http, headers: author.headers });
async function audits(resourceId: string): Promise<string[]> {
  const rows = await h.db.selectFrom('outbox_events').select('envelope').where('type', '=', 'audit.recorded').orderBy('created_at').execute();
  return rows.map((r) => r.envelope as { payload: { action: string; resourceId: string } }).filter((e) => e.payload.resourceId === resourceId).map((e) => e.payload.action);
}

describe('question banks', () => {
  it('creates, reads, updates and lists banks', async () => {
    const created = await h.http.post('/api/v1/question-banks').set(author.headers).send({ title: 'Roof Systems Bank', description: 'Everything about shingles.' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: 'Roof Systems Bank',
      description: 'Everything about shingles.',
      archived: false,
      questionCount: 0,
      categories: [],
      competencies: [],
      createdBy: { displayName: 'Shelby Hartman' },
    });
    const id = created.body.id as string;

    const updated = await h.http.patch(`/api/v1/question-banks/${id}`).set(author.headers).send({ description: null, title: 'Roof Systems' });
    expect(updated.body).toMatchObject({ title: 'Roof Systems', description: null });
    expect(await audits(id)).toEqual(['question_bank.created', 'question_bank.updated']);

    await createBank(author, 'Insurance Claims Bank');
    const list = await h.http.get('/api/v1/question-banks').query({ q: 'roof' }).set(author.headers);
    expect(list.body.items.map((b: { title: string }) => b.title)).toEqual(['Roof Systems']);
    const all = await h.http.get('/api/v1/question-banks').query({ pageSize: '1', page: '2', sort: 'title' }).set(author.headers);
    expect(all.body).toMatchObject({ page: 2, pageSize: 1 });
    // Two banks exist at this point: "Insurance Claims Bank" sorts first, so page 2 holds "Roof Systems".
    expect(all.body.total).toBe(2);
    expect(all.body.items.map((b: { title: string }) => b.title)).toEqual(['Roof Systems']);
  });

  it('rejects duplicate titles regardless of case and validates input', async () => {
    await createBank(author, 'Compliance Bank');
    const dup = await h.http.post('/api/v1/question-banks').set(author.headers).send({ title: 'compliance bank' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('BANK_TITLE_TAKEN');
    const blank = await h.http.post('/api/v1/question-banks').set(author.headers).send({ title: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error.fields[0].path).toBe('title');
  });

  it('archives and restores banks, hiding archived ones by default', async () => {
    const bank = await createBank(author, 'Seasonal Bank');
    const archived = await h.http.post(`/api/v1/question-banks/${bank.id}/archive`).set(author.headers);
    expect(archived.body.archived).toBe(true);
    const hidden = await h.http.get('/api/v1/question-banks').query({ q: 'Seasonal' }).set(author.headers);
    expect(hidden.body.items).toHaveLength(0);
    const shown = await h.http.get('/api/v1/question-banks').query({ q: 'Seasonal', includeArchived: 'true' }).set(author.headers);
    expect(shown.body.items).toHaveLength(1);
    const blocked = await h.http.post('/api/v1/questions').set(author.headers).send({ bankId: bank.id, ...sampleQuestions.trueFalse('x') });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('BANK_ARCHIVED');
    const restored = await h.http.post(`/api/v1/question-banks/${bank.id}/restore`).set(author.headers);
    expect(restored.body.archived).toBe(false);
    expect(await audits(bank.id)).toEqual(['question_bank.created', 'question_bank.archived', 'question_bank.restored']);
  });

  it('deletes empty banks only', async () => {
    const empty = await createBank(author, 'Scratch Bank');
    expect((await h.http.delete(`/api/v1/question-banks/${empty.id}`).set(author.headers)).status).toBe(200);
    expect((await h.http.get(`/api/v1/question-banks/${empty.id}`).set(author.headers)).status).toBe(404);

    const used = await createBank(author, 'Used Bank');
    await createQuestion(author, used.id, sampleQuestions.trueFalse('u'));
    const refused = await h.http.delete(`/api/v1/question-banks/${used.id}`).set(author.headers);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('BANK_NOT_EMPTY');
  });

  it('will not archive a bank that published assessments draw from', async () => {
    const bank = await createBank(author, 'Pool Source');
    for (let i = 0; i < 3; i++) await createQuestion(author, bank.id, sampleQuestions.trueFalse(`p${i}`));
    const a = await createAssessment(author, { title: 'Draws from pool source', items: [{ kind: 'pool', bankId: bank.id, count: 2 }] });
    const refused = await h.http.post(`/api/v1/question-banks/${bank.id}/archive`).set(author.headers);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('BANK_IN_USE');
    expect(refused.body.error.message).toContain('Draws from pool source');
    await h.http.post(`/api/v1/assessments/${a.id}/archive`).set(author.headers).expect(200);
    expect((await h.http.post(`/api/v1/question-banks/${bank.id}/archive`).set(author.headers)).status).toBe(200);
  });
});

describe('categories and competencies', () => {
  it('manages categories with counts, ordering and uniqueness', async () => {
    const bank = await createBank(author, 'Category Bank');
    const first = await h.http.post(`/api/v1/question-banks/${bank.id}/categories`).set(author.headers).send({ name: 'Storm Damage', description: 'Hail and wind' });
    const second = await h.http.post(`/api/v1/question-banks/${bank.id}/categories`).set(author.headers).send({ name: 'Compliance' });
    expect(first.status).toBe(201);
    expect([first.body.position, second.body.position]).toEqual([0, 1]);
    const dup = await h.http.post(`/api/v1/question-banks/${bank.id}/categories`).set(author.headers).send({ name: 'storm damage' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CATEGORY_NAME_TAKEN');

    await createQuestion(author, bank.id, sampleQuestions.trueFalse('c', { categoryId: first.body.id }));
    const list = await h.http.get(`/api/v1/question-banks/${bank.id}/categories`).set(author.headers);
    expect(list.body.items.map((c: { name: string; questionCount: number }) => [c.name, c.questionCount])).toEqual([['Storm Damage', 1], ['Compliance', 0]]);

    const renamed = await h.http.patch(`/api/v1/question-banks/${bank.id}/categories/${second.body.id}`).set(author.headers).send({ name: 'Compliance & Ethics', position: 0 });
    expect(renamed.body).toMatchObject({ name: 'Compliance & Ethics', position: 0 });
    const inUse = await h.http.delete(`/api/v1/question-banks/${bank.id}/categories/${first.body.id}`).set(author.headers);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe('CATEGORY_IN_USE');
    expect((await h.http.delete(`/api/v1/question-banks/${bank.id}/categories/${renamed.body.id}`).set(author.headers)).status).toBe(200);
  });

  it('manages competencies', async () => {
    const bank = await createBank(author, 'Competency Bank');
    const created = await h.http.post(`/api/v1/question-banks/${bank.id}/competencies`).set(author.headers).send({ name: 'Discovery & rapport' });
    expect(created.status).toBe(201);
    expect((await h.http.post(`/api/v1/question-banks/${bank.id}/competencies`).set(author.headers).send({ name: 'DISCOVERY & RAPPORT' })).status).toBe(409);
    await createQuestion(author, bank.id, sampleQuestions.trueFalse('k', { competencyIds: [created.body.id] }));
    const list = await h.http.get(`/api/v1/question-banks/${bank.id}/competencies`).set(author.headers);
    expect(list.body.items[0]).toMatchObject({ name: 'Discovery & rapport', questionCount: 1 });
    const refused = await h.http.delete(`/api/v1/question-banks/${bank.id}/competencies/${created.body.id}`).set(author.headers);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('COMPETENCY_IN_USE');
    const other = await h.http.post(`/api/v1/question-banks/${bank.id}/competencies`).set(author.headers).send({ name: 'Unused' });
    expect((await h.http.delete(`/api/v1/question-banks/${bank.id}/competencies/${other.body.id}`).set(author.headers)).status).toBe(200);
  });

  it('does not allow categories of one bank on questions of another', async () => {
    const a = await createBank(author, 'Bank A');
    const b = await createBank(author, 'Bank B');
    const category = await h.http.post(`/api/v1/question-banks/${a.id}/categories`).set(author.headers).send({ name: 'Only in A' });
    const res = await h.http.post('/api/v1/questions').set(author.headers).send({ bankId: b.id, ...sampleQuestions.trueFalse('x', { categoryId: category.body.id }) });
    expect(res.status).toBe(400);
    expect(res.body.error.fields[0]).toMatchObject({ path: 'categoryId' });
  });
});

describe('questions', () => {
  let bankId: string;
  let categoryId: string;
  let competencyId: string;

  beforeAll(async () => {
    const bank = await createBank(author, 'Question Bank Under Test');
    bankId = bank.id;
    categoryId = (await h.http.post(`/api/v1/question-banks/${bankId}/categories`).set(author.headers).send({ name: 'Insurance' })).body.id;
    competencyId = (await h.http.post(`/api/v1/question-banks/${bankId}/competencies`).set(author.headers).send({ name: 'Claims' })).body.id;
  });

  it('creates a question of every type as version 1', async () => {
    const samples = [
      sampleQuestions.multipleChoice('t1'),
      sampleQuestions.multipleSelect('t2', 'partial'),
      sampleQuestions.trueFalse('t3'),
      sampleQuestions.shortAnswer('t4'),
      sampleQuestions.longAnswer('t5'),
      sampleQuestions.scenarioChoice('t6'),
      sampleQuestions.scenarioOpen('t7'),
      sampleQuestions.ordering('t8'),
      sampleQuestions.matching('t9'),
    ];
    for (const sample of samples) {
      const q = await createQuestion(author, bankId, { ...sample, categoryId, competencyIds: [competencyId], tags: ['Week 2', 'hail'] });
      expect(q).toMatchObject({
        status: 'active',
        versionCount: 1,
        currentVersion: { version: 1, type: sample.type, points: sample.points, category: { id: categoryId, name: 'Insurance' }, tags: ['week 2', 'hail'] },
      });
      expect(q.currentVersion.competencies).toEqual([{ id: competencyId, name: 'Claims' }]);
      expect(q.currentVersion.config).toBeTruthy();
      expect(await audits(q.id)).toEqual(['question.created']);
    }
  });

  it('validates content and explains what to fix', async () => {
    const noCorrect = sampleQuestions.multipleChoice('bad', { config: { options: [{ id: 'a', text: 'A', correct: false }, { id: 'b', text: 'B', correct: false }] } });
    const res = await h.http.post('/api/v1/questions').set(author.headers).send({ bankId, ...noCorrect });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.map((f: { message: string }) => f.message)).toContain('Mark exactly one option as correct');
    const noType = await h.http.post('/api/v1/questions').set(author.headers).send({ bankId, prompt: 'x' });
    expect(noType.status).toBe(400);
    const zeroPoints = await h.http.post('/api/v1/questions').set(author.headers).send({ bankId, ...sampleQuestions.trueFalse('z', { points: 0 }) });
    expect(zeroPoints.body.error.fields[0].message).toBe('Points must be greater than zero');
    const noBank = await h.http.post('/api/v1/questions').set(author.headers).send({ bankId: '0190a3b2-0000-7000-8000-0000000000f0', ...sampleQuestions.trueFalse('z') });
    expect(noBank.status).toBe(400);
    expect(noBank.body.error.fields[0].path).toBe('bankId');
  });

  it('filters, searches and paginates the question list', async () => {
    const filterBank = await createBank(author, 'Filter Bank');
    const cat = (await h.http.post(`/api/v1/question-banks/${filterBank.id}/categories`).set(author.headers).send({ name: 'Roofing' })).body.id as string;
    await createQuestion(author, filterBank.id, sampleQuestions.multipleChoice('f1', { difficulty: 'easy', tags: ['week-1', 'shingles'], categoryId: cat }));
    await createQuestion(author, filterBank.id, sampleQuestions.multipleChoice('f2', { difficulty: 'hard', tags: ['week-2', 'shingles'], categoryId: cat }));
    await createQuestion(author, filterBank.id, sampleQuestions.trueFalse('f3', { difficulty: 'easy', tags: ['week-2'] }));
    await createQuestion(author, filterBank.id, sampleQuestions.longAnswer('f4', { difficulty: 'medium', prompt: 'f4: Explain how granule loss shortens shingle life.' }));
    const list = async (query: Record<string, string>) => {
      const res = await h.http.get('/api/v1/questions').query({ bankId: filterBank.id, pageSize: '50', ...query }).set(author.headers);
      expect(res.status).toBe(200);
      return (res.body.items as Array<{ prompt: string }>).map((i) => i.prompt.split(':')[0]).sort();
    };
    expect(await list({})).toEqual(['f1', 'f2', 'f3', 'f4']);
    expect(await list({ type: 'multiple_choice' })).toEqual(['f1', 'f2']);
    expect(await list({ type: 'true_false,long_answer' })).toEqual(['f3', 'f4']);
    expect(await list({ difficulty: 'easy' })).toEqual(['f1', 'f3']);
    expect(await list({ difficulty: 'easy,hard' })).toEqual(['f1', 'f2', 'f3']);
    expect(await list({ categoryId: cat })).toEqual(['f1', 'f2']);
    expect(await list({ tags: 'shingles' })).toEqual(['f1', 'f2']);
    expect(await list({ tags: 'shingles,week-2' })).toEqual(['f2']);
    expect(await list({ q: 'granule' })).toEqual(['f4']);
    expect(await list({ q: 'underlayment' })).toEqual(['f1', 'f2']);
    expect(await list({ q: 'nothing matches this' })).toEqual([]);

    const page = await h.http.get('/api/v1/questions').query({ bankId: filterBank.id, pageSize: '3', page: '2', sort: 'prompt' }).set(author.headers);
    expect(page.body).toMatchObject({ page: 2, pageSize: 3, total: 4, pageCount: 2 });
    expect(page.body.items).toHaveLength(1);
    const summary = (await h.http.get('/api/v1/questions').query({ bankId: filterBank.id, type: 'long_answer' }).set(author.headers)).body.items[0];
    expect(summary).toMatchObject({ manualReview: true, version: 1, bank: { title: 'Filter Bank' }, usedInAssessments: 0 });
  });

  it('editing creates a new immutable version and keeps the old one', async () => {
    const q = await createQuestion(author, bankId, sampleQuestions.multipleChoice('edit'));
    const v1 = q.currentVersion;
    const edited = await h.http
      .put(`/api/v1/questions/${q.id}`)
      .set(author.headers)
      .send({
        ...sampleQuestions.multipleChoice('edit', { prompt: 'edit: which layer protects the deck if water gets past the shingles?', points: 2 }),
        changeNote: 'Clarified the wording and doubled the points.',
        expectedVersion: 1,
      });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ versionCount: 2, currentVersion: { version: 2, points: 2, changeNote: 'Clarified the wording and doubled the points.' } });
    expect(edited.body.currentVersion.id).not.toBe(v1.id);
    expect(edited.body.currentVersion.createdBy.displayName).toBe('Shelby Hartman');

    const history = await h.http.get(`/api/v1/questions/${q.id}/versions`).set(author.headers);
    expect(history.body.items.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(history.body.items[1]).toMatchObject({ id: v1.id, prompt: v1.prompt, points: 1 });
    const stored = await h.db.selectFrom('question_versions').select(['prompt', 'points']).where('id', '=', v1.id).executeTakeFirstOrThrow();
    expect(stored).toEqual({ prompt: v1.prompt, points: 1 });
    expect(await audits(q.id)).toEqual(['question.created', 'question.version_created']);
  });

  it('does not create a version when nothing changed', async () => {
    const q = await createQuestion(author, bankId, sampleQuestions.trueFalse('same'));
    const same = await h.http.put(`/api/v1/questions/${q.id}`).set(author.headers).send(sampleQuestions.trueFalse('same'));
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ versionCount: 1, currentVersion: { version: 1 } });
  });

  it('detects concurrent edits', async () => {
    const q = await createQuestion(author, bankId, sampleQuestions.trueFalse('race'));
    await h.http.put(`/api/v1/questions/${q.id}`).set(author.headers).send({ ...sampleQuestions.trueFalse('race', { points: 3 }), expectedVersion: 1 }).expect(200);
    const stale = await h.http.put(`/api/v1/questions/${q.id}`).set(author.headers).send({ ...sampleQuestions.trueFalse('race', { points: 5 }), expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('QUESTION_CHANGED');
    expect(stale.body.error.message).toMatch(/version 2/);
    expect(stale.body.error.details.currentVersion).toBe(2);
  });

  it('keeps past attempts on the version they drew', async () => {
    const bank = await createBank(author, 'Versioning Bank');
    const q = await createQuestion(author, bank.id, sampleQuestions.multipleChoice('ver'));
    const a = await createAssessment(author, { title: 'Versioning quiz', config: { maxAttempts: 5, passingPercent: 100 }, items: [{ kind: 'question', questionId: q.id }] });
    const learner = await h.as('kayla');
    const first = await h.http.post('/api/v1/attempts').set(learner).send({ assessmentId: a.id });
    expect(first.body.questions[0].prompt).toMatch(/which layer sits directly on the roof deck/);

    // The question is rewritten (new correct answer) while the learner is mid-attempt.
    const rewritten = sampleQuestions.multipleChoice('ver', {
      prompt: 'ver: REWRITTEN which layer is the outermost?',
      config: { options: [{ id: 'a', text: 'Underlayment', correct: false }, { id: 'b', text: 'Shingles', correct: true }] },
    });
    const edited = await h.http.put(`/api/v1/questions/${q.id}`).set(author.headers).send(rewritten);
    expect(edited.body.currentVersion.version).toBe(2);

    // The in-progress attempt still shows, and is graded against, version 1.
    const resumed = await h.http.get(`/api/v1/attempts/${first.body.id}`).set(learner);
    expect(resumed.body.questions[0].prompt).toMatch(/sits directly on the roof deck/);
    await h.http.put(`/api/v1/attempts/${first.body.id}/answers/${first.body.questions[0].id}`).set(learner).send({ response: { type: 'multiple_choice', optionId: 'a' } }).expect(200);
    const result = await h.http.post(`/api/v1/attempts/${first.body.id}/submit`).set(learner);
    expect(result.body).toMatchObject({ scorePercent: 100, passed: true });
    const review = await h.http.get(`/api/v1/attempts/${first.body.id}/review`).set(await h.as('priya'));
    expect(review.body.questions[0]).toMatchObject({ version: 1, awardedPoints: 1 });

    // A new attempt draws the current version.
    const second = await h.http.post('/api/v1/attempts').set(learner).send({ assessmentId: a.id });
    expect(second.body.questions[0].prompt).toMatch(/REWRITTEN/);
    const secondRow = await h.db.selectFrom('attempt_questions as aq').innerJoin('question_versions as v', 'v.id', 'aq.question_version_id').select('v.version').where('aq.attempt_id', '=', second.body.id).executeTakeFirstOrThrow();
    expect(secondRow.version).toBe(2);
    const detail = await h.http.get(`/api/v1/questions/${q.id}`).set(author.headers);
    expect(detail.body).toMatchObject({ attemptCount: 2, usage: [{ title: 'Versioning quiz', status: 'published' }] });
  });

  it('archives and restores questions, but not while a published assessment uses them', async () => {
    const bank = await createBank(author, 'Archive Bank');
    const used = await createQuestion(author, bank.id, sampleQuestions.trueFalse('used'));
    const spare = await createQuestion(author, bank.id, sampleQuestions.trueFalse('spare'));
    const a = await createAssessment(author, { title: 'Uses a question', items: [{ kind: 'question', questionId: used.id }] });
    const refused = await h.http.post(`/api/v1/questions/${used.id}/archive`).set(author.headers);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('QUESTION_IN_USE');
    expect(refused.body.error.message).toContain('Uses a question');

    const archived = await h.http.post(`/api/v1/questions/${spare.id}/archive`).set(author.headers);
    expect(archived.body).toMatchObject({ status: 'archived' });
    const active = await h.http.get('/api/v1/questions').query({ bankId: bank.id }).set(author.headers);
    expect(active.body.items.map((i: { id: string }) => i.id)).toEqual([used.id]);
    const archivedList = await h.http.get('/api/v1/questions').query({ bankId: bank.id, status: 'archived' }).set(author.headers);
    expect(archivedList.body.items.map((i: { id: string }) => i.id)).toEqual([spare.id]);
    expect((await h.http.get('/api/v1/questions').query({ bankId: bank.id, status: 'all' }).set(author.headers)).body.total).toBe(2);
    const edit = await h.http.put(`/api/v1/questions/${spare.id}`).set(author.headers).send(sampleQuestions.trueFalse('spare', { points: 2 }));
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('QUESTION_ARCHIVED');
    expect((await h.http.post(`/api/v1/questions/${spare.id}/restore`).set(author.headers)).body.status).toBe('active');

    await h.http.post(`/api/v1/assessments/${a.id}/archive`).set(author.headers).expect(200);
    expect((await h.http.post(`/api/v1/questions/${used.id}/archive`).set(author.headers)).status).toBe(200);
  });

  it('previews a question as the learner sees it, with the key for authors', async () => {
    const q = await createQuestion(author, bankId, sampleQuestions.multipleChoice('pv'));
    await h.http.put(`/api/v1/questions/${q.id}`).set(author.headers).send(sampleQuestions.multipleChoice('pv', { prompt: 'pv: second version' })).expect(200);
    const preview = await h.http.get(`/api/v1/questions/${q.id}/preview`).set(author.headers);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ version: 2, manualReview: false, correctAnswer: { type: 'multiple_choice', optionId: 'a' } });
    expect(preview.body.question.options.map((o: { id: string }) => o.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(JSON.stringify(preview.body.question)).not.toContain('"correct"');
    const v1 = await h.http.get(`/api/v1/questions/${q.id}/preview`).query({ versionId: q.currentVersion.id }).set(author.headers);
    expect(v1.body).toMatchObject({ version: 1 });
    expect(v1.body.question.prompt).toMatch(/sits directly on the roof deck/);
  });

  it('grades a sample answer without storing anything', async () => {
    const q = await createQuestion(author, bankId, sampleQuestions.shortAnswer('chk'));
    const attemptsBefore = (await h.db.selectFrom('attempts').select('id').execute()).length;
    const right = await h.http.post(`/api/v1/questions/${q.id}/preview/check`).set(author.headers).send({ response: { type: 'short_answer', text: 'One Hundred.' } });
    expect(right.body).toMatchObject({ outcome: 'correct', awardedPoints: 1, points: 1, correctAnswer: { acceptedAnswers: ['100', 'one hundred'] } });
    const wrong = await h.http.post(`/api/v1/questions/${q.id}/preview/check`).set(author.headers).send({ response: { type: 'short_answer', text: '10' } });
    expect(wrong.body).toMatchObject({ outcome: 'incorrect', awardedPoints: 0 });
    const essay = await createQuestion(author, bankId, sampleQuestions.longAnswer('chk2'));
    const open = await h.http.post(`/api/v1/questions/${essay.id}/preview/check`).set(author.headers).send({ response: { type: 'long_answer', text: 'Because.' } });
    expect(open.body).toMatchObject({ outcome: 'pending_review', awardedPoints: null });
    expect(await h.db.selectFrom('attempts').select('id').execute()).toHaveLength(attemptsBefore);
    expect(await h.db.selectFrom('attempt_answers').select('id').where('response', 'is not', null).where('attempt_id', 'not in', h.db.selectFrom('attempts').select('id')).execute()).toHaveLength(0);
  });

  it('keeps tenants apart', async () => {
    const q = await createQuestion(author, bankId, sampleQuestions.trueFalse('tenant'));
    const outsider = await h.asUser({ userId: '0190a3b2-0000-7000-8000-0000000000a1', organizationId: '0190a3b2-0000-7000-8000-0000000000a2', permissions: ['assessments.view', 'assessments.update'], scope: 'organization' });
    expect((await h.http.get(`/api/v1/questions/${q.id}`).set(outsider)).status).toBe(404);
    expect((await h.http.get(`/api/v1/question-banks/${bankId}`).set(outsider)).status).toBe(404);
    expect((await h.http.get('/api/v1/questions').set(outsider)).body.total).toBe(0);
    expect((await h.http.put(`/api/v1/questions/${q.id}`).set(outsider).send(sampleQuestions.trueFalse('tenant'))).status).toBe(404);
  });
});

describe('answers survive a full edit-and-take cycle for every type', () => {
  it('lets a learner take one question of each type through the API', async () => {
    const bank = await createBank(author, 'All types');
    const bodies = {
      mc: sampleQuestions.multipleChoice('mc'),
      ms: sampleQuestions.multipleSelect('ms', 'partial'),
      tf: sampleQuestions.trueFalse('tf'),
      sa: sampleQuestions.shortAnswer('sa'),
      sc: sampleQuestions.scenarioChoice('sc'),
      ord: sampleQuestions.ordering('ord'),
      match: sampleQuestions.matching('match'),
    };
    const items: Array<Record<string, unknown>> = [];
    const defs: Record<string, assessment.QuestionDefinition> = {};
    for (const [label, body] of Object.entries(bodies)) {
      items.push({ kind: 'question', questionId: (await createQuestion(admin(), bank.id, body)).id });
      defs[label] = definitionOf(body);
    }
    const a = await createAssessment(admin(), { title: 'Every type', items });
    const learner = await h.as('colton');
    const attempt = (await h.http.post('/api/v1/attempts').set(learner).send({ assessmentId: a.id })).body as assessment.LearnerAttempt;
    await answerAttempt(h, learner, attempt, defs);
    const result = await h.http.post(`/api/v1/attempts/${attempt.id}/submit`).set(learner);
    expect(result.body).toMatchObject({ scorePercent: 100, passed: true, status: 'graded' });
  });
});
