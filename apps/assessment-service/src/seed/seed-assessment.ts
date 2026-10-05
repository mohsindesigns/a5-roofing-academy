import { applyDirectoryTeam, applyDirectoryUnit, applyDirectoryUser } from '@a5/directory';
import {
  ASSESSMENTS,
  JOURNEYS,
  ORGANIZATION,
  PEOPLE,
  PROGRAM,
  QUESTION_BANK,
  SEED_NOW,
  allLessons,
  directoryTeams,
  directoryUnits,
  directoryUsers,
  seedId,
  type LearnerJourney,
  type PersonKey,
  type SeedAssessment,
} from '@a5/seed-data';
import type { Db, Trx } from '../database/index.js';
import { AttemptEngine, type EventSink } from '../engine/attempt-engine.js';
import { drawQuestions } from '../engine/draw.js';
import { seededRng } from '../engine/random.js';
import { ASSESSMENT_DEFINITIONS } from './content/assessments.js';
import { materialize } from './content/drafts.js';
import { CATEGORIES, COMPETENCIES, QUESTIONS, type SeedQuestion } from './content/question-bank.js';
import { answerOptions, chooseAnswers } from './learner-answers.js';

export interface SeedOptions {
  log?: (line: string) => void;
}

/** Content authors created the bank before the first seeded learner enrolled (2024-10-21). */
const AUTHORED_AT = new Date('2024-09-02T15:00:00Z');
const PUBLISHED_AT = new Date('2024-09-16T15:00:00Z');
const AUTHOR = PEOPLE.shelby;

export const seedIds = {
  category: (key: string) => seedId(`question-category:${key}`),
  competency: (key: string) => seedId(`competency:${key}`),
  question: (key: string) => seedId(`question:${key}`),
  questionVersion: (key: string) => seedId(`question-version:${key}:1`),
  item: (assessmentKey: string, position: number) => seedId(`assessment-item:${assessmentKey}:${position}`),
  attempt: (person: string, assessmentKey: string, number: number) => seedId(`attempt:${person}:${assessmentKey}:${number}`),
};

/** Historical attempts are written without events: other services seed their own projections. */
const silent: EventSink = { emit: async () => undefined };

/** Days after enrollment a learner typically takes each assessment (end of the matching week). */
const DAYS_AFTER_ENROLLMENT: Record<string, number> = { 'quiz-w1': 4, 'quiz-w2': 11, 'quiz-w3': 18, final: 25 };

function hash(input: string): number {
  return seededRng(input).next();
}

function attemptTimes(journey: LearnerJourney, assessmentKey: string, index: number, timeLimitSeconds: number | null) {
  const enrolled = new Date(journey.enrolledAt).getTime();
  const key = `${journey.person}:${assessmentKey}:${index}`;
  const dayOffset = (DAYS_AFTER_ENROLLMENT[assessmentKey] ?? 5) + index * (assessmentKey === 'final' ? 2 : 1);
  // Business hours in Central Time, expressed in UTC.
  const start = new Date(enrolled + dayOffset * 86_400_000 + Math.floor(hash(`${key}:hour`) * 6) * 3_600_000 + Math.floor(hash(`${key}:minute`) * 60) * 60_000);
  const limit = timeLimitSeconds ?? 1_800;
  const durationMs = Math.round(limit * (0.3 + hash(`${key}:duration`) * 0.45)) * 1000;
  let startedAt = start;
  if (startedAt.getTime() + durationMs > SEED_NOW.getTime() - 3_600_000) {
    startedAt = new Date(SEED_NOW.getTime() - 3_600_000 - durationMs - index * 86_400_000);
  }
  return { startedAt, submittedAt: new Date(startedAt.getTime() + durationMs) };
}

async function seedDirectory(db: Db): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const unit of directoryUnits()) await applyDirectoryUnit(trx, unit, 1);
    for (const team of directoryTeams()) await applyDirectoryTeam(trx, team, 1);
    for (const user of directoryUsers()) await applyDirectoryUser(trx, user, 1);
  });
}

