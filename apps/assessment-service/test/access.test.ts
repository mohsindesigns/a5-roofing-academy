import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRINCIPAL_HEADER } from '@a5/auth';
import { principalHeaders } from '@a5/nest-kit/testing';
import { ASSESSMENTS, QUESTION_BANK } from '@a5/seed-data';
import { createAssessmentHarness, principalDataFor, type AssessmentHarness } from './harness.js';

let h: AssessmentHarness;
const UUID = '0190a3b2-0000-7000-8000-0000000000a0';

beforeAll(async () => {
  h = await createAssessmentHarness('access');
});
afterAll(() => h?.close());

type Call = [method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: unknown];

const quizId = ASSESSMENTS[0]!.id;
const adminCalls: Call[] = [
  ['get', '/api/v1/question-banks'],
  ['post', '/api/v1/question-banks', { title: 'Rogue bank' }],
  ['get', `/api/v1/question-banks/${QUESTION_BANK.id}`],
  ['patch', `/api/v1/question-banks/${QUESTION_BANK.id}`, { title: 'Hijacked' }],
  ['post', `/api/v1/question-banks/${QUESTION_BANK.id}/archive`],
  ['delete', `/api/v1/question-banks/${QUESTION_BANK.id}`],
  ['get', `/api/v1/question-banks/${QUESTION_BANK.id}/categories`],
  ['post', `/api/v1/question-banks/${QUESTION_BANK.id}/categories`, { name: 'Rogue' }],
  ['get', `/api/v1/question-banks/${QUESTION_BANK.id}/competencies`],
  ['get', '/api/v1/questions'],
  [
    'post',
    '/api/v1/questions',
    { bankId: QUESTION_BANK.id, type: 'true_false', prompt: 'x', config: { correctAnswer: true } },
  ],
  ['get', `/api/v1/questions/${UUID}`],
  ['put', `/api/v1/questions/${UUID}`, {}],
  ['get', `/api/v1/questions/${UUID}/versions`],
  ['get', `/api/v1/questions/${UUID}/preview`],
  ['post', `/api/v1/questions/${UUID}/archive`],
  ['get', '/api/v1/assessments'],
  ['post', '/api/v1/assessments', { title: 'Rogue quiz' }],
  ['get', `/api/v1/assessments/${quizId}`],
  ['patch', `/api/v1/assessments/${quizId}`, { title: 'Hijacked' }],
  ['delete', `/api/v1/assessments/${quizId}`],
  ['post', `/api/v1/assessments/${quizId}/publish`],
  ['post', `/api/v1/assessments/${quizId}/preview`],
  ['get', `/api/v1/assessments/${quizId}/stats`],
  ['get', `/api/v1/assessments/${quizId}/validation`],
  ['put', `/api/v1/assessments/${quizId}/items`, { items: [] }],
];
const reviewCalls: Call[] = [
  ['get', '/api/v1/attempts'],
  ['get', `/api/v1/attempts/${UUID}/review`],
  ['post', `/api/v1/attempts/${UUID}/grades`, { grades: [] }],
  [
    'post',
    `/api/v1/attempts/${UUID}/override`,
    { scorePercent: 90, reason: 'A long enough reason.' },
  ],
];

async function status(
  headers: Record<string, string>,
  [method, path, body]: Call,
): Promise<number> {
  const req = h.http[method](path).set(headers);
  return (body === undefined ? req : req.send(body as object)).then((r) => r.status);
}

describe('sales representatives', () => {
  it('cannot open any administrative or review API', async () => {
    const rep = await h.as('marcus');
    for (const call of [...adminCalls, ...reviewCalls]) {
      expect(await status(rep, call), `${call[0].toUpperCase()} ${call[1]}`).toBe(403);
    }
  });

  it('get a clear permission error', async () => {
    const res = await h.http.get('/api/v1/question-banks').set(await h.as('marcus'));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission to perform this action.',
      details: { required: ['assessments.view'] },
    });
  });

  it('can use the learner APIs', async () => {
    const rep = await h.as('marcus');
    expect((await h.http.get('/api/v1/attempts/mine').set(rep)).status).toBe(200);
    const intro = await h.http.get(`/api/v1/assessments/${quizId}/intro`).set(rep);
    expect(intro.status).toBe(403); // lesson grant required: the seeded quiz is not open for standalone attempts
    expect(intro.body.error.code).toBe('STANDALONE_NOT_ALLOWED');
    const withGrant = await h.http
      .get(`/api/v1/assessments/${quizId}/intro`)
      .query({ grant: await h.grantFor('marcus', quizId) })
      .set(rep);
    expect(withGrant.status).toBe(200);
    expect(withGrant.body.assessment).toMatchObject({
      title: 'Week 1 Knowledge Check',
      passingPercent: 80,
      maxAttempts: 3,
      timeLimitSeconds: 1200,
    });
  });
});

