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
let bankId: string;
const q: Record<string, string> = {};
const defs: Record<string, assessment.QuestionDefinition> = {};

beforeAll(async () => {
  h = await createAssessmentHarness('builder', { seed: false });
  author = { http: h.http, headers: await h.as('shelby') };
  bankId = (await createBank(author, 'Builder bank')).id;
  const bodies = {
    a: sampleQuestions.multipleChoice('a'),
    b: sampleQuestions.trueFalse('b'),
    c: sampleQuestions.shortAnswer('c'),
    d: sampleQuestions.multipleChoice('d'),
  };
  for (const [label, body] of Object.entries(bodies)) {
    q[label] = (await createQuestion(author, bankId, body)).id;
    defs[label] = definitionOf(body);
  }
});
afterAll(() => h?.close());

const draft = (title: string, items: Array<Record<string, unknown>> = []) => createAssessment(author, { title, items, publish: false });
const positions = (a: assessment.AssessmentDetail) => a.items.map((i) => [i.position, i.kind === 'question' ? i.question.prompt.split(':')[0] : `pool×${i.count}`]);
async function auditActions(id: string): Promise<string[]> {
  const rows = await h.db.selectFrom('outbox_events').select('envelope').where('type', '=', 'audit.recorded').orderBy('created_at').execute();
  return rows.map((r) => r.envelope as { payload: { action: string; resourceId: string } }).filter((e) => e.payload.resourceId === id).map((e) => e.payload.action);
}

