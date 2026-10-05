import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { signLessonGrant, type PrincipalData } from '@a5/auth';
import type { assessment } from '@a5/contracts';
import { createDatabase, migrateToLatest, type Database } from '@a5/database';
import { createRedis, RedisNamespace, type Redis } from '@a5/messaging';
import { TEST_INTERNAL_SECRET, closeApp, createTestApp, principalHeaders, testLogger } from '@a5/nest-kit/testing';
import { getDefaultRole, widestScope, type PermissionKey, type PermissionMap, type SystemRoleKey } from '@a5/permissions';
import { PEOPLE, PROGRAM, TEAMS, TRAINER_ASSIGNMENTS, allLessons, directoryUsers, type PersonKey } from '@a5/seed-data';
import { TEST_REDIS_URL, createTestDatabase, testRedisNamespace, type TestDatabase } from '@a5/testing';
import { AppModule } from '../src/app.module.js';
import { Clock } from '../src/common/clock.js';
import { loadAssessmentConfig, type AssessmentConfig } from '../src/config.js';
import { migrations } from '../src/database/migrations/index.js';
import type { AssessmentDatabase } from '../src/database/schema.js';
import { seedAssessment } from '../src/seed/seed-assessment.js';

/** Controllable clock: tests move time forward to exercise deadlines, cooldowns and sweeps. */
export class TestClock extends Clock {
  private offsetMs = 0;

  override now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }

  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60_000);
  }
}

export interface HarnessOptions {
  /** `all` also starts the outbox relay, event consumers and the BullMQ expiry worker. */
  role?: 'api' | 'all';
  /** Seed the A5 Sales Core bank, assessments and historical attempts (default true). */
  seed?: boolean;
  env?: Record<string, string>;
}

export interface AssessmentHarness {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  db: Database<AssessmentDatabase>['db'];
  redis: Redis;
  ns: RedisNamespace;
  config: AssessmentConfig;
  clock: TestClock;
  /** Principal headers for a seeded person with the permissions their roles grant. */
  as(person: PersonKey): Promise<Record<string, string>>;
  /** Principal headers for an ad-hoc user. */
  asUser(input: { userId: string; permissions: PermissionKey[]; scope?: 'own' | 'managed' | 'organization' | 'platform'; organizationId?: string }): Promise<Record<string, string>>;
  /** Lesson grant for an assessment lesson, signed like learning-service does. */
  grantFor(person: PersonKey, assessmentId: string, lessonKey?: string, overrides?: Partial<Parameters<typeof signLessonGrant>[0]>): Promise<string>;
  close(): Promise<void>;
}

/** Permissions, scope and managed people of a seeded person, resolved like identity-service does. */
export function principalDataFor(person: PersonKey): PrincipalData {
  const p = PEOPLE[person];
  const permissions: PermissionMap = {};
  for (const roleKey of p.roles as SystemRoleKey[]) {
    const role = getDefaultRole(roleKey);
    for (const key of role.permissions) {
      const existing = permissions[key];
      permissions[key] = existing ? widestScope(existing, role.dataScope) : role.dataScope;
    }
  }
  const managedTeams = TEAMS.filter((t) => (t.managers as readonly PersonKey[]).includes(person));
  const managedUserIds = new Set<string>();
  for (const team of managedTeams) for (const member of team.members) managedUserIds.add(PEOPLE[member].id);
  for (const assignment of TRAINER_ASSIGNMENTS.filter((a) => a.trainer === person)) {
    for (const trainee of assignment.trainees) managedUserIds.add(PEOPLE[trainee].id);
  }
  return {
    userId: p.id,
    organizationId: directoryUsers().find((u) => u.id === p.id)!.organizationId,
    sessionId: null,
    displayName: `${p.firstName} ${p.lastName}`,
    roles: [...p.roles],
    permissions,
    managedTeamIds: managedTeams.map((t) => t.id),
    managedUserIds: [...managedUserIds],
  };
}