async function seedQuestionBank(trx: Trx): Promise<Map<string, SeedQuestion>> {
  await trx
    .insertInto('question_banks')
    .values({
      id: QUESTION_BANK.id,
      organization_id: ORGANIZATION.id,
      title: QUESTION_BANK.title,
      description:
        'The questions behind the A5 New Hire Sales Academy: company standards, roofing systems, storm damage, the insurance process, the sales conversation, objection handling and compliance.',
      archived_at: null,
      created_at: AUTHORED_AT,
      updated_at: AUTHORED_AT,
      created_by: AUTHOR.id,
      updated_by: AUTHOR.id,
    })
    .execute();
  await trx
    .insertInto('question_categories')
    .values(
      CATEGORIES.map((c, position) => ({
        id: seedIds.category(c.key),
        organization_id: ORGANIZATION.id,
        bank_id: QUESTION_BANK.id,
        name: c.name,
        description: c.description,
        position,
        created_at: AUTHORED_AT,
        updated_at: AUTHORED_AT,
      })),
    )
    .execute();
  await trx
    .insertInto('competencies')
    .values(
      COMPETENCIES.map((c) => ({
        id: seedIds.competency(c.key),
        organization_id: ORGANIZATION.id,
        bank_id: QUESTION_BANK.id,
        name: c.name,
        description: c.description,
        created_at: AUTHORED_AT,
        updated_at: AUTHORED_AT,
      })),
    )
    .execute();

  const byQuestionId = new Map<string, SeedQuestion>();
  for (const q of QUESTIONS) {
    const def = materialize(q.key, q.draft);
    const id = seedIds.question(q.key);
    byQuestionId.set(id, q);
    await trx
      .insertInto('questions')
      .values({
        id,
        organization_id: ORGANIZATION.id,
        bank_id: QUESTION_BANK.id,
        status: 'active',
        current_version_id: seedIds.questionVersion(q.key),
        archived_at: null,
        created_at: AUTHORED_AT,
        updated_at: AUTHORED_AT,
        created_by: AUTHOR.id,
        updated_by: AUTHOR.id,
      })
      .execute();
    await trx
      .insertInto('question_versions')
      .values({
        id: seedIds.questionVersion(q.key),
        question_id: id,
        organization_id: ORGANIZATION.id,
        version: 1,
        type: def.type,
        prompt: q.prompt,
        config: def.config,
        explanation: q.explanation,
        points: q.points ?? 1,
        difficulty: q.difficulty,
        category_id: seedIds.category(q.category),
        competency_ids: q.competencies.map(seedIds.competency),
        tags: q.tags,
        change_note: null,
        created_at: AUTHORED_AT,
        created_by: AUTHOR.id,
      })
      .execute();
  }
  return byQuestionId;
}

async function seedAssessments(trx: Trx): Promise<void> {
  for (const seed of ASSESSMENTS) {
    const def = ASSESSMENT_DEFINITIONS[seed.key];
    if (!def) throw new Error(`No seed definition for assessment "${seed.key}"`);
    if (def.config.passingPercent !== seed.passingPercent) {
      throw new Error(`Seed definition of ${seed.key} disagrees with @a5/seed-data on the passing percentage`);
    }
    await trx
      .insertInto('assessments')
      .values({
        id: seed.id,
        organization_id: ORGANIZATION.id,
        title: seed.title,
        description: def.description,
        kind: seed.kind,
        status: 'published',
        config: def.config,
        published_at: PUBLISHED_AT,
        archived_at: null,
        created_at: AUTHORED_AT,
        updated_at: PUBLISHED_AT,
        created_by: AUTHOR.id,
        updated_by: AUTHOR.id,
      })
      .execute();
    const items = def.items.map((item, index) => {
      const position = index + 1;
      const base = { id: seedIds.item(seed.key, position), assessment_id: seed.id, position, points: null, created_at: AUTHORED_AT, updated_at: AUTHORED_AT };
      return item.kind === 'question'
        ? {
            ...base,
            kind: 'question' as const,
            question_id: seedIds.question(item.question),
            pool_bank_id: null,
            pool_category_id: null,
            pool_difficulty: null,
            pool_tags: [],
            pool_count: null,
          }
        : {
            ...base,
            kind: 'pool' as const,
            question_id: null,
            pool_bank_id: QUESTION_BANK.id,
            pool_category_id: seedIds.category(item.category),
            pool_difficulty: item.difficulty ?? null,
            pool_tags: item.tags ?? [],
            pool_count: item.count,
          };
    });
    await trx.insertInto('assessment_items').values(items).execute();
  }
}

function reviewerFor(person: PersonKey) {
  const trainerId = directoryUsers().find((u) => u.id === PEOPLE[person].id)?.trainerIds[0];
  const reviewer = Object.values(PEOPLE).find((p) => p.id === trainerId) ?? PEOPLE.shelby;
  return { id: reviewer.id, name: `${reviewer.firstName} ${reviewer.lastName}` };
}

async function seedAttempts(trx: Trx, questionsById: Map<string, SeedQuestion>): Promise<number> {
  const engine = new AttemptEngine(silent, { managersOf: async () => [] });
  const lessons = allLessons();
  let count = 0;
  for (const journey of JOURNEYS) {
    const learner = PEOPLE[journey.person];
    for (const seed of ASSESSMENTS) {
      const scores = journey.attempts[seed.key] ?? [];
      for (const [index, targetPercent] of scores.entries()) {
        await seedAttempt(trx, engine, questionsById, { journey, seed, learner, index, targetPercent, lessons });
        count++;
      }
    }
  }
  return count;
}