describe('creating and editing assessments', () => {
  it('applies sensible defaults and records an audit entry', async () => {
    const res = await h.http.post('/api/v1/assessments').set(author.headers).send({ title: '  Week 5 Check  ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: 'Week 5 Check',
      kind: 'quiz',
      status: 'draft',
      revision: 1,
      itemCount: 0,
      questionCount: 0,
      attemptCount: 0,
      publishedAt: null,
      config: {
        passingPercent: 80,
        maxAttempts: 3,
        timeLimitSeconds: null,
        randomizeQuestions: false,
        randomizeOptions: true,
        revealCorrectAnswers: 'after_submit',
        revealScore: true,
        retryCooldownMinutes: 0,
        notifyManagerOn: ['failed'],
        allowStandalone: false,
      },
      createdBy: { displayName: 'Shelby Hartman' },
    });
    expect(await auditActions(res.body.id)).toEqual(['assessment.created']);
  });

  it('validates configuration', async () => {
    const post = (config: Record<string, unknown>) => h.http.post('/api/v1/assessments').set(author.headers).send({ title: 'Bad config', config });
    expect((await post({ passingPercent: 120 })).status).toBe(400);
    expect((await post({ passingPercent: -1 })).status).toBe(400);
    expect((await post({ maxAttempts: 0 })).status).toBe(400);
    expect((await post({ timeLimitSeconds: 30 })).status).toBe(400);
    expect((await post({ revealCorrectAnswers: 'sometimes' })).status).toBe(400);
    expect((await post({ retryCooldownMinutes: -5 })).status).toBe(400);
    expect((await post({ notifyManagerOn: ['exploded'] })).status).toBe(400);
    const ok = await post({ maxAttempts: null, timeLimitSeconds: 1800, notifyManagerOn: ['failed', 'passed', 'failed'] });
    expect(ok.status).toBe(201);
    expect(ok.body.config).toMatchObject({ maxAttempts: null, timeLimitSeconds: 1800, notifyManagerOn: ['failed', 'passed'] });
    expect((await h.http.post('/api/v1/assessments').set(author.headers).send({ title: '' })).status).toBe(400);
    expect((await h.http.post('/api/v1/assessments').set(author.headers).send({ title: 'x', kind: 'homework' })).status).toBe(400);
  });

  it('merges configuration changes, bumps the revision and audits the change', async () => {
    const a = await draft('Editable');
    const res = await h.http.patch(`/api/v1/assessments/${a.id}`).set(author.headers).send({ title: 'Editable v2', kind: 'exam', config: { passingPercent: 90, timeLimitSeconds: 900 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Editable v2', kind: 'exam', revision: 2, config: { passingPercent: 90, timeLimitSeconds: 900, maxAttempts: 3, randomizeOptions: true } });
    const cleared = await h.http.patch(`/api/v1/assessments/${a.id}`).set(author.headers).send({ config: { timeLimitSeconds: null, maxAttempts: null }, description: 'Now untimed.' });
    expect(cleared.body).toMatchObject({ description: 'Now untimed.', revision: 3, config: { timeLimitSeconds: null, maxAttempts: null, passingPercent: 90 } });
    const invalid = await h.http.patch(`/api/v1/assessments/${a.id}`).set(author.headers).send({ config: { passingPercent: 500 } });
    expect(invalid.status).toBe(400);
    expect(await auditActions(a.id)).toEqual(['assessment.created', 'assessment.updated', 'assessment.updated']);
  });

  it('lists with filters, search and pagination', async () => {
    const bank = await createBank(author, 'List bank');
    const one = await createQuestion(author, bank.id, sampleQuestions.trueFalse('l1'));
    await createAssessment(author, { title: 'Alpha Roofing Basics', kind: 'quiz', items: [{ kind: 'question', questionId: one.id }] });
    await draft('Beta Insurance Drill');
    await createAssessment(author, { title: 'Gamma Final Review', kind: 'final', items: [{ kind: 'question', questionId: one.id }] });
    const list = async (query: Record<string, string>) =>
      (await h.http.get('/api/v1/assessments').query({ pageSize: '100', ...query }).set(author.headers)).body.items.map((i: { title: string }) => i.title);
    expect(await list({ q: 'roofing' })).toEqual(['Alpha Roofing Basics']);
    expect(await list({ q: 'Insurance' })).toEqual(['Beta Insurance Drill']);
    expect(await list({ status: 'draft', q: 'Beta' })).toEqual(['Beta Insurance Drill']);
    expect(await list({ status: 'published', q: 'a' })).toEqual(expect.arrayContaining(['Alpha Roofing Basics', 'Gamma Final Review']));
    expect(await list({ kind: 'final', q: 'Gamma' })).toEqual(['Gamma Final Review']);
    const sorted = await list({ sort: '-title', q: 'Beta,Gamma,Alpha' });
    expect(sorted).toEqual([]);
    const page = await h.http.get('/api/v1/assessments').query({ pageSize: '2', page: '1', sort: 'title' }).set(author.headers);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.pageCount).toBeGreaterThan(1);
  });

  it('deletes only drafts', async () => {
    const a = await draft('Throwaway');
    expect((await h.http.delete(`/api/v1/assessments/${a.id}`).set(author.headers)).status).toBe(200);
    expect((await h.http.get(`/api/v1/assessments/${a.id}`).set(author.headers)).status).toBe(404);
    const published = await createAssessment(author, { title: 'Keep me', items: [{ kind: 'question', questionId: q.a }] });
    const res = await h.http.delete(`/api/v1/assessments/${published.id}`).set(author.headers);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ASSESSMENT_NOT_DRAFT');
  });

  it('duplicates an assessment as an unpublished copy with the same items and settings', async () => {
    const source = await createAssessment(author, {
      title: 'Original',
      kind: 'exam',
      config: { passingPercent: 95, timeLimitSeconds: 600 },
      items: [{ kind: 'question', questionId: q.a }, { kind: 'pool', bankId, count: 2 }],
    });
    const copy = await h.http.post(`/api/v1/assessments/${source.id}/duplicate`).set(author.headers).send({});
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ title: 'Copy of Original', status: 'draft', kind: 'exam', config: { passingPercent: 95, timeLimitSeconds: 600 }, itemCount: 2 });
    expect(copy.body.id).not.toBe(source.id);
    expect(copy.body.items.map((i: { id: string }) => i.id)).not.toEqual(source.items.map((i) => i.id));
    expect(positions(copy.body)).toEqual(positions(source));
    const named = await h.http.post(`/api/v1/assessments/${source.id}/duplicate`).set(author.headers).send({ title: 'Original (retake version)' });
    expect(named.body.title).toBe('Original (retake version)');
  });

  it('publishes, archives and republishes', async () => {
    const a = await draft('Lifecycle', [{ kind: 'question', questionId: q.a, position: 1 }]);
    const published = await h.http.post(`/api/v1/assessments/${a.id}/publish`).set(author.headers);
    expect(published.body).toMatchObject({ status: 'published', publishedAt: expect.any(String) });
    expect((await h.http.post(`/api/v1/assessments/${a.id}/publish`).set(author.headers)).body.status).toBe('published');
    const archived = await h.http.post(`/api/v1/assessments/${a.id}/archive`).set(author.headers);
    expect(archived.body).toMatchObject({ status: 'archived', archivedAt: expect.any(String) });
    const edit = await h.http.patch(`/api/v1/assessments/${a.id}`).set(author.headers).send({ title: 'Nope' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('ASSESSMENT_ARCHIVED');
    expect((await h.http.post(`/api/v1/assessments/${a.id}/items`).set(author.headers).send({ kind: 'question', questionId: q.b })).status).toBe(409);

    const learner = await h.as('kayla');
    const start = await h.http.post('/api/v1/attempts').set(learner).send({ assessmentId: a.id });
    expect(start.status).toBe(422);
    expect(start.body.error.code).toBe('ASSESSMENT_NOT_AVAILABLE');
    const viaGrant = await h.http.post('/api/v1/attempts').set(learner).send({ grant: await h.grantFor('kayla', a.id) });
    expect(viaGrant.status).toBe(422);
    expect(viaGrant.body.error.code).toBe('ASSESSMENT_NOT_AVAILABLE');
    expect((await h.http.post(`/api/v1/assessments/${a.id}/publish`).set(author.headers)).body.status).toBe('published');
    expect(await auditActions(a.id)).toEqual(['assessment.created', 'assessment.items_updated', 'assessment.published', 'assessment.archived', 'assessment.published']);
  });
});

describe('items and explicit positions', () => {
  it('inserts at a position, shifting later items', async () => {
    const a = await draft('Positions');
    const one = await h.http.post(`/api/v1/assessments/${a.id}/items`).set(author.headers).send({ kind: 'question', questionId: q.a });
    expect(positions(one.body)).toEqual([[1, 'a']]);
    const two = await h.http.post(`/api/v1/assessments/${a.id}/items`).set(author.headers).send({ kind: 'question', questionId: q.b });
    expect(positions(two.body)).toEqual([[1, 'a'], [2, 'b']]);
    const front = await h.http.post(`/api/v1/assessments/${a.id}/items`).set(author.headers).send({ kind: 'question', questionId: q.c, position: 1 });
    expect(positions(front.body)).toEqual([[1, 'c'], [2, 'a'], [3, 'b']]);
    const far = await h.http.post(`/api/v1/assessments/${a.id}/items`).set(author.headers).send({ kind: 'question', questionId: q.d, position: 9 });
    expect(far.status).toBe(400);
    expect(far.body.error.fields[0].message).toMatch(/between 1 and 4/);
  });

  it('moves, edits and removes items while keeping positions contiguous', async () => {
    const a = await draft('Moves', [
      { kind: 'question', questionId: q.a, position: 1 },
      { kind: 'question', questionId: q.b, position: 2 },
      { kind: 'question', questionId: q.c, position: 3 },
    ]);
    const first = a.items[0]!;
    const moved = await h.http.put(`/api/v1/assessments/${a.id}/items/${first.id}`).set(author.headers).send({ kind: 'question', questionId: q.a, position: 3, points: 5 });
    expect(moved.status).toBe(200);
    expect(positions(moved.body)).toEqual([[1, 'b'], [2, 'c'], [3, 'a']]);
    expect(moved.body.items[2]).toMatchObject({ id: first.id, points: 5 });

    const removed = await h.http.delete(`/api/v1/assessments/${a.id}/items/${moved.body.items[0].id}`).set(author.headers);
    expect(positions(removed.body)).toEqual([[1, 'c'], [2, 'a']]);
    expect((await h.http.delete(`/api/v1/assessments/${a.id}/items/0190a3b2-0000-7000-8000-0000000000f1`).set(author.headers)).status).toBe(404);
    expect(await auditActions(a.id)).toContain('assessment.items_updated');
  });

  it('replaces the whole list, keeping ids of existing items', async () => {
    const a = await draft('Replace', [
      { kind: 'question', questionId: q.a, position: 1 },
      { kind: 'question', questionId: q.b, position: 2 },
    ]);
    const [x, y] = a.items;
    const res = await h.http
      .put(`/api/v1/assessments/${a.id}/items`)
      .set(author.headers)
      .send({
        items: [
          { id: y!.id, kind: 'question', questionId: q.b, position: 1 },
          { kind: 'pool', bankId, count: 2, position: 2 },
          { id: x!.id, kind: 'question', questionId: q.a, position: 3, points: 2 },
        ],
      });
    expect(res.status).toBe(200);
    expect(positions(res.body)).toEqual([[1, 'b'], [2, 'pool×2'], [3, 'a']]);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([y!.id, expect.any(String), x!.id]);
    expect(res.body.revision).toBe(a.revision + 1);
  });

  it('rejects bad item lists with field-level messages', async () => {
    const a = await draft('Invalid items', [{ kind: 'question', questionId: q.a, position: 1 }]);
    const put = (items: Array<Record<string, unknown>>) => h.http.put(`/api/v1/assessments/${a.id}/items`).set(author.headers).send({ items });
    const gap = await put([{ kind: 'question', questionId: q.a, position: 1 }, { kind: 'question', questionId: q.b, position: 3 }]);
    expect(gap.status).toBe(400);
    expect(gap.body.error.fields[0].message).toMatch(/Positions must run from 1 to 2/);
    const dup = await put([{ kind: 'question', questionId: q.a, position: 1 }, { kind: 'question', questionId: q.a, position: 2 }]);
    expect(dup.status).toBe(400);
    expect(dup.body.error.fields[0].message).toMatch(/already in the assessment/);
    const missing = await put([{ kind: 'question', questionId: '0190a3b2-0000-7000-8000-0000000000f2', position: 1 }]);
    expect(missing.body.error.fields[0].message).toBe('Choose an existing question');
    const foreignItem = await put([{ id: '0190a3b2-0000-7000-8000-0000000000f3', kind: 'question', questionId: q.a, position: 1 }]);
    expect(foreignItem.status).toBe(400);
    const noBank = await put([{ kind: 'pool', bankId: '0190a3b2-0000-7000-8000-0000000000f4', count: 1, position: 1 }]);
    expect(noBank.body.error.fields[0].message).toBe('Choose an existing question bank');
    const zero = await put([{ kind: 'pool', bankId, count: 0, position: 1 }]);
    expect(zero.status).toBe(400);
    const archivedQuestion = await createQuestion(author, bankId, sampleQuestions.trueFalse('arch'));
    await h.http.post(`/api/v1/questions/${archivedQuestion.id}/archive`).set(author.headers).expect(200);
    const archived = await put([{ kind: 'question', questionId: archivedQuestion.id, position: 1 }]);
    expect(archived.body.error.fields[0].message).toMatch(/archived/);
    // A rejected request changes nothing.
    expect(positions((await h.http.get(`/api/v1/assessments/${a.id}`).set(author.headers)).body)).toEqual([[1, 'a']]);
  });

  it('an item points override replaces the question’s own points in attempts', async () => {
    const a = await createAssessment(author, {
      title: 'Weighted',
      config: { maxAttempts: 3 },
      items: [{ kind: 'question', questionId: q.a, points: 5 }, { kind: 'question', questionId: q.b }],
    });
    const headers = await h.as('kayla');
    const attempt = (await h.http.post('/api/v1/attempts').set(headers).send({ assessmentId: a.id })).body as assessment.LearnerAttempt;
    expect(attempt.questions.map((x) => x.points)).toEqual([5, 1]);
    await answerAttempt(h, headers, attempt, defs, (l) => (l === 'a' ? 'right' : 'wrong'));
    const result = (await h.http.post(`/api/v1/attempts/${attempt.id}/submit`).set(headers)).body as assessment.AttemptResult;
    expect(result).toMatchObject({ scorePoints: 5, maxPoints: 6, scorePercent: 83.33 });
  });
});

describe('question pools', () => {
  let poolBank: string;
  let rare: string;
  const poolIds: string[] = [];
  let easyCategory: string;

  beforeAll(async () => {
    poolBank = (await createBank(author, 'Pool bank')).id;
    easyCategory = (await h.http.post(`/api/v1/question-banks/${poolBank}/categories`).set(author.headers).send({ name: 'Easy ones' })).body.id;
    const specs = [
      { label: 'p1', difficulty: 'easy', tags: ['week-1'], categoryId: easyCategory },
      { label: 'p2', difficulty: 'easy', tags: ['week-1', 'hail'], categoryId: easyCategory },
      { label: 'p3', difficulty: 'easy', tags: ['hail'], categoryId: easyCategory },
      { label: 'p4', difficulty: 'hard', tags: ['week-1'], categoryId: easyCategory },
      { label: 'p5', difficulty: 'medium', tags: [], categoryId: null },
    ];
    for (const s of specs) {
      const created = await createQuestion(author, poolBank, sampleQuestions.trueFalse(s.label, { difficulty: s.difficulty, tags: s.tags, categoryId: s.categoryId }));
      poolIds.push(created.id);
    }
    rare = (await createQuestion(author, poolBank, sampleQuestions.trueFalse('rare', { tags: ['rare'] }))).id;
  });

  it('counts the questions each rule matches', async () => {
    const a = await draft('Pool counts', [
      { kind: 'pool', bankId: poolBank, categoryId: easyCategory, difficulty: 'easy', count: 2, position: 1 },
      { kind: 'pool', bankId: poolBank, tags: ['hail'], count: 1, position: 2 },
      { kind: 'pool', bankId: poolBank, difficulty: 'hard', count: 1, position: 3 },
    ]);
    const pools = a.items.filter((i): i is Extract<assessment.AssessmentItem, { kind: 'pool' }> => i.kind === 'pool');
    expect(pools.map((p) => p.available)).toEqual([3, 2, 1]);
    expect(pools[0]).toMatchObject({ bank: { title: 'Pool bank' }, category: { name: 'Easy ones' }, difficulty: 'easy', tags: [] });
    expect(a.questionCount).toBe(4);
  });

  it('blocks publishing when a pool cannot be satisfied and explains why', async () => {
    const a = await draft('Too small', [{ kind: 'pool', bankId: poolBank, difficulty: 'hard', count: 3, position: 1 }]);
    const validation = (await h.http.get(`/api/v1/assessments/${a.id}/validation`).set(author.headers)).body as assessment.AssessmentValidation;
    expect(validation).toMatchObject({ valid: false, questionCount: 3 });
    expect(validation.issues[0]).toMatchObject({ code: 'POOL_TOO_SMALL', position: 1, itemId: a.items[0]!.id });
    expect(validation.issues[0]!.message).toBe('The pool at position 1 (Pool bank · hard) needs 3 questions but only 1 active question matches that are not already fixed items.');
    expect(validation.pools).toEqual([{ itemId: a.items[0]!.id, position: 1, required: 3, available: 1 }]);
    const publish = await h.http.post(`/api/v1/assessments/${a.id}/publish`).set(author.headers);
    expect(publish.status).toBe(422);
    expect(publish.body.error.code).toBe('ASSESSMENT_INCOMPLETE');
    expect(publish.body.error.message).toContain('needs 3 questions');
    expect(publish.body.error.details.issues).toHaveLength(1);
  });

  it('does not count questions that are already fixed items', async () => {
    const a = await draft('Fixed steals', [
      { kind: 'question', questionId: poolIds[3], position: 1 },
      { kind: 'pool', bankId: poolBank, difficulty: 'hard', count: 1, position: 2 },
    ]);
    const validation = (await h.http.get(`/api/v1/assessments/${a.id}/validation`).set(author.headers)).body as assessment.AssessmentValidation;
    expect(validation.valid).toBe(false);
    expect(validation.pools[0]).toMatchObject({ required: 1, available: 0 });
  });

  it('requires at least one item', async () => {
    const a = await draft('Empty');
    const publish = await h.http.post(`/api/v1/assessments/${a.id}/publish`).set(author.headers);
    expect(publish.status).toBe(422);
    expect(publish.body.error.message).toContain('Add at least one question or question pool');
  });

  it('detects overlapping pools that together need more distinct questions than exist', async () => {
    const small = (await createBank(author, 'Overlap bank')).id;
    for (const [i, tags] of [['o1', ['rare']], ['o2', []], ['o3', []]] as const) {
      await createQuestion(author, small, sampleQuestions.trueFalse(i, { tags }));
    }
    const bad = await draft('Overlap', [
      { kind: 'pool', bankId: small, tags: ['rare'], count: 1, position: 1 },
      { kind: 'pool', bankId: small, count: 3, position: 2 },
    ]);
    const validation = (await h.http.get(`/api/v1/assessments/${bad.id}/validation`).set(author.headers)).body as assessment.AssessmentValidation;
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((i) => i.code)).toContain('POOLS_OVERLAP');
    expect((await h.http.post(`/api/v1/assessments/${bad.id}/publish`).set(author.headers)).status).toBe(422);
  });

  it('fills overlapping pools that do have a solution, whatever the random draw', async () => {
    const small = (await createBank(author, 'Overlap ok bank')).id;
    for (const [i, tags] of [['r1', ['rare']], ['r2', []], ['r3', []]] as const) {
      await createQuestion(author, small, sampleQuestions.trueFalse(i, { tags }));
    }
    const good = await createAssessment(author, {
      title: 'Overlap ok',
      items: [{ kind: 'pool', bankId: small, count: 2 }, { kind: 'pool', bankId: small, tags: ['rare'], count: 1 }],
    });
    for (let i = 0; i < 15; i++) {
      const preview = (await h.http.post(`/api/v1/assessments/${good.id}/preview`).set(author.headers)).body as assessment.AssessmentPreview;
      const labels = preview.questions.map((x) => x.question.prompt.split(':')[0]).sort();
      expect(labels).toEqual(['r1', 'r2', 'r3']);
    }
  });

  it('draws only matching, distinct, active questions for each attempt and varies between attempts', async () => {
    const a = await createAssessment(author, {
      title: 'Drawn from rules',
      config: { maxAttempts: 20, randomizeQuestions: true },
      items: [
        { kind: 'question', questionId: poolIds[0], position: 1 },
        { kind: 'pool', bankId: poolBank, categoryId: easyCategory, difficulty: 'easy', count: 2 },
        { kind: 'pool', bankId: poolBank, tags: ['rare'], count: 1 },
      ],
    });
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const person = (['kayla', 'jordan', 'marcus', 'tyler', 'isaiah', 'colton'] as const)[i]!;
      const headers = await h.as(person);
      const attempt = (await h.http.post('/api/v1/attempts').set(headers).send({ assessmentId: a.id })).body as assessment.LearnerAttempt;
      const labels = attempt.questions.map((x) => x.prompt.split(':')[0]!);
      expect(labels).toHaveLength(4);
      expect(new Set(labels).size).toBe(4);
      expect(labels).toContain('p1');
      expect(labels).toContain('rare');
      // The pool of easy questions in the category excludes the fixed p1.
      const easy = labels.filter((l) => l !== 'p1' && l !== 'rare');
      expect(easy.every((l) => ['p2', 'p3'].includes(l))).toBe(true);
      seen.add(labels.join(','));
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(rare).toBeTruthy();
  });

  it('keeps a published assessment satisfiable', async () => {
    const bank = (await createBank(author, 'Guarded bank')).id;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await createQuestion(author, bank, sampleQuestions.trueFalse(`g${i}`))).id);
    const a = await createAssessment(author, { title: 'Guarded', items: [{ kind: 'pool', bankId: bank, count: 3 }] });
    // Archiving a question would leave the pool short.
    const archive = await h.http.post(`/api/v1/questions/${ids[0]}/archive`).set(author.headers);
    expect(archive.status).toBe(409);
    expect(archive.body.error.code).toBe('QUESTION_NEEDED_BY_POOL');
    expect(archive.body.error.message).toContain('Guarded');
    // Raising the pool count beyond what exists is refused too.
    const raise = await h.http.put(`/api/v1/assessments/${a.id}/items/${a.items[0]!.id}`).set(author.headers).send({ kind: 'pool', bankId: bank, count: 4, position: 1 });
    expect(raise.status).toBe(422);
    expect(raise.body.error.code).toBe('ASSESSMENT_INCOMPLETE');
    const clear = await h.http.put(`/api/v1/assessments/${a.id}/items`).set(author.headers).send({ items: [] });
    expect(clear.status).toBe(422);
    expect((await h.http.get(`/api/v1/assessments/${a.id}`).set(author.headers)).body.items).toHaveLength(1);
  });
});

