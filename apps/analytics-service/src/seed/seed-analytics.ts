import { claimInbox, type InboxSchema, type Transaction } from '@a5/database';
import { applyDirectoryTeam, applyDirectoryUnit, applyDirectoryUser } from '@a5/directory';
import {
  aiEvents,
  assessmentEvents,
  buildEvent,
  certificationEvents,
  learningEvents,
  type EventDefinition,
  type EventEnvelope,
} from '@a5/events';
import {
  ASSESSMENTS,
  CERTIFICATION,
  JOURNEYS,
  ORGANIZATION,
  PEOPLE,
  PHASES,
  PROGRAM,
  RUBRIC,
  SCENARIOS,
  SEED_NOW,
  TEAMS,
  allLessons,
  completedLessonKeys,
  daysAgo,
  directoryTeams,
  directoryUnits,
  directoryUsers,
  seedId,
  type LearnerJourney,
  type PersonKey,
  type SeedScenario,
} from '@a5/seed-data';
import type { z } from 'zod';
import { stableId } from '../common/ids.js';
import type { Db, Trx } from '../database/index.js';
import { applyFactEvent } from '../facts/apply-event.js';
import { FactWriter } from '../facts/fact-writer.js';
import { localDate, refreshRollups } from '../rollups/rollup-builder.js';
import { questionResults, seedUnit as unit } from './question-bank.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Rubric categories of the seeded "A5 Objection Handling Rubric", with a typical cohort tendency. */
export const RUBRIC_CATEGORIES = [
  { key: 'rapport', label: 'Rapport & tone', bias: 4 },
  { key: 'discovery', label: 'Discovery questions', bias: -6 },
  { key: 'objection_handling', label: 'Objection handling', bias: -3 },
  { key: 'value', label: 'Value & credibility', bias: 1 },
  { key: 'next_step', label: 'Securing the next step', bias: -2 },
  { key: 'compliance', label: 'Compliance & honesty', bias: 6 },
] as const;

/**
 * Days before the seed reference time when each in-progress learner last completed a lesson.
 * A deliberate mix: most are moving, a few have gone quiet. Learners whose last lesson is an AI
 * practice take the time of that scored session instead; certified learners finish just before
 * their certificate.
 */
const LAST_LESSON_DAYS_AGO: Partial<Record<PersonKey, number>> = {
  brianna: 5,
  naomi: 2,
  marcus: 4,
  tyler: 11,
  kayla: 2,
  jordan: 9,
  isaiah: 3,
  colton: 1,
  devon: 3,
  ethan: 1,
  darius: 2,
};

const LESSONS = allLessons();
const LESSON_BY_KEY = new Map(LESSONS.map((l) => [l.key, l]));
const SCENARIO_BY_KEY = new Map(SCENARIOS.map((s) => [s.key, s]));
const MODULE_ID = new Map(PHASES.flatMap((p) => p.modules.map((m) => [m.key, m.id] as const)));
const PHASE_BY_KEY = new Map(PHASES.map((p) => [p.key, p]));
const REQUIRED_TOTAL = LESSONS.filter((l) => l.required).length;

export const enrollmentIdFor = (person: string) => seedId(`enrollment:${person}`);

/** Nominal program day of a lesson: phases are weeks, lessons spread evenly inside their week. */
function nominalDay(lessonKey: string): number {
  const lesson = LESSON_BY_KEY.get(lessonKey)!;
  const phaseIndex = PHASES.findIndex((p) => p.key === lesson.phaseKey);
  const inPhase = LESSONS.filter((l) => l.phaseKey === lesson.phaseKey);
  const i = inPhase.findIndex((l) => l.key === lessonKey);
  return 7 * phaseIndex + (7 * (i + 0.5)) / inPhase.length;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function sessionTime(person: string, index: number, ago: number): Date {
  // Seeded "days ago" counts from mid-morning Central time; sessions land during the working day.
  return new Date(daysAgo(ago).getTime() + unit(`session:${person}:${index}`) * 6 * HOUR);
}

/** First passing session for a scenario, otherwise the latest attempt at it. */
function pickSession(j: LearnerJourney, scenario: SeedScenario): number {
  const indexes = j.aiSessions
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.scenario === scenario.key);
  const passing = indexes.find(({ s }) => s.score >= scenario.passingScore);
  return passing?.i ?? indexes[indexes.length - 1]?.i ?? -1;
}