export async function createAssessmentHarness(name: string, options: HarnessOptions = {}): Promise<AssessmentHarness> {
  const tdb: TestDatabase = await createTestDatabase(`assessment_${name}`);
  const namespace = testRedisNamespace(`assessment-${name}`);
  const config = loadAssessmentConfig({
    NODE_ENV: 'test',
    DATABASE_URL: tdb.url,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_NAMESPACE: namespace,
    INTERNAL_AUTH_SECRET: TEST_INTERNAL_SECRET,
    LOG_LEVEL: 'silent',
    SERVICE_ROLE: options.role ?? 'api',
    ATTEMPT_EXPIRY_SWEEP_SECONDS: '5',
    ATTEMPT_DEADLINE_GRACE_SECONDS: '0',
    ...options.env,
  });
  const database = createDatabase<AssessmentDatabase>({ url: tdb.url, poolMax: 4 });
  await migrateToLatest(database.db as never, migrations);
  if (options.seed !== false) await seedAssessment(database.db);

  const clock = new TestClock();
  const app = await createTestApp(AppModule.register(config, testLogger(), { clock }), config);
  const redis = createRedis(TEST_REDIS_URL);
  const ns = new RedisNamespace(namespace);

  return {
    app,
    http: request(app.getHttpServer()),
    db: database.db,
    redis,
    ns,
    config,
    clock,
    as: (person) => principalHeaders(principalDataFor(person)),
    asUser: (input) =>
      principalHeaders({
        userId: input.userId,
        organizationId: input.organizationId ?? principalDataFor('priya').organizationId,
        permissions: input.permissions,
        scope: input.scope ?? 'own',
      }),
    async grantFor(person, assessmentId, lessonKey = 'w1-quiz', overrides = {}) {
      const lesson = allLessons().find((l) => l.key === lessonKey)!;
      const data = principalDataFor(person);
      return signLessonGrant(
        {
          userId: data.userId,
          organizationId: data.organizationId,
          programId: PROGRAM.id,
          enrollmentId: PEOPLE[person].id,
          lessonId: lesson.id,
          resource: { type: 'assessment', id: assessmentId },
          policy: {},
          ...overrides,
        },
        TEST_INTERNAL_SECRET,
      );
    },
    async close() {
      await closeApp(app);
      const keys = await redis.keys(`${namespace}*`);
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
      await database.destroy();
      await tdb.drop();
    },
  };
}

// ------------------------------------------------------------------ authoring helpers

type Http = ReturnType<typeof request>;
type Headers = Record<string, string>;

export interface QuestionOption {
  text: string;
  correct: boolean;
}