describe('preview', () => {
  it('draws a sample attempt with the answer key and stores nothing', async () => {
    const a = await createAssessment(author, {
      title: 'Preview me',
      config: { randomizeOptions: true },
      items: [{ kind: 'question', questionId: q.a, points: 3 }, { kind: 'question', questionId: q.b }, { kind: 'pool', bankId, count: 1 }],
    });
    const before = await h.db.selectFrom('attempts').select('id').execute();
    const res = await h.http.post(`/api/v1/assessments/${a.id}/preview`).set(author.headers);
    expect(res.status).toBe(200);
    const preview = res.body as assessment.AssessmentPreview;
    expect(preview.questionCount).toBe(3);
    expect(preview.questions.map((x) => x.position)).toEqual([1, 2, 3]);
    expect(preview.questions[0]).toMatchObject({ source: 'question', correctAnswer: { type: 'multiple_choice', optionId: 'a' }, question: { points: 3 } });
    expect(preview.questions[2]).toMatchObject({ source: 'pool' });
    expect(preview.totalPoints).toBeGreaterThanOrEqual(5);
    expect(await h.db.selectFrom('attempts').select('id').execute()).toHaveLength(before.length);
  });

  it('refuses to preview an assessment that cannot be drawn', async () => {
    const a = await draft('Cannot preview', [{ kind: 'pool', bankId, count: 50, position: 1 }]);
    const res = await h.http.post(`/api/v1/assessments/${a.id}/preview`).set(author.headers);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ASSESSMENT_INCOMPLETE');
    expect(res.body.error.message).toMatch(/cannot be previewed yet/);
  });
});