describe('managers', () => {
  it('can review their people but not author questions or assessments', async () => {
    const manager = await h.as('danielle');
    for (const call of adminCalls)
      expect(await status(manager, call), `${call[0].toUpperCase()} ${call[1]}`).toBe(403);
    expect((await h.http.get('/api/v1/attempts').set(manager)).status).toBe(200);
    expect(await status(manager, reviewCalls[2]!)).toBe(403); // cannot grade
    expect(await status(manager, reviewCalls[3]!)).toBe(403); // cannot override
  });
});

describe('trainers', () => {
  it('can read the question bank and grade, but not author or override', async () => {
    const trainer = await h.as('hector');
    expect((await h.http.get('/api/v1/question-banks').set(trainer)).status).toBe(200);
    expect((await h.http.get('/api/v1/assessments').set(trainer)).status).toBe(200);
    expect(
      (await h.http.post('/api/v1/question-banks').set(trainer).send({ title: 'Trainer bank' }))
        .status,
    ).toBe(403);
    expect(
      (await h.http.post('/api/v1/assessments').set(trainer).send({ title: 'Trainer quiz' }))
        .status,
    ).toBe(403);
    expect(
      (await h.http.patch(`/api/v1/assessments/${quizId}`).set(trainer).send({ title: 'x' }))
        .status,
    ).toBe(403);
    expect(await status(trainer, reviewCalls[3]!)).toBe(403);
    expect(
      await status(trainer, [
        'post',
        `/api/v1/attempts/${UUID}/grades`,
        { grades: [{ attemptQuestionId: UUID, awardedPoints: 1 }] },
      ]),
    ).toBe(404);
  });
});

describe('auditors', () => {
  it('can read everything in the library and every attempt but change nothing and take nothing', async () => {
    const auditor = await h.as('ruth');
    expect((await h.http.get('/api/v1/question-banks').set(auditor)).status).toBe(200);
    expect((await h.http.get(`/api/v1/assessments/${quizId}/stats`).set(auditor)).status).toBe(200);
    expect((await h.http.get('/api/v1/attempts').set(auditor)).status).toBe(200);
    expect(
      (await h.http.post('/api/v1/question-banks').set(auditor).send({ title: 'Audit bank' }))
        .status,
    ).toBe(403);
    expect((await h.http.post(`/api/v1/assessments/${quizId}/publish`).set(auditor)).status).toBe(
      403,
    );
    expect(
      (await h.http.post('/api/v1/attempts').set(auditor).send({ assessmentId: quizId })).status,
    ).toBe(403);
    expect((await h.http.get('/api/v1/attempts/mine').set(auditor)).status).toBe(403);
  });
});