interface Timeline {
  keys: string[];
  lessonAt: Map<string, Date>;
  sessionAt: Date[];
  enrolledAt: Date;
  certifiedAt: Date | null;
}

/**
 * Completion times between enrolment and now: AI practice lessons are anchored to the matching
 * scored session, certified learners finish shortly before their first certificate, and the rest
 * is interpolated by nominal program day with a per-person pace.
 */
function timeline(j: LearnerJourney): Timeline {
  const enrolledAt = new Date(j.enrolledAt);
  const keys = completedLessonKeys(j.stage);
  const sessionAt = j.aiSessions.map((s, i) => sessionTime(j.person, i, s.daysAgo));
  const firstCert =
    j.stage === 'certified' && j.certificates?.length
      ? new Date(j.certificates[0]!.issuedAt)
      : null;
  const bound = firstCert ? firstCert.getTime() - 3 * HOUR : SEED_NOW.getTime() - 2 * HOUR;

  const knots: Array<{ x: number; t: number }> = [{ x: 0, t: enrolledAt.getTime() + 2 * HOUR }];
  const anchored = new Set<string>();
  for (const key of keys) {
    const lesson = LESSON_BY_KEY.get(key)!;
    if (lesson.type !== 'ai_simulation' || !lesson.ref) continue;
    const scenario = SCENARIO_BY_KEY.get(lesson.ref);
    if (!scenario) continue;
    const idx = pickSession(j, scenario);
    if (idx < 0) continue;
    const t = sessionAt[idx]!.getTime() + 20 * MIN;
    const last = knots[knots.length - 1]!;
    const x = nominalDay(key);
    if (x > last.x && t > last.t + HOUR && t < bound - 6 * HOUR) {
      knots.push({ x, t });
      anchored.add(key);
    }
  }
  const lastKey = keys[keys.length - 1]!;
  const xMax = nominalDay(lastKey);
  if (firstCert && xMax > knots[knots.length - 1]!.x) {
    knots.push({ x: xMax, t: bound });
    anchored.add(lastKey);
  } else if (!firstCert && !anchored.has(lastKey)) {
    const daysAgoLast = LAST_LESSON_DAYS_AGO[j.person];
    if (daysAgoLast !== undefined) {
      const t = SEED_NOW.getTime() - daysAgoLast * DAY - unit(`last:${j.person}`) * 5 * HOUR;
      const last = knots[knots.length - 1]!;
      if (xMax > last.x && t > last.t + HOUR) {
        knots.push({ x: xMax, t });
        anchored.add(lastKey);
      }
    }
  }

  const lastKnot = knots[knots.length - 1]!;
  let tailScale = (0.9 + unit(`pace:${j.person}`) * 0.6) * DAY;
  if (xMax > lastKnot.x && lastKnot.t + (xMax - lastKnot.x) * tailScale > bound) {
    tailScale = (bound - lastKnot.t) / (xMax - lastKnot.x);
  }

  const lessonAt = new Map<string, Date>();
  let previous = enrolledAt.getTime();
  for (const key of keys) {
    const x = nominalDay(key);
    let t: number;
    if (x >= lastKnot.x) {
      t = lastKnot.t + (x - lastKnot.x) * tailScale;
    } else {
      const i = knots.findIndex((k, n) => k.x <= x && (knots[n + 1]?.x ?? Infinity) >= x);
      const a = knots[i]!;
      const b = knots[i + 1]!;
      // New hires do their first lessons straight away; later ones slow down.
      const fraction = (x - a.x) / (b.x - a.x);
      t = a.t + (i === 0 ? fraction ** 0.8 : fraction) * (b.t - a.t);
    }
    if (!anchored.has(key)) t += (unit(`jitter:${j.person}:${key}`) - 0.5) * 80 * MIN;
    t = Math.min(Math.max(t, previous + 12 * MIN), firstCert ? bound : SEED_NOW.getTime() - HOUR);
    lessonAt.set(key, new Date(t));
    previous = t;
  }
  return { keys, lessonAt, sessionAt, enrolledAt, certifiedAt: firstCert };
}

