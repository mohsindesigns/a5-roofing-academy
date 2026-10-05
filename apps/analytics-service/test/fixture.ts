import { aiEvents, assessmentEvents, certificationEvents, learningEvents, type EventEnvelope } from '@a5/events';
import { ASSESSMENTS, CERTIFICATION, PEOPLE, PHASES, PROGRAM, SCENARIOS, allLessons, seedId, type PersonKey } from '@a5/seed-data';
import { buildSeedEvents } from '../src/seed/seed-analytics.js';
import { QUESTIONS } from '../src/seed/question-bank.js';
import { evt } from './harness.js';

/**
 * A small hand-computable dataset (reference "now": 2026-10-05T15:00Z).
 *
 * | learner | location | enrolled   | due        | state                          |
 * | ------- | -------- | ---------- | ---------- | ------------------------------ |
 * | marcus  | Dallas   | 2026-09-01 | 2026-09-29 | active, overdue, 30 %          |
 * | tyler   | Dallas   | 2026-09-01 | 2026-09-29 | completed 2026-09-20 (19.0 d)  |
 * | ashlyn  | Dallas   | 2026-08-01 | 2026-08-29 | completed 2026-08-25 (24.0 d)  |
 * | naomi   | Fort W.  | 2026-09-10 | 2026-10-08 | completed 2026-09-28 (18.0 d)  |
 * | isaiah  | Fort W.  | 2026-09-10 | 2026-10-08 | active, 50 %                   |
 */
export const NOW = new Date('2026-10-05T15:00:00Z');

const lessons = allLessons();
const lesson = (key: string) => lessons.find((l) => l.key === key)!;
const assessment = (key: string) => ASSESSMENTS.find((a) => a.key === key)!;
const scenario = (key: string) => SCENARIOS.find((s) => s.key === key)!;
const enrollmentId = (p: PersonKey) => seedId(`fixture-enrollment:${p}`);
const ref = (p: PersonKey) => ({ enrollmentId: enrollmentId(p), programId: PROGRAM.id, userId: PEOPLE[p].id });

const phase1 = PHASES[0]!;

function enroll(p: PersonKey, at: string, due: string): EventEnvelope {
  return evt(learningEvents.enrolled, { ...ref(p), programTitle: PROGRAM.title, assignedBy: null, dueAt: due, source: 'manual' }, at, `enroll:${p}`);
}

function complete(p: PersonKey, at: string): EventEnvelope {
  return evt(learningEvents.programCompleted, { ...ref(p), programTitle: PROGRAM.title, completedAt: at }, at, `complete:${p}`);
}

function progress(p: PersonKey, at: string, percent: number): EventEnvelope {
  return evt(
    learningEvents.enrollmentProgressed,
    { ...ref(p), progressPercent: percent, requiredCompleted: Math.round(percent / 10), requiredTotal: 10, currentPhaseId: phase1.id },
    at,
    `progress:${p}`,
  );
}

function lessonDone(p: PersonKey, key: string, at: string): EventEnvelope {
  const l = lesson(key);
  return evt(
    learningEvents.lessonCompleted,
    {
      ...ref(p),
      phaseId: phase1.id,
      moduleId: phase1.modules[0]!.id,
      lessonId: l.id,
      lessonType: l.type,
      lessonTitle: l.title,
      required: true,
      source: 'learner',
      completedAt: at,
    },
    at,
    `lesson:${p}:${key}`,
  );
}

function attempt(p: PersonKey, key: string, n: number, at: string, score: number, correct: Array<[number, boolean]> = []): EventEnvelope {
  const a = assessment(key);
  const attemptId = seedId(`fixture-attempt:${p}:${key}:${n}`);
  return evt(
    assessmentEvents.attemptGraded,
    {
      attemptId,
      assessmentId: a.id,
      assessmentTitle: a.title,
      kind: a.kind,
      userId: PEOPLE[p].id,
      attemptNumber: n,
      scorePercent: score,
      passed: score >= a.passingPercent,
      passingPercent: a.passingPercent,
      gradedAt: at,
      overridden: false,
      context: { programId: PROGRAM.id, enrollmentId: enrollmentId(p), lessonId: lesson(a.lessonKey).id },
      questionResults: correct.map(([number, ok]) => {
        const q = QUESTIONS[key]![number - 1]!;
        return {
          questionId: q.id,
          questionVersionId: q.versionId,
          categoryId: q.categoryId,
          categoryName: q.categoryName,
          prompt: q.prompt,
          correct: ok,
          awardedPoints: ok ? 1 : 0,
          possiblePoints: 1,
        };
      }),
    },
    at,
    `attempt:${p}:${key}:${n}`,
  );
}

function ai(p: PersonKey, key: string, n: number, at: string, overall: number): EventEnvelope {
  const s = scenario(key);
  const sessionId = seedId(`fixture-ai:${p}:${key}:${n}`);
  return evt(
    aiEvents.scoreGenerated,
    {
      sessionId,
      scenarioId: s.id,
      scenarioTitle: s.title,
      scenarioCategory: s.category,
      difficulty: s.difficulty,
      userId: PEOPLE[p].id,
      overallScore: overall,
      passed: overall >= s.passingScore,
      passingScore: s.passingScore,
      categoryScores: [
        { key: 'discovery', label: 'Discovery questions', score: overall - 10 },
        { key: 'rapport', label: 'Rapport & tone', score: overall + 10 },
      ],
      context: {},
      evaluatedAt: at,
      promptVersionId: seedId(`fixture-prompt:${key}`),
      rubricVersionId: seedId('fixture-rubric'),
    },
    at,
    `ai:${p}:${key}:${n}`,
  );
}

