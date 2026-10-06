import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { assessment } from '@a5/contracts';
import { createDatabase, migrateDown, migrateToLatest, sql } from '@a5/database';
import { createTestDatabase } from '@a5/testing';
import { migrations } from '../src/database/migrations/index.js';
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
const ids: Record<string, string> = {};
const defs: Record<string, assessment.QuestionDefinition> = {};

beforeAll(async () => {
  h = await createAssessmentHarness('integrity', { seed: false });
  author = { http: h.http, headers: await h.as('shelby') };
  bankId = (await createBank(author, 'Integrity')).id;
  const samples = {
    mc: sampleQuestions.multipleChoice('mc'),
    essay: sampleQuestions.longAnswer('essay'),
  };
  for (const [label, body] of Object.entries(samples)) {
    ids[label] = (await createQuestion(author, bankId, body)).id;
    defs[label] = definitionOf(body);
  }
});
afterAll(() => h?.close());

/** SQLSTATE of the error a statement raises, or null when it succeeds. */
async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

async function take(
  person: 'kayla' | 'jordan' | 'marcus' | 'tyler' | 'isaiah' | 'colton',
  labels: string[],
  submit: boolean,
) {
  const a = await createAssessment(author, {
    title: `Integrity ${person} ${Math.random().toString(36).slice(2, 7)}`,
    items: labels.map((l) => ({ kind: 'question', questionId: ids[l] })),
    config: { maxAttempts: 5 },
  });
  const headers = await h.as(person);
  const started = await h.http.post('/api/v1/attempts').set(headers).send({ assessmentId: a.id });
  const attempt = started.body as assessment.LearnerAttempt;
  await answerAttempt(h, headers, attempt, defs);
  if (submit) await h.http.post(`/api/v1/attempts/${attempt.id}/submit`).set(headers).expect(200);
  return { assessment: a, attempt, headers };
}