/** Category scores that average exactly to the overall score. */
function categoryScores(person: string, index: number, overall: number) {
  const noise = RUBRIC_CATEGORIES.map((c) => (unit(`cat:${person}:${index}:${c.key}`) - 0.5) * 8);
  const mean = noise.reduce((s, n) => s + n, 0) / noise.length;
  const scores = RUBRIC_CATEGORIES.map((c, i) =>
    Math.max(0, Math.min(100, Math.round(overall + c.bias + noise[i]! - mean))),
  );
  let diff = overall * RUBRIC_CATEGORIES.length - scores.reduce((s, n) => s + n, 0);
  for (let i = 0; diff !== 0 && i < 100; i++) {
    const k = i % scores.length;
    const step = diff > 0 ? 1 : -1;
    if (scores[k]! + step >= 0 && scores[k]! + step <= 100) {
      scores[k] = scores[k]! + step;
      diff -= step;
    }
  }
  return RUBRIC_CATEGORIES.map((c, i) => ({ key: c.key, label: c.label, score: scores[i]! }));
}

class EventLog {
  readonly events: EventEnvelope[] = [];

  add<T extends string, S extends z.ZodType>(
    def: EventDefinition<T, S>,
    payload: z.input<S>,
    at: Date,
    idParts: string[],
    subject: { type: string; id: string } | null = null,
  ): void {
    this.events.push(
      buildEvent(def, payload, {
        id: stableId('seed-event', def.type, ...idParts),
        producer: def.producer,
        organizationId: ORGANIZATION.id,
        actor: { type: 'system', id: null },
        subject,
        occurredAt: at,
      }),
    );
  }
}

function managerOf(person: string): string {
  const team = TEAMS.find((t) => (t.members as readonly string[]).includes(person));
  const manager = team?.managers[0];
  return manager ? PEOPLE[manager].id : PEOPLE.shelby.id;
}

