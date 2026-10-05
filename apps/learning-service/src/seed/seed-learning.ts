import { createHash } from 'node:crypto';
import { learning } from '@a5/contracts';
import type { Insertable, Transaction } from '@a5/database';
import { applyDirectoryTeam, applyDirectoryUnit, applyDirectoryUser, type DirectorySchema } from '@a5/directory';
import type { InboxSchema } from '@a5/database';
import { EventBus, type ServiceRuntimeConfig } from '@a5/nest-kit';
import type { Rule } from '@a5/rules';
import {
  ASSESSMENTS,
  JOURNEYS,
  ORGANIZATION,
  PEOPLE,
  PHASES,
  PROGRAM,
  SCENARIOS,
  SEED_NOW,
  allLessons,
  completedLessonKeys,
  daysAgo,
  directoryTeams,
  directoryUnits,
  directoryUser,
  directoryUsers,
  seedId,
  type LearnerJourney,
  type PersonKey,
  type SeedLesson,
} from '@a5/seed-data';
import { sha256 } from '../common/text.js';
import type { Db, LearningDatabase, LessonProgressData, Trx } from '../database/index.js';
import { FactsService } from '../engine/facts.service.js';
import { ProgressService } from '../engine/progress.service.js';
import { emptyFacts, evaluateProgram, type LearnerFacts } from '../engine/progression.js';
import { loadWorkingTree } from '../engine/tree-loader.js';
import { lessonTypes } from '../lesson-types/registry.js';
import { PublishCore } from '../programs/publish-core.js';
import { ARTICLES, CODE_OF_CONDUCT, LESSON_NOTES, RIDE_ALONG_INSTRUCTIONS, RIDE_ALONG_REFLECTIONS, SIGNOFF_INSTRUCTIONS } from './content.js';