/** Request bodies for one question of every type, with distinctive text so tests can find them. */
export const sampleQuestions = {
  multipleChoice: (label: string, extra: Record<string, unknown> = {}) => ({
    type: 'multiple_choice',
    prompt: `${label}: which layer sits directly on the roof deck?`,
    explanation: 'Underlayment goes on the deck before the shingles.',
    points: 1,
    difficulty: 'easy',
    config: {
      options: [
        { id: 'a', text: 'Underlayment', correct: true },
        { id: 'b', text: 'Ridge cap', correct: false },
        { id: 'c', text: 'Drip edge', correct: false },
        { id: 'd', text: 'Gutter apron', correct: false },
      ],
    },
    ...extra,
  }),
  multipleSelect: (label: string, scoring: 'all_or_nothing' | 'partial', extra: Record<string, unknown> = {}) => ({
    type: 'multiple_select',
    prompt: `${label}: which of these are hail indicators?`,
    explanation: 'Soft metals dent and shingles bruise; algae is biological growth.',
    points: 4,
    difficulty: 'medium',
    config: {
      scoring,
      options: [
        { id: 'a', text: 'Dented gutters', correct: true },
        { id: 'b', text: 'Bruised shingles', correct: true },
        { id: 'c', text: 'Dented vent caps', correct: true },
        { id: 'd', text: 'Black algae streaks', correct: false },
        { id: 'e', text: 'Moss on the north slope', correct: false },
      ],
    },
    ...extra,
  }),
  trueFalse: (label: string, extra: Record<string, unknown> = {}) => ({
    type: 'true_false',
    prompt: `${label}: a contractor may waive a deductible.`,
    explanation: 'Texas prohibits contractors from waiving deductibles.',
    points: 1,
    difficulty: 'easy',
    config: { correctAnswer: false },
    ...extra,
  }),
  shortAnswer: (label: string, extra: Record<string, unknown> = {}) => ({
    type: 'short_answer',
    prompt: `${label}: how many square feet are in a roofing square?`,
    explanation: 'One roofing square covers 100 square feet.',
    points: 1,
    difficulty: 'easy',
    config: { grading: 'auto', acceptedAnswers: ['100', 'one hundred'], caseSensitive: false, normalizeWhitespace: true, maxLength: 60 },
    ...extra,
  }),
  longAnswer: (label: string, extra: Record<string, unknown> = {}) => ({
    type: 'long_answer',
    prompt: `${label}: explain recoverable depreciation to a homeowner.`,
    explanation: 'Recoverable depreciation is released after the work is completed and invoiced.',
    points: 4,
    difficulty: 'hard',
    config: { rubric: 'Look for: ACV, depreciation held back, release after final invoice.', sampleAnswer: 'The insurer holds some money back until the roof is done.', minWords: null, maxWords: 300 },
    ...extra,
  }),
  scenarioChoice: (label: string, extra: Record<string, unknown> = {}) => ({
    type: 'scenario',
    prompt: `${label}: handle the homeowner's request.`,
    explanation: 'The homeowner owns the claim.',
    points: 2,
    difficulty: 'medium',
    config: {
      scenario: 'Mrs. Patel asks you to sign her claim form for her.',
      subQuestion: {
        kind: 'multiple_choice',
        prompt: 'What do you do?',
        options: [
          { id: 'a', text: 'Decline and offer to explain each document', correct: true },
          { id: 'b', text: 'Sign it for her', correct: false },
        ],
      },
    },
    ...extra,
  }),
  scenarioOpen: (label: string, extra: Record<string, unknown> = {}) => ({
    type: 'scenario',
    prompt: `${label}: respond at the door.`,
    explanation: 'Respect the homeowner’s time and offer a low-pressure next step.',
    points: 2,
    difficulty: 'medium',
    config: {
      scenario: 'It is dinner time and the homeowner says she only has a minute.',
      subQuestion: {
        kind: 'open_response',
        prompt: 'What do you say?',
        rubric: 'Acknowledge her time, mention the storm honestly, offer to return.',
        sampleAnswer: 'I will be quick; may I come back Saturday?',
        maxLength: 800,
      },
    },
    ...extra,
  }),
  ordering: (label: string, extra: Record<string, unknown> = {}) => ({
    type: 'ordering',
    prompt: `${label}: order the claim steps.`,
    explanation: 'File, inspect, scope of loss, build, release depreciation.',
    points: 4,
    difficulty: 'medium',
    config: {
      scoring: 'partial',
      items: [
        { id: 'one', text: 'File the claim' },
        { id: 'two', text: 'Adjuster inspects' },
        { id: 'three', text: 'Scope of loss issued' },
        { id: 'four', text: 'Roof replaced' },
      ],
    },
    ...extra,
  }),
  matching: (label: string, extra: Record<string, unknown> = {}) => ({
    type: 'matching',
    prompt: `${label}: match each term with its meaning.`,
    explanation: 'ACV, RCV and the deductible come up in every claim.',
    points: 4,
    difficulty: 'medium',
    config: {
      scoring: 'partial',
      pairs: [
        { leftId: 'l1', left: 'ACV', rightId: 'r1', right: 'Replacement cost minus depreciation' },
        { leftId: 'l2', left: 'RCV', rightId: 'r2', right: 'Full cost to replace' },
        { leftId: 'l3', left: 'Deductible', rightId: 'r3', right: 'Homeowner share of a covered loss' },
        { leftId: 'l4', left: 'Supplement', rightId: 'r4', right: 'Request for items the estimate missed' },
      ],
    },
    ...extra,
  }),
} as const;

export interface Author {
  http: Http;
  headers: Headers;
}