/** Build the domain events the other services' seeds correspond to, in chronological order. */
export function buildSeedEvents(): EventEnvelope[] {
  const log = new EventLog();
  const earliest = Math.min(...JOURNEYS.map((j) => Date.parse(j.enrolledAt)));
  const assessmentByLesson = new Map(ASSESSMENTS.map((a) => [a.lessonKey, a]));

  log.add(
    learningEvents.programPublished,
    {
      programId: PROGRAM.id,
      title: PROGRAM.title,
      version: 1,
      phases: PHASES.map((p, i) => ({ phaseId: p.id, title: p.title, position: i + 1 })),
      requiredLessonIds: LESSONS.filter((l) => l.required).map((l) => l.id),
      assessments: ASSESSMENTS.map((a) => ({
        assessmentId: a.id,
        lessonId: LESSON_BY_KEY.get(a.lessonKey)!.id,
        kind: a.kind,
        required: true,
        title: a.title,
      })),
      aiScenarios: LESSONS.filter((l) => l.type === 'ai_simulation' && l.ref).map((l) => ({
        scenarioId: SCENARIO_BY_KEY.get(l.ref!)!.id,
        lessonId: l.id,
        minScore: SCENARIO_BY_KEY.get(l.ref!)!.passingScore,
      })),
      lessons: LESSONS.map((l, i) => ({
        lessonId: l.id,
        phaseId: PHASE_BY_KEY.get(l.phaseKey)!.id,
        moduleId: MODULE_ID.get(l.moduleKey)!,
        title: l.title,
        type: l.type,
        position: i + 1,
        required: l.required,
      })),
    },
    new Date(earliest - 30 * DAY),
    [PROGRAM.id, '1'],
    { type: 'program', id: PROGRAM.id },
  );

  // Certificate numbers follow issuance order across the organization.
  const allCerts = JOURNEYS.flatMap((j) =>
    (j.certificates ?? []).map((c, i) => ({ person: j.person, i, issuedAt: c.issuedAt })),
  ).sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt));
  const certNumber = new Map(
    allCerts.map((c, n) => [
      `${c.person}:${c.i}`,
      `A5-${CERTIFICATION.code}-${c.issuedAt.slice(0, 4)}-${String(n + 1).padStart(6, '0')}`,
    ]),
  );

  for (const j of JOURNEYS) {
    const person = PEOPLE[j.person];
    const userId = person.id;
    const enrollmentId = enrollmentIdFor(j.person);
    const ref = { enrollmentId, programId: PROGRAM.id, userId };
    const tl = timeline(j);
    const dueAt = new Date(tl.enrolledAt.getTime() + PROGRAM.durationDays * DAY);
    const subject = { type: 'enrollment', id: enrollmentId };

    log.add(
      learningEvents.enrolled,
      {
        ...ref,
        programTitle: PROGRAM.title,
        assignedBy: managerOf(j.person),
        dueAt: dueAt.toISOString(),
        source: 'manual',
      },
      tl.enrolledAt,
      [enrollmentId],
      subject,
    );

    // Assessment attempts: the passing attempt grades just before the quiz lesson completes.
    const attemptTimes = new Map<string, Date[]>();
    for (const assessment of ASSESSMENTS) {
      const scores = j.attempts[assessment.key as keyof typeof j.attempts];
      if (!scores?.length) continue;
      const lessonIndex = tl.keys.indexOf(assessment.lessonKey);
      const tq =
        (
          tl.lessonAt.get(assessment.lessonKey) ?? tl.lessonAt.get(tl.keys[tl.keys.length - 1]!)!
        ).getTime() -
        5 * MIN;
      const prevKey = lessonIndex > 0 ? tl.keys[lessonIndex - 1] : undefined;
      const prev = prevKey ? tl.lessonAt.get(prevKey)!.getTime() : tl.enrolledAt.getTime();
      attemptTimes.set(
        assessment.key,
        scores.map(
          (_, i) =>
            new Date(i === scores.length - 1 ? tq : prev + ((tq - prev) * (i + 1)) / scores.length),
        ),
      );
    }

    let completed = 0;
    tl.keys.forEach((key, index) => {
      const lesson = LESSON_BY_KEY.get(key)!;
      const at = tl.lessonAt.get(key)!;
      const previous =
        index > 0 ? tl.lessonAt.get(tl.keys[index - 1]!)!.getTime() : tl.enrolledAt.getTime();
      const assessment = assessmentByLesson.get(key);
      const firstAttempt = assessment ? attemptTimes.get(assessment.key)?.[0] : undefined;
      let started = Math.max(previous + 2 * MIN, at.getTime() - lesson.minutes * 1.3 * MIN);
      if (firstAttempt)
        started = Math.max(previous + MIN, Math.min(started, firstAttempt.getTime() - 15 * MIN));
      log.add(
        learningEvents.lessonStarted,
        { ...ref, lessonId: lesson.id, lessonType: lesson.type },
        new Date(started),
        [enrollmentId, lesson.id],
      );

      if (assessment) {
        const scores = j.attempts[assessment.key as keyof typeof j.attempts] ?? [];
        scores.forEach((score, i) => {
          const attemptId = seedId(`attempt:${j.person}:${assessment.key}:${i + 1}`);
          const gradedAt = attemptTimes.get(assessment.key)![i]!;
          log.add(
            assessmentEvents.attemptGraded,
            {
              attemptId,
              assessmentId: assessment.id,
              assessmentTitle: assessment.title,
              kind: assessment.kind,
              userId,
              attemptNumber: i + 1,
              scorePercent: score,
              passed: score >= assessment.passingPercent,
              passingPercent: assessment.passingPercent,
              gradedAt: gradedAt.toISOString(),
              overridden: false,
              context: { programId: PROGRAM.id, enrollmentId, lessonId: lesson.id },
              questionResults: questionResults(assessment.key, score, attemptId),
            },
            gradedAt,
            [attemptId],
            { type: 'attempt', id: attemptId },
          );
        });
      }

      const phase = PHASE_BY_KEY.get(lesson.phaseKey)!;
      log.add(
        learningEvents.lessonCompleted,
        {
          ...ref,
          phaseId: phase.id,
          moduleId: MODULE_ID.get(lesson.moduleKey)!,
          lessonId: lesson.id,
          lessonType: lesson.type,
          lessonTitle: lesson.title,
          required: lesson.required,
          source:
            lesson.type === 'quiz' || lesson.type === 'final_assessment'
              ? 'assessment'
              : lesson.type === 'ai_simulation'
                ? 'ai_score'
                : lesson.type === 'manager_approval'
                  ? 'approval'
                  : 'learner',
          completedAt: at.toISOString(),
        },
        at,
        [enrollmentId, lesson.id],
      );
      if (lesson.required) completed += 1;
      const next = LESSONS[LESSONS.findIndex((l) => l.key === key) + 1];
      log.add(
        learningEvents.enrollmentProgressed,
        {
          ...ref,
          progressPercent: Math.round((completed / REQUIRED_TOTAL) * 1000) / 10,
          requiredCompleted: completed,
          requiredTotal: REQUIRED_TOTAL,
          currentPhaseId: next ? PHASE_BY_KEY.get(next.phaseKey)!.id : phase.id,
        },
        new Date(at.getTime() + 1000),
        [enrollmentId, 'progress', String(index)],
      );
      const phaseLessons = LESSONS.filter((l) => l.phaseKey === lesson.phaseKey);
      if (phaseLessons[phaseLessons.length - 1]!.key === key) {
        log.add(
          learningEvents.phaseCompleted,
          { ...ref, phaseId: phase.id, phaseTitle: phase.title, completedAt: at.toISOString() },
          new Date(at.getTime() + 2000),
          [enrollmentId, phase.id],
        );
      }
    });

    const lastKey = tl.keys[tl.keys.length - 1]!;
    const lastAt = tl.lessonAt.get(lastKey)!;
    if (tl.certifiedAt) {
      log.add(
        learningEvents.programCompleted,
        { ...ref, programTitle: PROGRAM.title, completedAt: lastAt.toISOString() },
        new Date(lastAt.getTime() + 3000),
        [enrollmentId],
      );
    } else {
      // The learner opened the next lesson and has not finished it yet.
      const next = LESSONS[LESSONS.findIndex((l) => l.key === lastKey) + 1];
      const startedAt = new Date(lastAt.getTime() + 30 * MIN);
      if (next && startedAt < SEED_NOW) {
        log.add(
          learningEvents.lessonStarted,
          { ...ref, lessonId: next.id, lessonType: next.type },
          startedAt,
          [enrollmentId, next.id],
        );
      }
      const overdueAt = new Date(dueAt.getTime() + HOUR);
      if (overdueAt < SEED_NOW) {
        const doneByDue = tl.keys.filter((k) => tl.lessonAt.get(k)! <= dueAt).length;
        log.add(
          learningEvents.enrollmentOverdue,
          {
            ...ref,
            programTitle: PROGRAM.title,
            dueAt: dueAt.toISOString(),
            progressPercent: Math.round((doneByDue / REQUIRED_TOTAL) * 1000) / 10,
          },
          overdueAt,
          [enrollmentId, 'overdue'],
        );
      }
    }

    // AI role-play sessions; sessions that counted toward a practice lesson carry its context.
    j.aiSessions.forEach((s, i) => {
      const scenario = SCENARIO_BY_KEY.get(s.scenario)!;
      const evaluatedAt = tl.sessionAt[i]!;
      const lesson = LESSONS.find((l) => l.type === 'ai_simulation' && l.ref === s.scenario);
      const lessonDone = lesson ? tl.lessonAt.get(lesson.key) : undefined;
      const context =
        lesson && lessonDone && evaluatedAt <= lessonDone
          ? { programId: PROGRAM.id, enrollmentId, lessonId: lesson.id }
          : {};
      const sessionId = seedId(`ai-session:${j.person}:${i + 1}`);
      log.add(
        aiEvents.scoreGenerated,
        {
          sessionId,
          scenarioId: scenario.id,
          scenarioTitle: scenario.title,
          scenarioCategory: scenario.category,
          difficulty: scenario.difficulty,
          userId,
          overallScore: s.score,
          passed: s.score >= scenario.passingScore,
          passingScore: scenario.passingScore,
          categoryScores: categoryScores(j.person, i, s.score),
          context,
          evaluatedAt: evaluatedAt.toISOString(),
          promptVersionId: seedId(`ai-prompt-version:${scenario.key}:1`),
          rubricVersionId: seedId(`ai-rubric-version:${RUBRIC.id}:1`),
        },
        evaluatedAt,
        [sessionId],
        { type: 'ai_session', id: sessionId },
      );
    });

    // Awaiting sign-off: every automatic requirement is met, the manager's approval is outstanding.
    if (j.stage === 'awaiting_approval') {
      const at = new Date(tl.lessonAt.get('w4-final')!.getTime() + 10 * MIN);
      const base = { definitionId: CERTIFICATION.id, definitionName: CERTIFICATION.name, userId };
      log.add(
        certificationEvents.eligible,
        {
          candidateId: seedId(`certification-candidate:${j.person}:${CERTIFICATION.code}`),
          ...base,
          requiresApproval: true,
        },
        at,
        [j.person, 'eligible'],
      );
      log.add(
        certificationEvents.approvalRequested,
        { approvalId: seedId(`certificate-approval:${j.person}:${CERTIFICATION.code}`), ...base },
        new Date(at.getTime() + MIN),
        [j.person, 'approval-requested'],
      );
    }

    // Certification: eligible after sign-off, then issued (and reissued / expired / revoked).
    const certs = j.certificates ?? [];
    if (certs.length) {
      const firstIssued = new Date(certs[0]!.issuedAt);
      log.add(
        certificationEvents.eligible,
        {
          candidateId: seedId(`certification-candidate:${j.person}:${CERTIFICATION.code}`),
          definitionId: CERTIFICATION.id,
          definitionName: CERTIFICATION.name,
          userId,
          requiresApproval: false,
        },
        new Date(firstIssued.getTime() - 2 * HOUR),
        [j.person, 'eligible'],
      );
    }
    certs.forEach((c, i) => {
      const certificateId = seedId(`certificate:${j.person}:${i + 1}`);
      const issuedAt = new Date(c.issuedAt);
      const expiresAt = addMonths(issuedAt, CERTIFICATION.validityMonths);
      const previous = certs[i - 1];
      const certRef = {
        certificateId,
        definitionId: CERTIFICATION.id,
        definitionName: CERTIFICATION.name,
        userId,
      };
      const certificateNumber = certNumber.get(`${j.person}:${i}`)!;
      log.add(
        certificationEvents.issued,
        {
          ...certRef,
          certificateNumber,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          mode: i === 0 ? 'automatic' : previous?.status === 'superseded' ? 'reissue' : 'renewal',
        },
        issuedAt,
        [certificateId, 'issued'],
        { type: 'certificate', id: certificateId },
      );
      if (previous?.status === 'superseded') {
        log.add(
          certificationEvents.reissued,
          {
            ...certRef,
            originalCertificateId: seedId(`certificate:${j.person}:${i}`),
            reason: previous.reissueReason ?? 'Corrected certificate details',
          },
          new Date(issuedAt.getTime() + MIN),
          [certificateId, 'reissued'],
          { type: 'certificate', id: certificateId },
        );
      }
      if (c.status === 'expired') {
        const expiredAt = expiresAt <= SEED_NOW ? expiresAt : new Date(SEED_NOW.getTime() - DAY);
        log.add(
          certificationEvents.expired,
          { ...certRef, expiredAt: expiredAt.toISOString() },
          expiredAt,
          [certificateId, 'expired'],
        );
      }
      if (c.status === 'revoked') {
        const revokedAt = new Date(
          Math.min(issuedAt.getTime() + 30 * DAY, SEED_NOW.getTime() - DAY),
        );
        log.add(
          certificationEvents.revoked,
          {
            ...certRef,
            certificateNumber,
            reason: c.revokeReason ?? 'Revoked by an administrator',
          },
          revokedAt,
          [certificateId, 'revoked'],
        );
      }
    });
  }

  return log.events.sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id),
  );
}