export interface LearningSeedOptions {
  log?: (line: string) => void;
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const PUBLISHED_AT = new Date('2024-10-01T15:00:00Z');
const DEFAULT_DUE_DAYS = 56;

type DirectoryTrx = Transaction<DirectorySchema & InboxSchema>;

const hashInt = (text: string): number => createHash('sha256').update(text).digest().readUInt32BE(0);
const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

// ---------------------------------------------------------------- program structure

function lessonConfig(l: SeedLesson): Record<string, unknown> {
  switch (l.type) {
    case 'video':
      return {
        mediaAssetId: seedId(`media:${l.key}`),
        // The damage-identification video sets its own, stricter minimum.
        minWatchPercent: l.key === 'w2-damage' ? 95 : null,
        allowSkipping: false,
        maxCreditedPlaybackRate: 2,
        completion: 'auto',
      };
    case 'pdf':
    case 'document':
      return { mediaAssetId: seedId(`media:${l.key}`), allowDownload: true };
    case 'quiz':
    case 'final_assessment':
      return { assessmentId: ASSESSMENTS.find((a) => a.key === l.ref)!.id };
    case 'ai_simulation':
    case 'scenario': {
      const scenario = SCENARIOS.find((s) => s.key === l.ref)!;
      return { scenarioId: scenario.id, minScore: scenario.passingScore };
    }
    case 'assignment':
      return { instructions: RIDE_ALONG_INSTRUCTIONS, minWords: 150 };
    case 'manager_approval':
      return { instructions: SIGNOFF_INSTRUCTIONS };
    case 'acknowledgment':
      return { statement: CODE_OF_CONDUCT };
    default:
      return {};
  }
}

function lessonSummary(l: SeedLesson): string {
  if (ARTICLES[l.key]) return ARTICLES[l.key]!.summary;
  if (LESSON_NOTES[l.key]) return LESSON_NOTES[l.key]!;
  switch (l.type) {
    case 'quiz':
    case 'final_assessment': {
      const a = ASSESSMENTS.find((x) => x.key === l.ref)!;
      return `${a.questionCount} questions. Score ${a.passingPercent}% or higher to pass; you can retake it if you need to.`;
    }
    case 'ai_simulation': {
      const s = SCENARIOS.find((x) => x.key === l.ref)!;
      return `Practice answering "${s.objection}" with the AI homeowner. Score ${s.passingScore} or higher to complete the lesson.`;
    }
    case 'assignment':
      return 'Reflect on a half day in the field with an experienced representative. Your trainer or manager reviews it.';
    case 'acknowledgment':
      return 'Read the A5 Sales Code of Conduct and acknowledge it by typing your full name.';
    case 'manager_approval':
      return 'Your manager confirms you are ready to work independently.';
    default:
      return l.title;
  }
}

/** Week N+1 unlocks when the Week N quiz is passed; Week 4 also needs a passing "Busy Homeowner" role-play. */
function phaseRule(index: number): Rule | null {
  if (index === 0) return null;
  const previous = PHASES[index - 1]!;
  const quizLesson = previous.modules.flatMap((m) => m.lessons).find((l) => l.type === 'quiz')!;
  const quiz = ASSESSMENTS.find((a) => a.key === quizLesson.ref)!;
  const rules: Rule[] = [{ type: 'assessment_score', assessmentId: quiz.id, minPercent: quiz.passingPercent }];
  if (index === PHASES.length - 1) {
    const busy = SCENARIOS.find((s) => s.key === 'no-time')!;
    rules.push({ type: 'ai_scenario_score', scenarioId: busy.id, minScore: busy.passingScore });
  }
  return { type: 'all', rules };
}

async function seedDirectory(trx: Trx): Promise<void> {
  const dir = trx as unknown as DirectoryTrx;
  for (const unit of directoryUnits()) await applyDirectoryUnit(dir, unit, 1);
  for (const team of directoryTeams()) await applyDirectoryTeam(dir, team, 1);
  for (const user of directoryUsers()) await applyDirectoryUser(dir, user, 1);
}

/** Fill the people/teams projection from the shared catalogue (what identity-service would publish). */
export function seedDirectoryProjection(db: Db): Promise<void> {
  return db.transaction().execute(seedDirectory);
}

async function seedProgram(trx: Trx): Promise<void> {
  const owner = PEOPLE.shelby.id;
  await trx
    .insertInto('programs')
    .values({
      id: PROGRAM.id,
      organization_id: ORGANIZATION.id,
      slug: PROGRAM.slug,
      title: PROGRAM.title,
      summary: PROGRAM.summary,
      description:
        'The A5 New Hire Sales Academy is the required onboarding path for every new sales representative. Week 1 builds your foundation in A5 standards and the customer journey. Week 2 teaches roofing systems, storm damage and the insurance claim process. Week 3 puts you in conversation with the AI homeowner to practice discovery and objections. Week 4 covers compliance, a field ride-along and the final readiness assessment, and ends with your manager’s sign-off and your A5 certification.',
      cover_media_asset_id: null,
      category: PROGRAM.category,
      owner_user_id: owner,
      status: 'draft',
      phase_label: PROGRAM.phaseLabel,
      settings: learning.programSettingsSchema.parse({
        navigationMode: 'sequential',
        allowSkipAhead: false,
        defaultMinWatchPercent: 90,
        defaultDueDays: DEFAULT_DUE_DAYS,
        inactivityAlertDays: 7,
        allowSelfEnrollment: false,
        autoEnrollAudience: true,
      }),
      estimated_minutes: null,
      duration_days: PROGRAM.durationDays,
      availability_starts_at: null,
      availability_ends_at: null,
      tags: ['onboarding', 'sales', 'new hire', 'certification'],
      published_revision: null,
      published_at: null,
      archived_at: null,
      created_by: owner,
      updated_by: owner,
      created_at: at(PUBLISHED_AT, -14 * DAY),
    })
    .execute();
  await trx.insertInto('program_audiences').values({ program_id: PROGRAM.id, kind: 'role', ref: 'sales_rep' }).execute();

  const nodeDefaults = { status: 'draft' as const, first_published_at: null, archived_at: null, created_by: owner, updated_by: owner };
  await trx
    .insertInto('program_phases')
    .values(
      PHASES.map((p, i) => ({
        id: p.id,
        program_id: PROGRAM.id,
        position: i + 1,
        title: p.title,
        summary: p.summary,
        unlock_rule: phaseRule(i),
        ...nodeDefaults,
      })),
    )
    .execute();
  await trx
    .insertInto('program_modules')
    .values(
      PHASES.flatMap((p) =>
        p.modules.map((m, i) => ({
          id: m.id,
          program_id: PROGRAM.id,
          phase_id: p.id,
          position: i + 1,
          title: m.title,
          summary: null,
          unlock_rule: null,
          ...nodeDefaults,
        })),
      ),
    )
    .execute();
  await trx
    .insertInto('lessons')
    .values(
      PHASES.flatMap((p) =>
        p.modules.flatMap((m) =>
          m.lessons.map((l, i) => ({
            id: l.id,
            organization_id: ORGANIZATION.id,
            program_id: PROGRAM.id,
            module_id: m.id,
            position: i + 1,
            type: l.type,
            title: l.title,
            summary: lessonSummary(l),
            body: ARTICLES[l.key]?.body ?? null,
            config: lessonTypes.parseConfig(l.type, lessonConfig(l)),
            is_required: l.required,
            estimated_minutes: l.minutes,
            unlock_rule: null,
            ...nodeDefaults,
          })),
        ),
      ),
    )
    .execute();
}

// ---------------------------------------------------------------- learner journeys

interface Timeline {
  completions: Map<string, Date>;
}

/**
 * Spread lesson completions between the first activity and the last one, honoring fixed anchor
 * times (AI role-plays have recorded dates). Completions stay in program order and inside working
 * hours (8am-6pm Central, expressed in UTC).
 */
function schedule(keys: string[], start: Date, end: Date, anchors: Map<string, Date>): Map<string, Date> {
  const n = keys.length;
  const points: Array<{ i: number; t: number }> = [{ i: -1, t: start.getTime() }];
  keys.forEach((key, i) => {
    const anchor = anchors.get(key);
    if (!anchor) return;
    const last = points[points.length - 1]!;
    points.push({ i, t: Math.max(anchor.getTime(), last.t + (i - last.i) * 10 * MIN) });
  });
  const tail = points[points.length - 1]!;
  if (tail.i < n - 1) points.push({ i: n - 1, t: Math.max(end.getTime(), tail.t + (n - 1 - tail.i) * 10 * MIN) });

  const out = new Map<string, Date>();
  let p = 0;
  let previous = start.getTime();
  keys.forEach((key, i) => {
    while (points[p + 1]!.i < i) p++;
    const a = points[p]!;
    const b = points[p + 1]!;
    let t = a.t + ((b.t - a.t) * (i - a.i)) / (b.i - a.i);
    if (!anchors.has(key) && i !== n - 1) {
      const day = Math.floor(t / DAY) * DAY;
      const fraction = (t - day) / DAY;
      t = day + 13 * HOUR + fraction * 10 * HOUR;
      t = Math.max(t, previous + 5 * MIN);
    }
    t = Math.round(t / MIN) * MIN;
    previous = t;
    out.set(key, new Date(t));
  });
  return out;
}

/** Last recorded activity for learners still in the program, as days before the seed date. */
const ACTIVE_DAYS_AGO: Partial<Record<PersonKey, number>> = {
  naomi: 2,
  caleb: 3,
  jasmine: 2,
  marcus: 4,
  tyler: 3,
  kayla: 2,
  jordan: 3,
  isaiah: 5,
  colton: 11,
  devon: 1,
  ethan: 2,
  darius: 5,
};

function completionSource(l: SeedLesson): learning.CompletionSource {
  switch (l.type) {
    case 'video':
      return 'video';
    case 'quiz':
    case 'final_assessment':
      return 'assessment';
    case 'ai_simulation':
    case 'scenario':
      return 'ai_score';
    case 'assignment':
    case 'manager_approval':
      return 'approval';
    case 'acknowledgment':
      return 'acknowledgment';
    default:
      return 'learner';
  }
}

const REVIEW_FEEDBACK: Record<string, string> = {
  ashlyn: 'Strong observations on discovery. Keep using the deductible wording exactly as you wrote it.',
  sofia: 'Good point about being honest on age versus hail damage. That is what builds trust at the door.',
  destiny: 'Great preparation habits. Watch the pace of your introduction, as you noted.',
  brianna: 'Clear and specific. Practice asking one discovery question at a time before your sign-off.',
};

async function seedJourney(trx: Trx, journey: LearnerJourney, tree: Awaited<ReturnType<typeof loadWorkingTree>> & object): Promise<void> {
  const person = PEOPLE[journey.person];
  const dir = directoryUser(journey.person);
  const lessons = allLessons();
  const byKey = new Map(lessons.map((l) => [l.key, l]));
  const completedKeys = new Set(completedLessonKeys(journey.stage));
  const completedOrdered = lessons.filter((l) => completedKeys.has(l.key));
  const enrolledAt = new Date(journey.enrolledAt);
  const enrollmentId = seedId(`enrollment:${PROGRAM.slug}:${journey.person}`);
  const manager = dir.managerIds[0] ?? PEOPLE.shelby.id;
  const trainer = dir.trainerIds[0] ?? null;
  const reviewer = trainer ?? manager;
  const reviewerName = (id: string) => {
    const p = Object.values(PEOPLE).find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : null;
  };

  // AI sessions: recorded dates, linked to the program's lesson when the scenario is part of it.
  const sessions = journey.aiSessions.map((s, i) => {
    const scenario = SCENARIOS.find((x) => x.key === s.scenario)!;
    const lesson = lessons.find((l) => l.type === 'ai_simulation' && l.ref === s.scenario);
    return {
      id: seedId(`aisession:${journey.person}:${i}`),
      scenario,
      lesson,
      score: s.score,
      passed: s.score >= scenario.passingScore,
      evaluatedAt: at(daysAgo(s.daysAgo), -((i * 37) % 180) * MIN),
    };
  });

  // Timeline.
  const certified = journey.stage === 'certified';
  const awaiting = journey.stage === 'awaiting_approval';
  const anchors = new Map<string, Date>();
  for (const s of sessions) {
    if (s.lesson && completedKeys.has(s.lesson.key) && s.passed && !anchors.has(s.lesson.key)) anchors.set(s.lesson.key, at(s.evaluatedAt, 8 * MIN));
  }
  const lastAnchor = Math.max(0, ...[...anchors.values()].map((d) => d.getTime()));
  const start = at(enrolledAt, (2 + (hashInt(journey.person) % 3)) * HOUR);
  let end: Date;
  if (certified) end = new Date(new Date(journey.certificates![0]!.issuedAt).getTime() - DAY);
  else if (awaiting) end = daysAgo(8);
  else end = at(daysAgo(ACTIVE_DAYS_AGO[journey.person] ?? 3), -(hashInt(journey.person) % 90) * MIN);
  if (lastAnchor) end = new Date(Math.max(end.getTime(), lastAnchor + 5 * MIN));
  const completions = schedule(
    completedOrdered.map((l) => l.key),
    start,
    end,
    anchors,
  );

  // Next lesson the learner is working on (first incomplete in program order).
  const next = lessons.find((l) => !completedKeys.has(l.key)) ?? null;
  const inProgress =
    !certified && !awaiting && next && (next.type === 'video' || next.type === 'pdf')
      ? { lesson: next, percent: next.type === 'video' ? 20 + (hashInt(`${journey.person}:${next.key}`) % 60) : 0, at: at(end, 25 * MIN) }
      : null;
  const lastActivity = inProgress ? inProgress.at : end;
  const tAt = (key: string) => completions.get(key)!;

  // Assessments.
  const attemptRows: Insertable<LearningDatabase['learner_assessment_attempts']>[] = [];
  for (const [assessmentKey, scores] of Object.entries(journey.attempts)) {
    const assessment = ASSESSMENTS.find((a) => a.key === assessmentKey)!;
    const lessonTime = completions.get(assessment.lessonKey) ?? end;
    scores!.forEach((score, i) => {
      const fromEnd = scores!.length - 1 - i;
      const gradedAt = i === scores!.length - 1 ? at(lessonTime, -3 * MIN) : new Date(Math.max(start.getTime() + HOUR, lessonTime.getTime() - fromEnd * 20 * HOUR));
      attemptRows.push({
        attempt_id: seedId(`attempt:${journey.person}:${assessmentKey}:${i + 1}`),
        organization_id: ORGANIZATION.id,
        user_id: person.id,
        assessment_id: assessment.id,
        assessment_title: assessment.title,
        kind: assessment.kind,
        attempt_number: i + 1,
        score_percent: score,
        passed: score >= assessment.passingPercent,
        passing_percent: assessment.passingPercent,
        lesson_id: byKey.get(assessment.lessonKey)!.id,
        graded_at: gradedAt,
        updated_at: gradedAt,
      });
    });
  }
  const assessmentScores = new Map<string, Insertable<LearningDatabase['learner_assessment_scores']>>();
  for (const a of [...attemptRows].sort((x, y) => x.graded_at.getTime() - y.graded_at.getTime())) {
    const row = assessmentScores.get(a.assessment_id);
    assessmentScores.set(a.assessment_id, {
      user_id: a.user_id,
      assessment_id: a.assessment_id,
      organization_id: ORGANIZATION.id,
      assessment_title: a.assessment_title,
      kind: a.kind,
      best_score: Math.max(row?.best_score ?? 0, a.score_percent),
      last_score: a.score_percent,
      passed: (row?.passed ?? false) || a.passed,
      attempts: (row?.attempts ?? 0) + 1,
      last_attempt_at: a.graded_at,
      updated_at: a.graded_at,
    });
  }
  const aiScores = new Map<string, Insertable<LearningDatabase['learner_ai_scores']>>();
  for (const s of [...sessions].sort((x, y) => x.evaluatedAt.getTime() - y.evaluatedAt.getTime())) {
    const row = aiScores.get(s.scenario.id);
    aiScores.set(s.scenario.id, {
      user_id: person.id,
      scenario_id: s.scenario.id,
      organization_id: ORGANIZATION.id,
      scenario_title: s.scenario.title,
      best_score: Math.max(row?.best_score ?? 0, s.score),
      last_score: s.score,
      passed: (row?.passed ?? false) || s.passed,
      sessions: (row?.sessions ?? 0) + 1,
      last_session_at: s.evaluatedAt,
      updated_at: s.evaluatedAt,
    });
  }

  // Lesson progress.
  const progressRows: Insertable<LearningDatabase['lesson_progress']>[] = [];
  const phaseDone = new Map<string, Date>();
  let previous = start;
  for (const l of completedOrdered) {
    const completedAt = tAt(l.key);
    const lessonStart = new Date(Math.max(previous.getTime() + MIN, completedAt.getTime() - Math.max(l.minutes, 3) * MIN));
    const decider = l.type === 'manager_approval' ? manager : l.type === 'assignment' ? reviewer : null;
    const data: LessonProgressData = {};
    if (l.type === 'video') data.watchedPercent = 92 + (hashInt(`${journey.person}:${l.key}`) % 9);
    if (l.type === 'quiz' || l.type === 'final_assessment') {
      const assessment = ASSESSMENTS.find((a) => a.key === l.ref)!;
      const score = assessmentScores.get(assessment.id)!;
      data.bestScore = score.best_score;
      data.lastScore = score.last_score;
      data.attemptId = seedId(`attempt:${journey.person}:${assessment.key}:${score.attempts}`);
    }
    if (l.type === 'ai_simulation') {
      const scenario = SCENARIOS.find((s) => s.key === l.ref)!;
      const score = aiScores.get(scenario.id)!;
      data.bestScore = score.best_score;
      data.lastScore = score.last_score;
      data.sessionId = sessions.find((s) => s.scenario.id === scenario.id && s.passed)?.id;
    }
    progressRows.push({
      id: seedId(`progress:${journey.person}:${l.key}`),
      enrollment_id: enrollmentId,
      lesson_id: l.id,
      user_id: person.id,
      status: 'completed',
      percent: 100,
      started_at: lessonStart,
      completed_at: completedAt,
      completion_source: completionSource(l),
      completed_by: decider,
      data,
      created_at: lessonStart,
      updated_at: completedAt,
    });
    previous = completedAt;
  }
  if (inProgress) {
    progressRows.push({
      id: seedId(`progress:${journey.person}:${inProgress.lesson.key}`),
      enrollment_id: enrollmentId,
      lesson_id: inProgress.lesson.id,
      user_id: person.id,
      status: 'in_progress',
      percent: inProgress.percent,
      started_at: inProgress.at,
      completed_at: null,
      completion_source: null,
      completed_by: null,
      data: inProgress.lesson.type === 'video' ? { watchedPercent: inProgress.percent } : {},
      created_at: inProgress.at,
      updated_at: inProgress.at,
    });
  }

  // Phase completions: when the last required lesson of a phase finished.
  const phaseRows: Insertable<LearningDatabase['phase_completions']>[] = [];
  for (const phase of PHASES) {
    const required = phase.modules.flatMap((m) => m.lessons).filter((l) => l.required);
    if (required.every((l) => completedKeys.has(l.key))) {
      const when = new Date(Math.max(...required.map((l) => tAt(l.key).getTime())));
      phaseDone.set(phase.id, when);
      phaseRows.push({ enrollment_id: enrollmentId, phase_id: phase.id, completed_at: when });
    }
  }

  // Denormalised progress comes from the same evaluator the API uses.
  const facts: LearnerFacts = emptyFacts(SEED_NOW);
  facts.enrolledAt = enrolledAt;
  for (const row of progressRows) {
    facts.progress.set(row.lesson_id, {
      status: row.status,
      percent: row.percent ?? 0,
      startedAt: row.started_at ?? null,
      completedAt: row.completed_at ?? null,
      source: row.completion_source ?? null,
      data: row.data ?? {},
    });
  }
  for (const s of assessmentScores.values()) {
    facts.assessmentScores.set(s.assessment_id, {
      bestScore: s.best_score,
      lastScore: s.last_score,
      passed: s.passed,
      attempts: s.attempts,
      title: s.assessment_title,
      kind: s.kind,
      lastAt: s.last_attempt_at,
    });
  }
  for (const s of aiScores.values()) {
    facts.aiScores.set(s.scenario_id, {
      bestScore: s.best_score,
      lastScore: s.last_score,
      passed: s.passed,
      attempts: s.sessions,
      title: s.scenario_title,
      lastAt: s.last_session_at,
    });
  }
  facts.aiSessions = [...sessions].sort((a, b) => b.evaluatedAt.getTime() - a.evaluatedAt.getTime()).map((s) => ({ scenarioId: s.scenario.id, score: s.score }));
  if (completedKeys.has('w4-signoff')) facts.approvals.add('manager');
  for (const [phaseId, when] of phaseDone) facts.phaseCompletedAt.set(phaseId, when);
  const ev = evaluateProgram(tree, facts);

  await trx
    .insertInto('enrollments')
    .values({
      id: enrollmentId,
      organization_id: ORGANIZATION.id,
      program_id: PROGRAM.id,
      user_id: person.id,
      status: certified ? 'completed' : 'active',
      source: 'manual',
      assigned_by: PEOPLE.shelby.id,
      enrolled_at: enrolledAt,
      due_at: at(enrolledAt, DEFAULT_DUE_DAYS * DAY),
      started_at: start,
      completed_at: certified ? end : null,
      withdrawn_at: null,
      withdrawn_by: null,
      withdrawal_reason: null,
      progress_percent: ev.percent,
      required_total: ev.requiredTotal,
      required_completed: ev.requiredCompleted,
      current_lesson_id: ev.currentLesson?.lesson.id ?? null,
      current_phase_id: ev.currentPhase?.phase.id ?? null,
      last_activity_at: lastActivity,
      created_at: enrolledAt,
      updated_at: lastActivity,
    })
    .execute();
  if (progressRows.length) await trx.insertInto('lesson_progress').values(progressRows).execute();
  if (phaseRows.length) await trx.insertInto('phase_completions').values(phaseRows).execute();
  if (attemptRows.length) await trx.insertInto('learner_assessment_attempts').values(attemptRows).execute();
  if (assessmentScores.size) await trx.insertInto('learner_assessment_scores').values([...assessmentScores.values()]).execute();
  if (sessions.length) {
    await trx
      .insertInto('learner_ai_sessions')
      .values(
        sessions.map((s) => ({
          session_id: s.id,
          organization_id: ORGANIZATION.id,
          user_id: person.id,
          scenario_id: s.scenario.id,
          scenario_title: s.scenario.title,
          score: s.score,
          passed: s.passed,
          passing_score: s.scenario.passingScore,
          lesson_id: s.lesson?.id ?? null,
          evaluated_at: s.evaluatedAt,
          updated_at: s.evaluatedAt,
        })),
      )
      .execute();
  }
  if (aiScores.size) await trx.insertInto('learner_ai_scores').values([...aiScores.values()]).execute();

  // Code of conduct acknowledgment.
  if (completedKeys.has('w1-handbook')) {
    await trx
      .insertInto('acknowledgments')
      .values({
        id: seedId(`ack:${journey.person}:w1-handbook`),
        organization_id: ORGANIZATION.id,
        user_id: person.id,
        enrollment_id: enrollmentId,
        lesson_id: byKey.get('w1-handbook')!.id,
        statement_hash: sha256(CODE_OF_CONDUCT),
        statement_text: CODE_OF_CONDUCT,
        typed_name: `${person.firstName} ${person.lastName}`,
        ip: null,
        user_agent: null,
        acknowledged_at: tAt('w1-handbook'),
      })
      .execute();
  }

  // Ride-along reflection and its review.
  if (completedKeys.has('w4-ridealong')) {
    const decidedAt = tAt('w4-ridealong');
    const prior = tAt('w4-compliance');
    const submittedAt = new Date(Math.max(prior.getTime() + HOUR, decidedAt.getTime() - Math.min(20 * HOUR, (decidedAt.getTime() - prior.getTime()) / 2)));
    const body = RIDE_ALONG_REFLECTIONS[journey.person]!;
    const submissionId = seedId(`submission:${journey.person}:w4-ridealong`);
    await trx
      .insertInto('assignment_submissions')
      .values({
        id: submissionId,
        organization_id: ORGANIZATION.id,
        user_id: person.id,
        enrollment_id: enrollmentId,
        lesson_id: byKey.get('w4-ridealong')!.id,
        body,
        word_count: body.trim().split(/\s+/).length,
        status: 'approved',
        submitted_at: submittedAt,
        reviewed_by: reviewer,
        reviewed_by_name: reviewerName(reviewer),
        reviewed_at: decidedAt,
        feedback: REVIEW_FEEDBACK[journey.person] ?? null,
      })
      .execute();
    await trx
      .insertInto('approval_requests')
      .values({
        id: seedId(`approval:${journey.person}:w4-ridealong`),
        organization_id: ORGANIZATION.id,
        kind: 'assignment_review',
        status: 'approved',
        enrollment_id: enrollmentId,
        program_id: PROGRAM.id,
        lesson_id: byKey.get('w4-ridealong')!.id,
        user_id: person.id,
        submission_id: submissionId,
        request_note: null,
        requested_at: submittedAt,
        decided_by: reviewer,
        decided_by_name: reviewerName(reviewer),
        decided_at: decidedAt,
        comment: REVIEW_FEEDBACK[journey.person] ?? null,
        created_at: submittedAt,
        updated_at: decidedAt,
      })
      .execute();
  }

  // Manager sign-off: approved for certified learners, waiting for the manager otherwise.
  if (certified || awaiting) {
    const finalDone = tAt('w4-final');
    const requestedAt = at(finalDone, MIN);
    const decided = certified ? tAt('w4-signoff') : null;
    await trx
      .insertInto('approval_requests')
      .values({
        id: seedId(`approval:${journey.person}:w4-signoff`),
        organization_id: ORGANIZATION.id,
        kind: 'manager_approval',
        status: certified ? 'approved' : 'pending',
        enrollment_id: enrollmentId,
        program_id: PROGRAM.id,
        lesson_id: byKey.get('w4-signoff')!.id,
        user_id: person.id,
        submission_id: null,
        request_note: null,
        requested_at: requestedAt,
        decided_by: certified ? manager : null,
        decided_by_name: certified ? reviewerName(manager) : null,
        decided_at: decided,
        comment: certified ? 'Field-ready. Clean paperwork, strong discovery and consistent compliance language.' : null,
        created_at: requestedAt,
        updated_at: decided ?? requestedAt,
      })
      .execute();
  }
}

/**
 * Seed the A5 New Hire Sales Academy: directory projection, the program (published through the same
 * code path as the API), enrollments and history for every journey in @a5/seed-data, score
 * projections, acknowledgments and approvals. Idempotent: does nothing when the program exists.
 */
export async function seedLearning(db: Db, options: LearningSeedOptions = {}): Promise<{ created: boolean }> {
  const log = options.log ?? (() => undefined);
  await seedDirectoryProjection(db);
  const existing = await db.selectFrom('programs').select('id').where('id', '=', PROGRAM.id).executeTakeFirst();
  if (existing) {
    log('learning: academy already seeded');
    return { created: false };
  }

  const events = new EventBus({ serviceName: 'learning-service' } as ServiceRuntimeConfig);
  const publisher = new PublishCore(events, new ProgressService(events, new FactsService()));

  await db.transaction().execute(async (trx) => {
    await seedProgram(trx);
    const version = await publisher.publish(trx, {
      organizationId: ORGANIZATION.id,
      programId: PROGRAM.id,
      changeNote: 'Initial publication of the A5 New Hire Sales Academy.',
      actor: { userId: PEOPLE.shelby.id, displayName: `${PEOPLE.shelby.firstName} ${PEOPLE.shelby.lastName}` },
      at: PUBLISHED_AT,
    });
    const tree = { ...(await loadWorkingTree(trx, PROGRAM.id))!, version };
    for (const journey of JOURNEYS) await seedJourney(trx, journey, tree);
  });
  log(`learning: seeded ${PROGRAM.title} with ${JOURNEYS.length} enrollments`);
  return { created: true };
}
