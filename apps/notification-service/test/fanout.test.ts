import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@a5/database';
import { applyDirectoryUser } from '@a5/directory';
import {
  assessmentEvents,
  certificationEvents,
  identityEvents,
  learningEvents,
  type EventEnvelope,
} from '@a5/events';
import { uuidv7 } from '@a5/observability';
import {
  ASSESSMENTS,
  CERTIFICATION,
  PEOPLE,
  PROGRAM,
  directoryUser,
  seedId,
  type PersonKey,
} from '@a5/seed-data';
import { waitFor } from '@a5/testing';
import { DirectoryNotReadyError, NotificationEngine } from '../src/engine/notification-engine.js';
import {
  APP_URL,
  createNotificationHarness,
  deliveriesTo,
  notificationsOf,
  processed,
  type NotificationHarness,
} from './harness.js';

let h: NotificationHarness;
let engine: NotificationEngine;

beforeAll(async () => {
  h = await createNotificationHarness('fanout');
  engine = h.app.get(NotificationEngine);
});
afterAll(() => h?.close());

const quiz = ASSESSMENTS.find((a) => a.key === 'quiz-w1')!;

function graded(
  person: PersonKey,
  score: number,
  kind: 'quiz' | 'practice' = 'quiz',
): EventEnvelope {
  return h.event(assessmentEvents.attemptGraded, {
    attemptId: uuidv7(),
    assessmentId: quiz.id,
    assessmentTitle: quiz.title,
    kind,
    userId: PEOPLE[person].id,
    attemptNumber: 1,
    scorePercent: score,
    passed: score >= quiz.passingPercent,
    passingPercent: quiz.passingPercent,
    gradedAt: new Date().toISOString(),
    overridden: false,
    context: { programId: PROGRAM.id },
    questionResults: [],
  });
}

async function deliver(event: EventEnvelope): Promise<void> {
  await h.publish(event);
  await processed(h, event.id);
}