/** Create a bank through the API. */
export async function createBank(a: Author, title: string): Promise<assessment.QuestionBankDetail> {
  const res = await a.http.post('/api/v1/question-banks').set(a.headers).send({ title, description: `${title} (test)` });
  if (res.status !== 201) throw new Error(`createBank failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Create a question through the API. */
export async function createQuestion(a: Author, bankId: string, body: Record<string, unknown>): Promise<assessment.QuestionDetail> {
  const res = await a.http.post('/api/v1/questions').set(a.headers).send({ bankId, ...body });
  if (res.status !== 201) throw new Error(`createQuestion failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Create (and by default publish) an assessment with the given items through the API. */
export async function createAssessment(
  a: Author,
  input: {
    title: string;
    kind?: assessment.AssessmentKind;
    config?: Partial<assessment.AssessmentConfig>;
    items: Array<Record<string, unknown>>;
    publish?: boolean;
  },
): Promise<assessment.AssessmentDetail> {
  const created = await a.http
    .post('/api/v1/assessments')
    .set(a.headers)
    .send({ title: input.title, kind: input.kind ?? 'quiz', config: { allowStandalone: true, ...input.config } });
  if (created.status !== 201) throw new Error(`createAssessment failed: ${created.status} ${JSON.stringify(created.body)}`);
  const items = await a.http
    .put(`/api/v1/assessments/${created.body.id}/items`)
    .set(a.headers)
    .send({ items: input.items.map((item, index) => ({ ...item, position: index + 1 })) });
  if (items.status !== 200) throw new Error(`setItems failed: ${items.status} ${JSON.stringify(items.body)}`);
  if (input.publish === false) return items.body;
  const published = await a.http.post(`/api/v1/assessments/${created.body.id}/publish`).set(a.headers);
  if (published.status !== 200) throw new Error(`publish failed: ${published.status} ${JSON.stringify(published.body)}`);
  return published.body;
}

/** The answer that earns full marks, built from the learner's view plus the author's key. */
export function correctResponse(def: assessment.QuestionDefinition): assessment.AnswerResponse {
  switch (def.type) {
    case 'multiple_choice':
      return { type: 'multiple_choice', optionId: def.config.options.find((o) => o.correct)!.id };
    case 'multiple_select':
      return { type: 'multiple_select', optionIds: def.config.options.filter((o) => o.correct).map((o) => o.id) };
    case 'true_false':
      return { type: 'true_false', value: def.config.correctAnswer };
    case 'short_answer':
      return { type: 'short_answer', text: def.config.acceptedAnswers[0] ?? 'manual answer' };
    case 'long_answer':
      return { type: 'long_answer', text: 'Recoverable depreciation is money the insurer holds back and releases after the final invoice.' };
    case 'scenario':
      return def.config.subQuestion.kind === 'multiple_choice'
        ? { type: 'scenario', optionId: def.config.subQuestion.options.find((o) => o.correct)!.id }
        : { type: 'scenario', text: 'I will be quick. Could I come back Saturday for a free inspection?' };
    case 'ordering':
      return { type: 'ordering', order: def.config.items.map((i) => i.id) };
    case 'matching':
      return { type: 'matching', matches: Object.fromEntries(def.config.pairs.map((p) => [p.leftId, p.rightId])) };
  }
}

/** An answer that is wrong for objective questions. */
export function wrongResponse(def: assessment.QuestionDefinition): assessment.AnswerResponse {
  switch (def.type) {
    case 'multiple_choice':
      return { type: 'multiple_choice', optionId: def.config.options.find((o) => !o.correct)!.id };
    case 'multiple_select':
      return { type: 'multiple_select', optionIds: [def.config.options.find((o) => !o.correct)!.id] };
    case 'true_false':
      return { type: 'true_false', value: !def.config.correctAnswer };
    case 'short_answer':
      return { type: 'short_answer', text: 'no idea' };
    case 'long_answer':
      return { type: 'long_answer', text: 'Not sure.' };
    case 'scenario':
      return def.config.subQuestion.kind === 'multiple_choice'
        ? { type: 'scenario', optionId: def.config.subQuestion.options.find((o) => !o.correct)!.id }
        : { type: 'scenario', text: 'Your insurance will pay for everything.' };
    case 'ordering':
      return { type: 'ordering', order: [...def.config.items.map((i) => i.id)].reverse() };
    case 'matching': {
      const pairs = def.config.pairs;
      return { type: 'matching', matches: Object.fromEntries(pairs.map((p, i) => [p.leftId, pairs[(i + 1) % pairs.length]!.rightId])) };
    }
  }
}

// ------------------------------------------------------------------ learner helpers

/** Prompts in the samples start with a label ("q1: ..."), which tests use to find questions. */
export function labelOf(prompt: string): string {
  return prompt.split(':')[0]!;
}

/** Question definition (type + config) from a sample request body. */
export function definitionOf(body: { type: string; config: unknown }): assessment.QuestionDefinition {
  return { type: body.type, config: body.config } as assessment.QuestionDefinition;
}

export async function saveAnswer(
  h: Pick<AssessmentHarness, 'http'>,
  headers: Headers,
  attemptId: string,
  questionId: string,
  response: assessment.AnswerResponse | null,
  clientSequence?: number,
) {
  return h.http
    .put(`/api/v1/attempts/${attemptId}/answers/${questionId}`)
    .set(headers)
    .send({ response, ...(clientSequence !== undefined && { clientSequence }) });
}

export type AnswerMode = 'right' | 'wrong' | 'skip';

/** Answer every question of an attempt using the definitions known to the test, keyed by prompt label. */
export async function answerAttempt(
  h: Pick<AssessmentHarness, 'http'>,
  headers: Headers,
  attempt: assessment.LearnerAttempt,
  defs: Record<string, assessment.QuestionDefinition>,
  mode: (label: string) => AnswerMode = () => 'right',
): Promise<void> {
  for (const q of attempt.questions) {
    const label = labelOf(q.prompt);
    const def = defs[label];
    if (!def) throw new Error(`No definition for question "${label}"`);
    const m = mode(label);
    if (m === 'skip') continue;
    const res = await saveAnswer(h, headers, attempt.id, q.id, m === 'right' ? correctResponse(def) : wrongResponse(def));
    if (res.status !== 200) throw new Error(`save failed for ${label}: ${res.status} ${JSON.stringify(res.body)}`);
  }
}
