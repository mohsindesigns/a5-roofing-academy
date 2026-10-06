import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { learningEvents, streamFor } from '@a5/events';
import { QueueFactory, StreamPublisher } from '@a5/messaging';
import { PEOPLE, PHASES, PROGRAM, allLessons, seedId } from '@a5/seed-data';
import { waitFor } from '@a5/testing';
import { REPORT_QUEUE } from '../src/reports/exports.service.js';
import { ROLLUP_QUEUE } from '../src/rollups/rollup.service.js';
import { createAnalyticsHarness, evt, type AnalyticsHarness } from './harness.js';

let h: AnalyticsHarness;
let publisher: StreamPublisher;

beforeAll(async () => {
  h = await createAnalyticsHarness('worker', { role: 'all', now: null });
  publisher = new StreamPublisher(h.redis, h.ns);
});
afterAll(() => h?.close());

const lesson = allLessons()[0]!;
const marcus = {
  enrollmentId: seedId('worker-enrollment:marcus'),
  programId: PROGRAM.id,
  userId: PEOPLE.marcus.id,
};

describe('event stream to fact tables', () => {
  it('consumes learning events published by other services, once each', async () => {
    const enrolled = evt(
      learningEvents.enrolled,
      {
        ...marcus,
        programTitle: PROGRAM.title,
        assignedBy: null,
        dueAt: '2026-11-01T14:00:00Z',
        source: 'rule',
      },
      '2026-10-01T14:00:00Z',
      'worker:enrolled',
    );
    const completed = evt(
      learningEvents.lessonCompleted,
      {
        ...marcus,
        phaseId: PHASES[0]!.id,
        moduleId: PHASES[0]!.modules[0]!.id,
        lessonId: lesson.id,
        lessonType: lesson.type,
        lessonTitle: lesson.title,
        required: true,
        source: 'learner',
        completedAt: '2026-10-01T15:00:00Z',
      },
      '2026-10-01T15:00:00Z',
      'worker:lesson',
    );
    const stream = streamFor('learning-service');
    // The lesson arrives first and the enrolment is delivered twice.
    await publisher.publish([
      { stream, envelope: completed },
      { stream, envelope: enrolled },
      { stream, envelope: enrolled },
    ]);

    const row = await waitFor(
      async () => {
        const r = await h.db
          .selectFrom('fact_enrollments')
          .selectAll()
          .where('enrollment_id', '=', marcus.enrollmentId)
          .executeTakeFirst();
        return r?.enrolled_at && r.program_title ? r : null;
      },
      { timeoutMs: 15_000, message: 'enrollment fact from the stream' },
    );
    expect(row).toMatchObject({ source: 'rule', status: 'active', program_title: PROGRAM.title });
    expect(row.last_activity_at?.toISOString()).toBe('2026-10-01T15:00:00.000Z');
    await waitFor(
      async () =>
        (await h.db.selectFrom('fact_lesson_events').select('lesson_id').execute()).length === 1,
      { message: 'lesson fact' },
    );

    const inbox = await h.db
      .selectFrom('inbox_events')
      .select('handler')
      .where('event_id', '=', enrolled.id)
      .execute();
    expect(inbox).toEqual([{ handler: 'analytics.program.enrolled' }]);
    expect(
      await h.db.selectFrom('fact_activity').select('id').where('kind', '=', 'enrolled').execute(),
    ).toHaveLength(1);
    // The consumer marked the affected days for the rollup job.
    const dirty = await h.db
      .selectFrom('rollup_dirty_days')
      .select('date')
      .orderBy('date')
      .execute();
    expect(dirty.map((d) => d.date)).toEqual(['2026-10-01']);
  });
});

describe('background jobs', () => {
  it('registers the repeatable rollup and maintenance jobs', async () => {
    const queues = h.app.get(QueueFactory, { strict: false });
    const rollup = await queues.queue(ROLLUP_QUEUE).getJobSchedulers();
    expect(rollup.map((s) => s.key).sort()).toEqual([
      'analytics.rollup.dirty',
      'analytics.rollup.nightly',
    ]);
    expect(Number(rollup.find((s) => s.key === 'analytics.rollup.dirty')!.every)).toBe(15 * 60_000);
    expect(rollup.find((s) => s.key === 'analytics.rollup.nightly')!.pattern).toBe('17 3 * * *');
    const reports = await queues.queue(REPORT_QUEUE).getJobSchedulers();
    expect(reports.map((s) => s.key)).toEqual(['analytics.report.maintenance']);
  });

  it('rebuilds rollups on demand through the queue', async () => {
    const admin = await h.as('grant');
    const queued = await h.http
      .post('/api/v1/analytics/rollups/refresh')
      .set(admin)
      .send({ from: '2026-10-01', to: '2026-10-02' });
    expect(queued.status).toBe(202);
    expect(queued.body.jobId).toMatch(/^refresh\./);
    const rows = await waitFor(
      async () => {
        const r = await h.db
          .selectFrom('daily_rollups')
          .select(['metric', 'dimension_type', 'dimension_id', 'value'])
          .where('date', '=', '2026-10-01')
          .execute();
        return r.length ? r : null;
      },
      { timeoutMs: 15_000, message: 'rollup rows' },
    );
    const lessons = rows.filter((r) => r.metric === 'lessons_completed');
    // One completion, attributed to the organization, the person, their team, location and department.
    expect(lessons.map((r) => [r.dimension_type, r.value]).sort()).toEqual([
      ['department', 1],
      ['location', 1],
      ['organization', 1],
      ['team', 1],
      ['user', 1],
    ]);
    expect(
      rows.find((r) => r.metric === 'enrollments_started' && r.dimension_type === 'department')!
        .value,
    ).toBe(1);
    expect(
      rows.find((r) => r.metric === 'active_learners' && r.dimension_type === 'organization')!
        .value,
    ).toBe(1);
  });

  it('renders exports in the worker and finishes them without any manual step', async () => {
    const admin = await h.as('grant');
    const created = await h.http
      .post('/api/v1/reports/exports')
      .set(admin)
      .send({ report: 'training-completion', format: 'csv' });
    expect(created.status).toBe(202);
    const done = await waitFor(
      async () => {
        const r = (await h.http.get(`/api/v1/reports/exports/${created.body.id}`).set(admin)).body;
        return r.status === 'completed' || r.status === 'failed' ? r : null;
      },
      { timeoutMs: 20_000, message: 'export job' },
    );
    expect(done).toMatchObject({ status: 'completed', rowCount: 1, error: null });
    expect(done.fileName).toMatch(/^training-completion-\d{4}-\d{2}-\d{2}\.csv$/);
    const download = await h.http
      .get(`/api/v1/reports/exports/${created.body.id}/download`)
      .set(admin);
    expect(download.status).toBe(200);
  });
});