describe('fan-out through the directory', () => {
  it('sends a pending approval to the learner’s team manager, not to the learner', async () => {
    const event = h.event(learningEvents.approvalRequested, {
      enrollmentId: seedId('enrollment:brianna'),
      programId: PROGRAM.id,
      userId: PEOPLE.brianna.id,
      approvalId: uuidv7(),
      lessonId: seedId('lesson:w4-signoff'),
      lessonTitle: 'Manager Field-Ready Sign-off',
      programTitle: PROGRAM.title,
    });
    await deliver(event);

    const [andre] = await notificationsOf(h, 'andre');
    expect(andre).toMatchObject({
      type: 'approval.requested',
      title: 'Approval needed: Brianna Castillo',
      body: 'Manager Field-Ready Sign-off in A5 New Hire Sales Academy is waiting for your decision.',
      link: '/team/approvals',
      priority: 'high',
      source_event_id: event.id,
      read_at: null,
    });
    expect(await notificationsOf(h, 'brianna')).toHaveLength(0);
    expect(await notificationsOf(h, 'danielle')).toHaveLength(0);

    await waitFor(() => h.transport.to('andre.coleman@a5roofing.example').length === 1, {
      message: 'approval email',
    });
    const [email] = h.transport.to('andre.coleman@a5roofing.example');
    expect(email!.subject).toBe('Approval needed: Brianna Castillo, Manager Field-Ready Sign-off');
    expect(email!.text).toContain('Hi Andre,');
    expect(email!.text).toContain(`Review approval: ${APP_URL}/team/approvals`);
    expect(email!.headers['X-A5-Notification-Type']).toBe('approval.requested');
    const [delivery] = await deliveriesTo(h, 'andre');
    await waitFor(async () => (await deliveriesTo(h, 'andre'))[0]?.status === 'sent', {
      message: 'delivery marked sent',
    });
    expect(delivery).toMatchObject({
      to_address: 'andre.coleman@a5roofing.example',
      sensitive: false,
    });
  });

  it('tells the learner about a failed quiz and alerts managers, but not for practice attempts', async () => {
    const failed = graded('tyler', 70);
    await deliver(failed);
    const tyler = await notificationsOf(h, 'tyler');
    expect(tyler.map((n) => n.type)).toEqual(['assessment.failed']);
    expect(tyler[0]).toMatchObject({
      title: 'Week 1 Knowledge Check: 70%, not passed yet',
      link: `/assessments/attempts/${(failed.payload as { attemptId: string }).attemptId}`,
    });
    const danielle = await notificationsOf(h, 'danielle');
    expect(danielle.map((n) => n.type)).toEqual(['assessment.failed.manager']);
    expect(danielle[0]!.title).toBe('Tyler Brennan did not pass Week 1 Knowledge Check');
    expect(await notificationsOf(h, 'shelby')).toHaveLength(0);
    await waitFor(() => h.transport.to('tyler.brennan@a5roofing.example').length === 1, {
      message: 'failed email',
    });
    expect(h.transport.to('danielle.okafor@a5roofing.example')).toHaveLength(0);

    await deliver(graded('marcus', 92));
    expect((await notificationsOf(h, 'marcus')).map((n) => n.type)).toEqual(['assessment.passed']);
    expect(await notificationsOf(h, 'danielle')).toHaveLength(1);

    await deliver(graded('kayla', 40, 'practice'));
    expect((await notificationsOf(h, 'kayla')).map((n) => n.type)).toEqual(['assessment.failed']);
    expect(await notificationsOf(h, 'danielle')).toHaveLength(1);
  });

  it('is idempotent on redelivery and when the inbox claim is lost', async () => {
    const event = graded('jordan', 60);
    await deliver(event);
    const before = {
      jordan: (await notificationsOf(h, 'jordan')).length,
      danielle: (await notificationsOf(h, 'danielle')).length,
    };
    expect(before.jordan).toBe(1);

    await h.publish(event);
    expect(await engine.handle(event)).toMatchObject({ processed: false });
    await new Promise((r) => setTimeout(r, 300));
    expect((await notificationsOf(h, 'jordan')).length).toBe(before.jordan);

    // Even without the inbox row, the unique (event, user, type) keys prevent duplicates.
    await h.db.deleteFrom('inbox_events').where('event_id', '=', event.id).execute();
    expect(await engine.handle(event)).toEqual({ processed: true, notifications: 0, emails: 0 });
    expect((await notificationsOf(h, 'jordan')).length).toBe(before.jordan);
    expect((await notificationsOf(h, 'danielle')).length).toBe(before.danielle);
    expect((await deliveriesTo(h, 'jordan')).length).toBe(1);
  });

  it('honours preferences per type and channel', async () => {
    const tyler = await h.as('tyler');
    const res = await h.http
      .put('/api/v1/notifications/preferences')
      .set(tyler)
      .send({ preferences: [{ type: 'assessment.failed', channel: 'email', enabled: false }] });
    expect(res.status).toBe(200);
    const emailsBefore = (await deliveriesTo(h, 'tyler')).length;
    const event = graded('tyler', 55);
    await deliver(event);
    const latest = (await notificationsOf(h, 'tyler'))[0]!;
    expect(latest.source_event_id).toBe(event.id);
    expect((await deliveriesTo(h, 'tyler')).length).toBe(emailsBefore);

    await h.http
      .put('/api/v1/notifications/preferences')
      .set(tyler)
      .send({ preferences: [{ type: 'assessment.failed', channel: 'in_app', enabled: false }] });
    const next = graded('tyler', 50);
    await deliver(next);
    expect((await notificationsOf(h, 'tyler')).some((n) => n.source_event_id === next.id)).toBe(
      false,
    );
  });

  it('excludes the actor and deactivated people from manager notifications', async () => {
    const certificateId = uuidv7();
    const issued = h.event(
      certificationEvents.issued,
      {
        certificateId,
        definitionId: CERTIFICATION.id,
        definitionName: CERTIFICATION.name,
        userId: PEOPLE.marcus.id,
        certificateNumber: 'A5-SALES-2026-000021',
        issuedAt: '2026-10-05T15:00:00Z',
        expiresAt: '2028-10-05T15:00:00Z',
        mode: 'manual',
      },
      { actor: { type: 'user', id: PEOPLE.danielle.id } },
    );
    await deliver(issued);
    const marcus = (await notificationsOf(h, 'marcus')).find(
      (n) => n.source_event_id === issued.id,
    );
    expect(marcus).toMatchObject({
      type: 'certificate.issued',
      title: `Certificate earned: ${CERTIFICATION.name}`,
      link: `/certifications/${certificateId}`,
    });
    expect(marcus!.body).toContain('A5-SALES-2026-000021');
    expect(marcus!.body).toContain('It is valid until Oct 5, 2028.');
    expect(
      (await notificationsOf(h, 'danielle')).some((n) => n.source_event_id === issued.id),
    ).toBe(false);

    await h.db
      .transaction()
      .execute((trx) =>
        applyDirectoryUser(trx as never, { ...directoryUser('andre'), status: 'deactivated' }, 50),
      );
    const failed = graded('caleb', 30);
    await deliver(failed);
    expect((await notificationsOf(h, 'andre')).some((n) => n.source_event_id === failed.id)).toBe(
      false,
    );
    expect((await notificationsOf(h, 'caleb')).some((n) => n.source_event_id === failed.id)).toBe(
      true,
    );
    await h.db
      .transaction()
      .execute((trx) => applyDirectoryUser(trx as never, directoryUser('andre'), 51));
  });

  it('addresses role recipients configured on a rule', async () => {
    const admin = await h.as('grant');
    const rules = await h.http
      .get('/api/v1/notification-rules?eventType=certificate.approval_requested')
      .set(admin);
    const rule = rules.body.items[0];
    const res = await h.http
      .patch(`/api/v1/notification-rules/${rule.id}`)
      .set(admin)
      .send({ recipients: ['managers', 'role:admin'], channels: ['in_app'] });
    expect(res.status).toBe(200);
    const event = h.event(certificationEvents.approvalRequested, {
      approvalId: uuidv7(),
      definitionId: CERTIFICATION.id,
      definitionName: CERTIFICATION.name,
      userId: PEOPLE.kayla.id,
    });
    await deliver(event);
    for (const person of ['danielle', 'grant'] as const) {
      const n = (await notificationsOf(h, person)).find((x) => x.source_event_id === event.id);
      expect(n, person).toMatchObject({
        type: 'certificate.approval_requested',
        title: 'Certification approval: Kayla Simmons',
      });
    }
    expect((await notificationsOf(h, 'priya')).some((n) => n.source_event_id === event.id)).toBe(
      false,
    );
    expect(await deliveriesTo(h, 'grant')).toHaveLength(0);
  });

  it('announces program updates to enrolled learners only from the second version on', async () => {
    const published = (version: number) =>
      h.event(
        learningEvents.programPublished,
        {
          programId: PROGRAM.id,
          title: PROGRAM.title,
          version,
          phases: [],
          requiredLessonIds: [],
          assessments: [],
          aiScenarios: [],
        },
        { actor: { type: 'user', id: PEOPLE.shelby.id } },
      );
    const first = published(1);
    await deliver(first);
    expect(
      await h.db
        .selectFrom('notifications')
        .select('id')
        .where('source_event_id', '=', first.id)
        .execute(),
    ).toHaveLength(0);

    const second = published(4);
    await deliver(second);
    const rows = await h.db
      .selectFrom('notifications')
      .select(['user_id', 'title', 'priority'])
      .where('source_event_id', '=', second.id)
      .execute();
    expect(rows).toHaveLength(16);
    expect(rows[0]).toMatchObject({
      title: 'A5 New Hire Sales Academy was updated',
      priority: 'low',
    });
    expect(rows.map((r) => r.user_id)).toContain(PEOPLE.devon.id);
    expect(rows.map((r) => r.user_id)).not.toContain(PEOPLE.shelby.id);

    // Withdrawn learners stop receiving program announcements.
    const withdrawn = h.event(learningEvents.enrollmentWithdrawn, {
      enrollmentId: seedId('enrollment:devon'),
      programId: PROGRAM.id,
      userId: PEOPLE.devon.id,
    });
    await h.publish(withdrawn);
    await processed(h, withdrawn.id, 'program-learners');
    expect(
      await h.db
        .selectFrom('program_learners')
        .select('withdrawn_at')
        .where('user_id', '=', PEOPLE.devon.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ withdrawn_at: expect.any(Date) });
    const third = published(5);
    await deliver(third);
    const thirdRows = await h.db
      .selectFrom('notifications')
      .select('user_id')
      .where('source_event_id', '=', third.id)
      .execute();
    expect(thirdRows).toHaveLength(15);
  });

  it('waits for the directory before addressing a brand-new person, then falls back', async () => {
    const newcomer = uuidv7();
    const event = h.event(learningEvents.enrolled, {
      enrollmentId: uuidv7(),
      programId: PROGRAM.id,
      userId: newcomer,
      programTitle: PROGRAM.title,
      assignedBy: PEOPLE.danielle.id,
      dueAt: '2026-11-02T18:00:00Z',
      source: 'manual',
    });
    await expect(engine.handle(event, 1)).rejects.toBeInstanceOf(DirectoryNotReadyError);
    expect(
      await h.db.selectFrom('notifications').select('id').where('user_id', '=', newcomer).execute(),
    ).toHaveLength(0);

    const result = await engine.handle(event, 3);
    expect(result).toEqual({ processed: true, notifications: 1, emails: 0 });
    const [row] = await h.db
      .selectFrom('notifications')
      .selectAll()
      .where('user_id', '=', newcomer)
      .execute();
    expect(row).toMatchObject({
      title: 'New training: A5 New Hire Sales Academy',
      link: `/training/${PROGRAM.id}`,
    });
    expect(row!.body).toBe(
      'Danielle Okafor enrolled you in A5 New Hire Sales Academy. Complete it by Nov 2, 2026.',
    );
  });
});