function eligible(p: PersonKey, at: string, requiresApproval = false): EventEnvelope {
  return evt(
    certificationEvents.eligible,
    { candidateId: seedId(`fixture-candidate:${p}`), definitionId: CERTIFICATION.id, definitionName: CERTIFICATION.name, userId: PEOPLE[p].id, requiresApproval },
    at,
    `eligible:${p}`,
  );
}

function issued(p: PersonKey, at: string, expiresAt: string, number: string): EventEnvelope {
  return evt(
    certificationEvents.issued,
    {
      certificateId: seedId(`fixture-certificate:${p}`),
      definitionId: CERTIFICATION.id,
      definitionName: CERTIFICATION.name,
      userId: PEOPLE[p].id,
      certificateNumber: number,
      issuedAt: at,
      expiresAt,
      mode: 'automatic',
    },
    at,
    `issued:${p}`,
  );
}

/** The published outline of the seeded academy (lesson titles, positions, phases). */
export function programPublished(): EventEnvelope {
  return buildSeedEvents().find((e) => e.type === 'program.published')!;
}

export function fixtureEvents(): EventEnvelope[] {
  return [
    programPublished(),
    enroll('marcus', '2026-09-01T14:00:00Z', '2026-09-29T14:00:00Z'),
    enroll('tyler', '2026-09-01T14:00:00Z', '2026-09-29T14:00:00Z'),
    enroll('ashlyn', '2026-08-01T14:00:00Z', '2026-08-29T14:00:00Z'),
    enroll('naomi', '2026-09-10T14:00:00Z', '2026-10-08T14:00:00Z'),
    enroll('isaiah', '2026-09-10T14:00:00Z', '2026-10-08T14:00:00Z'),
    // Lessons (dwell between consecutive completions; marcus and isaiah are mid-stream).
    lessonDone('marcus', 'w1-welcome', '2026-09-01T16:00:00Z'),
    lessonDone('marcus', 'w1-trust', '2026-09-02T16:00:00Z'),
    lessonDone('isaiah', 'w1-welcome', '2026-09-10T15:00:00Z'),
    lessonDone('isaiah', 'w1-trust', '2026-09-11T15:00:00Z'),
    lessonDone('isaiah', 'w1-handbook', '2026-09-12T15:00:00Z'),
    lessonDone('tyler', 'w1-welcome', '2026-09-01T15:00:00Z'),
    lessonDone('tyler', 'w1-trust', '2026-09-03T15:00:00Z'),
    progress('marcus', '2026-09-02T16:00:01Z', 30),
    progress('isaiah', '2026-09-12T15:00:01Z', 50),
    complete('tyler', '2026-09-20T14:00:00Z'),
    complete('naomi', '2026-09-28T14:00:00Z'),
    complete('ashlyn', '2026-08-25T14:00:00Z'),
    // Assessments: quiz-w1 passes at 80, the final at 85.
    attempt('marcus', 'quiz-w1', 1, '2026-09-03T10:00:00Z', 60, [[1, false], [4, false]]),
    attempt('marcus', 'quiz-w1', 2, '2026-09-04T10:00:00Z', 90, [[1, true], [4, true]]),
    attempt('tyler', 'quiz-w1', 1, '2026-09-04T11:00:00Z', 80, [[1, true], [4, true]]),
    attempt('naomi', 'quiz-w1', 1, '2026-09-14T10:00:00Z', 70, [[1, false], [4, true]]),
    attempt('tyler', 'final', 1, '2026-09-18T10:00:00Z', 88),
    attempt('naomi', 'final', 1, '2026-09-27T10:00:00Z', 100),
    attempt('ashlyn', 'final', 1, '2026-08-24T10:00:00Z', 91),
    // AI role-plays: spouse / no-time pass at 75, cheaper at 80.
    ai('marcus', 'spouse', 1, '2026-09-05T10:00:00Z', 60),
    ai('marcus', 'no-time', 1, '2026-09-06T10:00:00Z', 80),
    ai('tyler', 'spouse', 1, '2026-09-07T10:00:00Z', 70),
    ai('naomi', 'spouse', 1, '2026-09-15T10:00:00Z', 90),
    ai('naomi', 'cheaper', 1, '2026-09-16T10:00:00Z', 50),
    // Certification.
    eligible('ashlyn', '2026-08-26T14:00:00Z'),
    issued('ashlyn', '2026-08-27T14:00:00Z', '2028-08-27T14:00:00Z', 'A5-SALES-2026-000001'),
    eligible('tyler', '2026-09-21T10:00:00Z'),
    issued('tyler', '2026-09-24T10:00:00Z', '2028-09-24T10:00:00Z', 'A5-SALES-2026-000002'),
    eligible('naomi', '2026-09-29T14:00:00Z', true),
  ];
}