describe('attempt answers are frozen once the attempt leaves in_progress', () => {
  it('rejects direct changes to a submitted attempt’s answers', async () => {
    const { attempt } = await take('kayla', ['mc'], true);
    const change = () =>
      sql`update attempt_answers set response = '{"type":"multiple_choice","optionId":"b"}'::jsonb where attempt_id = ${attempt.id}`.execute(
        h.db,
      );
    expect(await sqlState(change)).toBe('A5A01');
    const stamp = () =>
      sql`update attempt_answers set saved_at = now() where attempt_id = ${attempt.id}`.execute(
        h.db,
      );
    expect(await sqlState(stamp)).toBe('A5A01');
    const stored = await h.db
      .selectFrom('attempt_answers')
      .select('response')
      .where('attempt_id', '=', attempt.id)
      .executeTakeFirstOrThrow();
    expect(stored.response).toEqual({ type: 'multiple_choice', optionId: 'a' });
  });

  it('rejects adding or deleting answers of a closed attempt', async () => {
    const { attempt } = await take('jordan', ['mc'], true);
    const add = () =>
      sql`insert into attempt_answers (id, attempt_id, attempt_question_id) select gen_random_uuid(), attempt_id, attempt_question_id from attempt_answers where attempt_id = ${attempt.id}`.execute(
        h.db,
      );
    expect(await sqlState(add)).toMatch(/A5A01|23505/);
    expect(
      await sqlState(() =>
        sql`delete from attempt_answers where attempt_id = ${attempt.id}`.execute(h.db),
      ),
    ).toBe('A5I01');
  });

  it('does not allow grading fields to be written before submission', async () => {
    const { attempt } = await take('marcus', ['mc'], false);
    expect(
      await sqlState(() =>
        sql`update attempt_answers set awarded_points = 1, is_correct = true where attempt_id = ${attempt.id}`.execute(
          h.db,
        ),
      ),
    ).toBe('A5A01');
    // Answers themselves remain editable while the attempt is in progress.
    expect(
      await sqlState(() =>
        sql`update attempt_answers set saved_at = now() where attempt_id = ${attempt.id}`.execute(
          h.db,
        ),
      ),
    ).toBeNull();
  });

  it('allows only grading fields to change while a review is pending', async () => {
    const { attempt } = await take('tyler', ['mc', 'essay'], true);
    const status = await h.db
      .selectFrom('attempts')
      .select('status')
      .where('id', '=', attempt.id)
      .executeTakeFirstOrThrow();
    expect(status.status).toBe('pending_review');
    const essay = attempt.questions.find((q) => q.prompt.startsWith('essay'))!;
    expect(
      await sqlState(() =>
        sql`update attempt_answers set response = '{"type":"long_answer","text":"edited"}'::jsonb where attempt_question_id = ${essay.id}`.execute(
          h.db,
        ),
      ),
    ).toBe('A5A01');
    expect(
      await sqlState(() =>
        sql`update attempt_answers set feedback = 'Reviewed' where attempt_question_id = ${essay.id}`.execute(
          h.db,
        ),
      ),
    ).toBeNull();
  });

  it('makes graded attempts and their grading final', async () => {
    const { attempt } = await take('isaiah', ['mc'], true);
    const row = await h.db
      .selectFrom('attempts')
      .select('status')
      .where('id', '=', attempt.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('graded');
    expect(
      await sqlState(() =>
        sql`update attempt_answers set awarded_points = 0 where attempt_id = ${attempt.id}`.execute(
          h.db,
        ),
      ),
    ).toBe('A5A02');
    // The learner answered correctly (100%, passed): any change to the stored result is rejected.
    expect(
      await sqlState(() =>
        sql`update attempts set score_percent = 40, passed = false where id = ${attempt.id}`.execute(
          h.db,
        ),
      ),
    ).toBe('A5A02');
    expect(
      await sqlState(() =>
        sql`update attempts set graded_at = now() + interval '1 day' where id = ${attempt.id}`.execute(
          h.db,
        ),
      ),
    ).toBe('A5A02');
    expect(
      await sqlState(() =>
        sql`update attempts set status = 'in_progress' where id = ${attempt.id}`.execute(h.db),
      ),
    ).toBe('A5A01');
  });

  it('keeps attempt identity and the config snapshot immutable and attempts permanent', async () => {
    const { attempt } = await take('colton', ['mc'], false);
    expect(
      await sqlState(() =>
        sql`update attempts set user_id = gen_random_uuid() where id = ${attempt.id}`.execute(h.db),
      ),
    ).toBe('A5I01');
    expect(
      await sqlState(() =>
        sql`update attempts set config = '{}'::jsonb where id = ${attempt.id}`.execute(h.db),
      ),
    ).toBe('A5I01');
    expect(
      await sqlState(() =>
        sql`update attempts set max_points = 99 where id = ${attempt.id}`.execute(h.db),
      ),
    ).toBe('A5I01');
    expect(
      await sqlState(() => sql`delete from attempts where id = ${attempt.id}`.execute(h.db)),
    ).toBe('A5I01');
  });
});

describe('immutable history tables', () => {
  it('rejects updates and deletes of question versions', async () => {
    expect(
      await sqlState(() => sql`update question_versions set prompt = 'tampered'`.execute(h.db)),
    ).toBe('A5I01');
    expect(await sqlState(() => sql`delete from question_versions`.execute(h.db))).toBe('A5I01');
  });

  it('rejects updates and deletes of the drawn-question snapshot', async () => {
    const { attempt } = await take('kayla', ['mc'], true);
    expect(
      await sqlState(() =>
        sql`update attempt_questions set points = 9 where attempt_id = ${attempt.id}`.execute(h.db),
      ),
    ).toBe('A5I01');
    expect(
      await sqlState(() =>
        sql`update attempt_questions set question_version_id = question_version_id where attempt_id = ${attempt.id}`.execute(
          h.db,
        ),
      ),
    ).toBe('A5I01');
    expect(
      await sqlState(() =>
        sql`delete from attempt_questions where attempt_id = ${attempt.id}`.execute(h.db),
      ),
    ).toBe('A5I01');
  });

  it('rejects updates and deletes of score overrides', async () => {
    const { attempt } = await take('jordan', ['mc'], true);
    await h.http
      .post(`/api/v1/attempts/${attempt.id}/override`)
      .set(await h.as('priya'))
      .send({ scorePercent: 50, reason: 'Integrity test override of a graded attempt.' })
      .expect(200);
    expect(
      await sqlState(() =>
        sql`update score_overrides set new_score_percent = 100 where attempt_id = ${attempt.id}`.execute(
          h.db,
        ),
      ),
    ).toBe('A5I01');
    expect(
      await sqlState(() =>
        sql`delete from score_overrides where attempt_id = ${attempt.id}`.execute(h.db),
      ),
    ).toBe('A5I01');
  });

  it('turns a trigger rejection into a clear API error when a race slips past the service checks', async () => {
    const { mapIntegrityError } = await import('../src/common/db-errors.js');
    const closed = mapIntegrityError({ code: 'A5A01' }) as {
      status: number;
      code: string;
      message: string;
    };
    expect(closed).toMatchObject({ status: 409, code: 'ATTEMPT_CLOSED' });
    expect(closed.message).toMatch(/already been submitted/);
    expect(mapIntegrityError({ code: 'A5A02' })).toMatchObject({ code: 'ATTEMPT_FINAL' });
    expect(mapIntegrityError({ code: 'A5I01' })).toMatchObject({ code: 'RECORD_IMMUTABLE' });
    const other = new Error('boom');
    expect(mapIntegrityError(other)).toBe(other);
  });
});

describe('constraints', () => {
  it('allows one open attempt per learner and assessment and unique attempt numbers', async () => {
    const { attempt, assessment: a } = await take('marcus', ['mc'], false);
    const duplicate = () =>
      sql`insert into attempts (id, organization_id, assessment_id, user_id, attempt_number, status, config, started_at, max_points)
          select gen_random_uuid(), organization_id, assessment_id, user_id, attempt_number + 1, 'in_progress', config, now(), max_points
          from attempts where id = ${attempt.id}`.execute(h.db);
    expect(await sqlState(duplicate)).toBe('23505');
    const sameNumber = () =>
      sql`insert into attempts (id, organization_id, assessment_id, user_id, attempt_number, status, config, started_at, submitted_at, max_points)
          select gen_random_uuid(), organization_id, assessment_id, user_id, attempt_number, 'submitted', config, now(), now(), max_points
          from attempts where id = ${attempt.id}`.execute(h.db);
    expect(await sqlState(sameNumber)).toBe('23505');
    expect(a.id).toBeTruthy();
  });

  it('requires a closed attempt to carry a submission time and a graded one a score', async () => {
    const { attempt } = await take('tyler', ['mc'], false);
    expect(
      await sqlState(() =>
        sql`update attempts set status = 'submitted' where id = ${attempt.id}`.execute(h.db),
      ),
    ).toBe('23514');
    expect(
      await sqlState(() =>
        sql`update attempts set status = 'graded', submitted_at = now(), graded_at = now() where id = ${attempt.id}`.execute(
          h.db,
        ),
      ),
    ).toBe('23514');
  });

  it('keeps current_version_id pointing at a version of the same question', async () => {
    const other = await createQuestion(author, bankId, sampleQuestions.trueFalse('other'));
    const wrong = () =>
      h.db.transaction().execute(async (trx) => {
        await sql`update questions set current_version_id = ${other.currentVersion.id} where id = ${ids.mc}`.execute(
          trx,
        );
      });
    expect(await sqlState(wrong)).toBe('23503');
  });

  it('keeps assessment item positions unique per assessment', async () => {
    const a = await createAssessment(author, {
      title: 'Positions',
      items: [
        { kind: 'question', questionId: ids.mc },
        { kind: 'question', questionId: ids.essay },
      ],
    });
    const clash = () =>
      sql`update assessment_items set position = 1 where assessment_id = ${a.id} and position = 2`.execute(
        h.db,
      );
    expect(await sqlState(clash)).toBe('23505');
  });
});

describe('migrations', () => {
  it('reverse completely and apply again', async () => {
    const tdb = await createTestDatabase('assessment_migrations');
    const database = createDatabase({ url: tdb.url, poolMax: 2 });
    try {
      expect(await migrateToLatest(database.db as never, migrations)).toEqual([
        'Up 0001_assessment',
      ]);
      const tables = async () =>
        (
          await sql<{
            table_name: string;
          }>`select table_name from information_schema.tables where table_schema = 'public' order by 1`.execute(
            database.db,
          )
        ).rows.map((r) => r.table_name);
      expect(await tables()).toEqual(
        expect.arrayContaining([
          'question_banks',
          'question_versions',
          'attempts',
          'attempt_answers',
          'score_overrides',
          'dir_users',
          'outbox_events',
          'inbox_events',
        ]),
      );
      expect(await migrateDown(database.db as never, migrations)).toEqual(['Down 0001_assessment']);
      expect((await tables()).filter((t) => !t.startsWith('schema_migrations'))).toEqual([]);
      const functions = await sql<{
        proname: string;
      }>`select proname from pg_proc where pronamespace = 'public'::regnamespace`.execute(
        database.db,
      );
      expect(functions.rows).toEqual([]);
      expect(await migrateToLatest(database.db as never, migrations)).toEqual([
        'Up 0001_assessment',
      ]);
    } finally {
      await database.destroy();
      await tdb.drop();
    }
  });
});