async function seedAttempt(
  trx: Trx,
  engine: AttemptEngine,
  questionsById: Map<string, SeedQuestion>,
  ctx: {
    journey: LearnerJourney;
    seed: SeedAssessment;
    learner: (typeof PEOPLE)[PersonKey];
    index: number;
    targetPercent: number;
    lessons: ReturnType<typeof allLessons>;
  },
): Promise<void> {
  const { journey, seed, learner, index, targetPercent } = ctx;
  const attemptId = seedIds.attempt(journey.person, seed.key, index + 1);
  const rng = seededRng(attemptId);
  const assessmentRow = await trx.selectFrom('assessments').selectAll().where('id', '=', seed.id).executeTakeFirstOrThrow();
  const items = await trx.selectFrom('assessment_items').selectAll().where('assessment_id', '=', seed.id).execute();
  const { startedAt, submittedAt } = attemptTimes(journey, seed.key, index, assessmentRow.config.timeLimitSeconds);

  const drawn = await drawQuestions(trx, ORGANIZATION.id, items, assessmentRow.config, rng);
  const lesson = ctx.lessons.find((l) => l.key === seed.lessonKey);
  if (!lesson) throw new Error(`Lesson ${seed.lessonKey} not found in the shared catalogue`);
  const attempt = await engine.create(trx, {
    id: attemptId,
    assessment: assessmentRow,
    userId: learner.id,
    attemptNumber: index + 1,
    context: { programId: PROGRAM.id, lessonId: lesson.id },
    drawn,
    startedAt,
  });

  const rows = await trx
    .selectFrom('attempt_questions')
    .select(['id', 'question_id', 'points', 'position'])
    .where('attempt_id', '=', attempt.id)
    .orderBy('position')
    .execute();
  const planned = rows.map((row, i) => ({
    points: row.points,
    options: answerOptions(drawn[i]!.question.def, questionsById.get(row.question_id), row.points, rng),
  }));
  const chosen = chooseAnswers(planned, { percent: targetPercent, passingPercent: assessmentRow.config.passingPercent }, rng);

  // Answers were autosaved while the learner worked through the attempt.
  const span = submittedAt.getTime() - startedAt.getTime();
  for (const [i, row] of rows.entries()) {
    await trx
      .updateTable('attempt_answers')
      .set({ response: chosen[i]!.response, saved_at: new Date(startedAt.getTime() + Math.floor(span * ((i + 1) / (rows.length + 1)))) })
      .where('attempt_question_id', '=', row.id)
      .execute();
  }

  const closed = await engine.close(trx, attempt, 'learner', submittedAt);
  const graded = await engine.grade(trx, closed.id, submittedAt);
  if (graded.status !== 'pending_review') return;

  // A trainer reviews the written answers a few hours after submission.
  const reviewedAt = new Date(submittedAt.getTime() + (3 + Math.floor(hash(`${attemptId}:review`) * 20)) * 3_600_000);
  const reviewer = reviewerFor(journey.person);
  const grades = rows.flatMap((row, i) =>
    chosen[i]!.reviewed ? [{ attemptQuestionId: row.id, awardedPoints: chosen[i]!.awarded, feedback: chosen[i]!.feedback ?? null }] : [],
  );
  await engine.applyReviewerGrades(trx, attempt.id, grades, reviewer, reviewedAt);
  const final = await engine.finalizeReview(trx, attempt.id, reviewedAt);
  if (!final) throw new Error(`Seeded attempt ${attemptId} still has ungraded written answers`);
}

/**
 * Seed the A5 Sales Core question bank, the four academy assessments and the historical attempts
 * listed in the shared learner journeys. Idempotent: does nothing once the bank exists. The
 * directory projection is refreshed every run (older revisions are ignored).
 */
export async function seedAssessment(db: Db, options: SeedOptions = {}): Promise<{ created: boolean; questions: number; attempts: number }> {
  const log = options.log ?? (() => undefined);
  await seedDirectory(db);
  const existing = await db.selectFrom('question_banks').select('id').where('id', '=', QUESTION_BANK.id).executeTakeFirst();
  if (existing) {
    log('assessment: question bank already seeded');
    return { created: false, questions: 0, attempts: 0 };
  }
  const attempts = await db.transaction().execute(async (trx) => {
    const questions = await seedQuestionBank(trx);
    await seedAssessments(trx);
    return seedAttempts(trx, questions);
  });
  log(`assessment: seeded ${QUESTIONS.length} questions, ${ASSESSMENTS.length} assessments and ${attempts} attempts`);
  return { created: true, questions: QUESTIONS.length, attempts };
}