describe('security emails', () => {
  async function tablesContaining(needle: string): Promise<string[]> {
    const tables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
    `.execute(h.db);
    const hits: string[] = [];
    for (const { table_name } of tables.rows) {
      const found = await sql<{
        n: number;
      }>`select count(*)::int as n from ${sql.table(table_name)} t where t::text like ${`%${needle}%`}`.execute(
        h.db,
      );
      if (found.rows[0]!.n > 0) hits.push(table_name);
    }
    return hits;
  }

  async function redisContaining(needle: string): Promise<string[]> {
    const keys = await h.redis.keys(`${h.namespace}*`);
    const hits: string[] = [];
    for (const key of keys) {
      const type = await h.redis.type(key);
      const values =
        type === 'string'
          ? [await h.redis.get(key)]
          : type === 'hash'
            ? Object.values(await h.redis.hgetall(key))
            : type === 'stream'
              ? []
              : [];
      if (values.some((v) => v?.includes(needle))) hits.push(key);
    }
    return hits;
  }

  it('emails the activation link without persisting it anywhere', async () => {
    const token = `act_${uuidv7().replace(/-/g, '')}`;
    const userId = uuidv7();
    const event = h.event(
      identityEvents.invitationCreated,
      {
        userId,
        email: 'wesley.tran@a5roofing.example',
        displayName: 'Wesley Tran',
        activationUrl: `${APP_URL}/activate?token=${token}`,
        expiresAt: '2026-10-08T15:00:00Z',
        invitedByName: 'Grant Holloway',
      },
      { actor: { type: 'user', id: PEOPLE.grant.id } },
    );
    // A brand-new person is not in the directory yet; the invitation carries the address.
    await h.publish(event);
    await processed(h, event.id);
    await waitFor(() => h.transport.to('wesley.tran@a5roofing.example').length === 1, {
      message: 'activation email',
    });
    const [email] = h.transport.to('wesley.tran@a5roofing.example');
    expect(email!.subject).toBe('Activate your A5 Sales Academy account');
    expect(email!.toName).toBe('Wesley Tran');
    expect(email!.text).toContain('Hi Wesley,');
    expect(email!.text).toContain('Grant Holloway invited you');
    expect(email!.text).toContain(`Activate my account: ${APP_URL}/activate?token=${token}`);
    expect(email!.html).toContain(`href="${APP_URL}/activate?token=${token}"`);
    expect(email!.text).toContain('expires Oct 8, 2026, 10:00 AM CDT');
    expect(email!.text).not.toContain('Manage email notifications');

    await waitFor(
      async () =>
        (
          await h.db
            .selectFrom('email_deliveries')
            .select('status')
            .where('user_id', '=', userId)
            .executeTakeFirst()
        )?.status === 'sent',
    );
    const delivery = await h.db
      .selectFrom('email_deliveries')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(delivery).toMatchObject({
      sensitive: true,
      body_text: null,
      body_html: null,
      sealed_content: null,
      subject: 'Activate your A5 Sales Academy account',
    });
    expect(
      await h.db.selectFrom('notifications').select('id').where('user_id', '=', userId).execute(),
    ).toHaveLength(0);

    expect(await tablesContaining(token)).toEqual([]);
    expect(await redisContaining(token)).toEqual([]);
  });

  it('sends password resets by email only, even when email notifications are switched off', async () => {
    const marcus = await h.as('marcus');
    await h.http
      .put('/api/v1/notifications/preferences')
      .set(marcus)
      .send({ preferences: [{ type: 'training.assigned', channel: 'email', enabled: false }] });
    const token = `rst_${uuidv7().replace(/-/g, '')}`;
    const event = h.event(identityEvents.passwordResetRequested, {
      userId: PEOPLE.marcus.id,
      email: 'marcus.delgado@a5roofing.example',
      displayName: 'Marcus Delgado',
      resetUrl: `${APP_URL}/reset-password?token=${token}`,
      expiresAt: '2026-10-05T15:30:00Z',
    });
    await deliver(event);
    await waitFor(() =>
      h.transport
        .to('marcus.delgado@a5roofing.example')
        .some((m) => m.subject === 'Reset your A5 Sales Academy password'),
    );
    const email = h.transport
      .to('marcus.delgado@a5roofing.example')
      .find((m) => m.subject === 'Reset your A5 Sales Academy password')!;
    expect(email.text).toContain(`Reset my password: ${APP_URL}/reset-password?token=${token}`);
    expect(email.text).toContain('expires Oct 5, 2026, 10:30 AM CDT');
    expect((await notificationsOf(h, 'marcus')).some((n) => n.source_event_id === event.id)).toBe(
      false,
    );
    expect(await tablesContaining(token)).toEqual([]);
  });

  it('welcomes a new account in the app', async () => {
    const userId = uuidv7();
    const event = h.event(identityEvents.userCreated, {
      userId,
      email: 'nina.alvarez@a5roofing.example',
      displayName: 'Nina Alvarez',
      roleKeys: ['sales_rep'],
      createdBy: PEOPLE.grant.id,
    });
    await deliver(event);
    const [row] = await h.db
      .selectFrom('notifications')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(row).toMatchObject({
      type: 'account.welcome',
      title: 'Welcome to the A5 Sales Academy, Nina',
      link: '/training',
    });
  });
});