export interface SeedOptions {
  timezone?: string;
  log?: (line: string) => void;
}

export interface SeedResult {
  created: boolean;
  events: number;
  rollupRows: number;
}

/**
 * Seed the analytics read model for the A5 Roofing organization: directory projection, then every
 * fact derived from the shared journeys through the same writer the event consumers use, then a
 * full rollup. Idempotent: skips when the seeded enrollments exist (inbox claims also make a
 * partial re-run safe).
 */
export async function seedAnalytics(db: Db, options: SeedOptions = {}): Promise<SeedResult> {
  const log = options.log ?? (() => undefined);
  const timezone = options.timezone ?? 'America/Chicago';
  const existing = await db
    .selectFrom('fact_enrollments')
    .select('enrollment_id')
    .where('enrollment_id', '=', enrollmentIdFor(JOURNEYS[0]!.person))
    .executeTakeFirst();
  if (existing) {
    log('analytics: already seeded');
    return { created: false, events: 0, rollupRows: 0 };
  }

  const events = buildSeedEvents();
  const writer = new FactWriter({ timezone });
  await db.transaction().execute(async (trx) => {
    const dir = trx as unknown as Parameters<typeof applyDirectoryUser>[0];
    for (const unitRecord of directoryUnits()) await applyDirectoryUnit(dir, unitRecord, 1);
    for (const team of directoryTeams()) await applyDirectoryTeam(dir, team, 1);
    for (const user of directoryUsers()) await applyDirectoryUser(dir, user, 1);
    for (const event of events) {
      const claimed = await claimInbox(
        trx as unknown as Transaction<InboxSchema>,
        event.id,
        `analytics.${event.type}`,
        event.type,
      );
      if (claimed) await applyFactEvent(writer, trx as Trx, event);
    }
  });
  log(`analytics: applied ${events.length} seed events for ${JOURNEYS.length} learners`);

  const from = localDate(new Date(events[0]!.occurredAt), timezone);
  const to = localDate(SEED_NOW, timezone);
  const rollupRows = await refreshRollups(db, {
    organizationId: ORGANIZATION.id,
    from,
    to,
    timezone,
  });
  await db.deleteFrom('rollup_dirty_days').where('organization_id', '=', ORGANIZATION.id).execute();
  log(`analytics: rolled up ${rollupRows} daily metric rows (${from} → ${to})`);
  return { created: true, events: events.length, rollupRows };
}