describe('administrators', () => {
  it('training administrators author content', async () => {
    const trainingAdmin = await h.as('shelby');
    const bank = await h.http
      .post('/api/v1/question-banks')
      .set(trainingAdmin)
      .send({ title: 'Training admin bank' });
    expect(bank.status).toBe(201);
    expect(
      (
        await h.http
          .post('/api/v1/assessments')
          .set(trainingAdmin)
          .send({ title: 'Training admin quiz' })
      ).status,
    ).toBe(201);
  });

  it('administrators can override scores; training administrators cannot', async () => {
    const attempts = await h.http
      .get('/api/v1/attempts')
      .query({ status: 'graded', pageSize: '1' })
      .set(await h.as('priya'));
    const id = attempts.body.items[0].id as string;
    const body = {
      scorePercent: 12,
      reason: 'Access test: policy allows administrators to override.',
    };
    expect(
      (
        await h.http
          .post(`/api/v1/attempts/${id}/override`)
          .set(await h.as('shelby'))
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (
        await h.http
          .post(`/api/v1/attempts/${id}/override`)
          .set(await h.as('grant'))
          .send(body)
      ).status,
    ).toBe(200);
  });
});

describe('authentication', () => {
  it('requires a principal', async () => {
    expect((await h.http.get('/api/v1/question-banks')).status).toBe(401);
    expect((await h.http.get('/api/v1/attempts/mine')).status).toBe(401);
    const forged = await h.http.get('/api/v1/question-banks').set(PRINCIPAL_HEADER, 'not-a-token');
    expect(forged.status).toBe(401);
    const wrongSecret = await principalHeaders(
      principalDataFor('priya'),
      'a-different-secret-0123456789abcdef0123456789',
    );
    expect((await h.http.get('/api/v1/question-banks').set(wrongSecret)).status).toBe(401);
  });

  it('keeps organizations apart', async () => {
    const outsider = await h.asUser({
      userId: '0190a3b2-0000-7000-8000-0000000000b1',
      organizationId: '0190a3b2-0000-7000-8000-0000000000b2',
      permissions: ['assessments.view', 'assessment_attempts.view', 'assessments.take'],
      scope: 'organization',
    });
    expect((await h.http.get('/api/v1/question-banks').set(outsider)).body.total).toBe(0);
    expect((await h.http.get('/api/v1/assessments').set(outsider)).body.total).toBe(0);
    expect((await h.http.get('/api/v1/attempts').set(outsider)).body.total).toBe(0);
    expect((await h.http.get(`/api/v1/assessments/${quizId}`).set(outsider)).status).toBe(404);
    const standalone = await h.http
      .post('/api/v1/attempts')
      .set(outsider)
      .send({ assessmentId: quizId });
    expect(standalone.status).toBe(404);
  });

  it('platform administrators are still limited to their own organization’s data in this service', async () => {
    const outsider = await h.asUser({
      userId: '0190a3b2-0000-7000-8000-0000000000b3',
      organizationId: '0190a3b2-0000-7000-8000-0000000000b4',
      permissions: ['assessments.view', 'assessment_attempts.view'],
      scope: 'platform',
    });
    expect(
      (await h.http.get(`/api/v1/question-banks/${QUESTION_BANK.id}`).set(outsider)).status,
    ).toBe(404);
  });

  it('rejects malformed identifiers and bodies with a validation error', async () => {
    const admin = await h.as('priya');
    const badId = await h.http.get('/api/v1/assessments/not-a-uuid').set(admin);
    expect(badId.status).toBe(400);
    expect(badId.body.error.code).toBe('VALIDATION_FAILED');
    const badBody = await h.http
      .post('/api/v1/assessments')
      .set(admin)
      .send({ title: 'x', config: { passingPercent: 'high' } });
    expect(badBody.status).toBe(400);
    expect(badBody.body.error.fields.length).toBeGreaterThan(0);
    const malformed = await h.http
      .post('/api/v1/assessments')
      .set(admin)
      .set('content-type', 'application/json')
      .send('{"title":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('MALFORMED_JSON');
  });
});

describe('API documentation', () => {
  it('describes every route through its Zod contracts', () => {
    const config = new DocumentBuilder()
      .setTitle('Assessment')
      .setVersion('1')
      .addApiKey({ type: 'apiKey', in: 'header', name: 'x-a5-principal' }, 'principal')
      .build();
    const document = SwaggerModule.createDocument(h.app, config);
    const operations = Object.entries(document.paths).flatMap(([path, item]) =>
      (['get', 'post', 'put', 'patch', 'delete'] as const).flatMap((method) =>
        item?.[method] ? [{ path, method, op: item[method]! }] : [],
      ),
    );
    const api = operations.filter((o) => o.path.startsWith('/api/v1/'));
    // 15 bank/category/competency + 9 question + 15 assessment + 1 intro + 6 learner attempt + 4 review routes.
    expect(api).toHaveLength(50);
    for (const { path, method, op } of api) {
      const responses = Object.values(op.responses ?? {}) as Array<{
        content?: Record<string, { schema?: unknown }>;
      }>;
      const described = responses.some((r) => r.content?.['application/json']?.schema);
      expect(described, `${method.toUpperCase()} ${path} documents its response`).toBe(true);
      if (
        ['post', 'put', 'patch'].includes(method) &&
        !/\/(archive|restore|publish|submit|preview)$/.test(path)
      ) {
        expect(
          op.requestBody,
          `${method.toUpperCase()} ${path} documents its request body`,
        ).toBeTruthy();
      }
    }
    const prefixes = [
      '/api/v1/question-banks',
      '/api/v1/questions',
      '/api/v1/assessments',
      '/api/v1/attempts',
    ];
    for (const prefix of prefixes)
      expect(
        api.some((o) => o.path.startsWith(prefix)),
        prefix,
      ).toBe(true);
    // Every route lives under one of the gateway prefixes assigned to this service.
    expect(api.every((o) => prefixes.some((p) => o.path.startsWith(p)))).toBe(true);
  });
});