describe('statistics', () => {
  it('summarises attempts, pass rate, averages and the hardest questions, using effective scores', async () => {
    const a = await createAssessment(author, { title: 'Stats subject', config: { passingPercent: 60, maxAttempts: 3 }, items: [{ kind: 'question', questionId: q.a }, { kind: 'question', questionId: q.b }] });
    const take = async (person: 'kayla' | 'jordan' | 'marcus' | 'tyler', mode: (label: string) => 'right' | 'wrong', submit = true) => {
      const headers = await h.as(person);
      const attempt = (await h.http.post('/api/v1/attempts').set(headers).send({ assessmentId: a.id })).body as assessment.LearnerAttempt;
      await answerAttempt(h, headers, attempt, defs, mode);
      if (submit) await h.http.post(`/api/v1/attempts/${attempt.id}/submit`).set(headers).expect(200);
      return attempt;
    };
    await take('kayla', () => 'right');
    await take('jordan', (l) => (l === 'b' ? 'wrong' : 'right'));
    await take('jordan', () => 'right');
    const marcus = await take('marcus', () => 'wrong');
    await take('tyler', () => 'right', false);

    const res = await h.http.get(`/api/v1/assessments/${a.id}/stats`).set(author.headers);
    expect(res.status).toBe(200);
    const stats = res.body as assessment.AssessmentStats;
    expect(stats.attempts).toEqual({ total: 5, inProgress: 1, pendingReview: 0, graded: 4, autoSubmitted: 0 });
    expect(stats).toMatchObject({ learners: 4, passRate: 50, firstAttemptPassRate: 33.33, averageScorePercent: 62.5, medianScorePercent: 75 });
    expect(stats.averageDurationSeconds).toBeGreaterThanOrEqual(0);
    expect(stats.scoreDistribution).toHaveLength(10);
    expect(stats.scoreDistribution.find((b) => b.from === 0)!.count).toBe(1);
    expect(stats.scoreDistribution.find((b) => b.from === 50)!.count).toBe(1);
    expect(stats.scoreDistribution.find((b) => b.from === 90)!.count).toBe(2);
    expect(stats.hardestQuestions.map((x) => [x.prompt.split(':')[0], x.correctRate, x.answered])).toEqual([['b', 50, 4], ['a', 75, 4]]);
    expect(stats.hardestQuestions[0]).toMatchObject({ type: 'true_false', difficulty: 'easy', averageScoreRatio: 0.5 });

    await h.http.post(`/api/v1/attempts/${marcus.id}/override`).set(await h.as('priya')).send({ scorePercent: 80, reason: 'Re-marked after the appeal panel.' }).expect(200);
    const after = (await h.http.get(`/api/v1/assessments/${a.id}/stats`).set(author.headers)).body as assessment.AssessmentStats;
    expect(after).toMatchObject({ passRate: 75, averageScorePercent: 82.5 });
  });

  it('is empty for an assessment nobody has taken and 404 for unknown ids', async () => {
    const a = await createAssessment(author, { title: 'Untaken', items: [{ kind: 'question', questionId: q.a }] });
    const stats = (await h.http.get(`/api/v1/assessments/${a.id}/stats`).set(author.headers)).body as assessment.AssessmentStats;
    expect(stats).toMatchObject({ attempts: { total: 0 }, learners: 0, passRate: null, averageScorePercent: null, medianScorePercent: null, hardestQuestions: [] });
    expect((await h.http.get('/api/v1/assessments/0190a3b2-0000-7000-8000-0000000000f5/stats').set(author.headers)).status).toBe(404);
  });
});
