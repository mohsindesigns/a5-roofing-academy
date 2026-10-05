import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { learningEvents } from '@a5/events';
import { QueueFactory } from '@a5/messaging';
import { uuidv7 } from '@a5/observability';
import { ORGANIZATION, PEOPLE, PROGRAM, type PersonKey } from '@a5/seed-data';
import { waitFor } from '@a5/testing';
import { EMAIL_QUEUE, emailJobId } from '../src/email/email.dispatcher.js';
import { MaintenanceService } from '../src/email/maintenance.service.js';
import { ContentSealer } from '../src/email/sealer.js';
import { PUSH_QUEUE } from '../src/realtime/push.scheduler.js';
import { createNotificationHarness, deliveriesTo, processed, type NotificationHarness } from './harness.js';

let h: NotificationHarness;

beforeAll(async () => {
  h = await createNotificationHarness('email', { env: { EMAIL_MAX_ATTEMPTS: '3', EMAIL_BACKOFF_MS: '20' } });
});
afterAll(() => h?.close());

async function enroll(person: PersonKey, title = 'Storm Season Refresher') {
  const event = h.event(learningEvents.enrolled, {
    enrollmentId: uuidv7(),
    programId: PROGRAM.id,
    userId: PEOPLE[person].id,
    programTitle: title,
    assignedBy: PEOPLE.danielle.id,
    dueAt: '2026-10-30T17:00:00Z',
    source: 'manual',
  });
  await h.publish(event);
  await processed(h, event.id);
  return event;
}

async function deliveryFor(eventId: string) {
  return h.db.selectFrom('email_deliveries').selectAll().where('source_event_id', '=', eventId).executeTakeFirstOrThrow();
}

describe('email delivery', () => {
  it('renders, sends and records an email', async () => {
    const event = await enroll('kayla');
    await waitFor(async () => (await deliveryFor(event.id)).status === 'sent', { message: 'email sent' });
    const row = await deliveryFor(event.id);
    expect(row).toMatchObject({ to_address: 'kayla.simmons@a5roofing.example', to_name: 'Kayla Simmons', subject: 'You are enrolled in Storm Season Refresher', attempts: 1, last_error: null });
    expect(row.provider_message_id).toMatch(/^<memory-/);
    expect(row.body_text).toContain('Danielle Okafor enrolled you in Storm Season Refresher. Complete it by Oct 30, 2026.');
    const [sent] = h.transport.to('kayla.simmons@a5roofing.example');
    expect(sent).toMatchObject({ from: 'A5 Roofing Sales Academy <academy@a5roofing.example>', subject: row.subject, text: row.body_text, html: row.body_html });
  });

  it('retries transient provider failures with backoff', async () => {
    h.transport.failNext(2, 'SMTP 421 4.3.2 Service not available, closing transmission channel');
    const event = await enroll('jordan');
    await waitFor(async () => (await deliveryFor(event.id)).status === 'sent', { message: 'email sent after retries', timeoutMs: 10_000 });
    const row = await deliveryFor(event.id);
    expect(row.attempts).toBe(3);
    expect(row.last_error).toBeNull();
    expect(h.transport.to('jordan.whitfield@a5roofing.example')).toHaveLength(1);
  });

  it('marks the delivery failed and dead-letters the job after the last attempt', async () => {
    h.transport.failNext(3, '550 5.1.1 Mailbox unavailable');
    const event = await enroll('colton');
    await waitFor(async () => (await deliveryFor(event.id)).status === 'failed', { message: 'email failed', timeoutMs: 10_000 });
    const row = await deliveryFor(event.id);
    expect(row).toMatchObject({ attempts: 3, last_error: '550 5.1.1 Mailbox unavailable' });
    expect(row.failed_at).toBeInstanceOf(Date);
    const dlq = h.app.get(QueueFactory).queue<Record<string, unknown>>(`${EMAIL_QUEUE}.dlq`);
    await waitFor(async () => (await dlq.getJobs(['waiting'])).some((j) => (j.data.data as { deliveryId?: string })?.deliveryId === row.id), {
      message: 'dead-letter entry',
    });
    expect(h.transport.to('colton.hayes@a5roofing.example')).toHaveLength(0);
  });

  it('re-enqueues deliveries whose job was lost and abandons stale security emails', async () => {
    const lostId = uuidv7();
    const sealedId = uuidv7();
    const sealer = h.app.get(ContentSealer);
    await h.db
      .insertInto('email_deliveries')
      .values([
        {
          id: lostId,
          organization_id: ORGANIZATION.id,
          user_id: PEOPLE.darius.id,
          notification_type: 'training.assigned',
          source_event_id: uuidv7(),
          to_address: 'darius.washington@a5roofing.example',
          to_name: 'Darius Washington',
          subject: 'You are enrolled in A5 New Hire Sales Academy',
          body_text: 'Hi Darius,\n\nYou were enrolled in A5 New Hire Sales Academy.',
          body_html: '<p>Hi Darius,</p>',
          scheduled_at: new Date(Date.now() - 10 * 60_000),
        },
        {
          id: sealedId,
          organization_id: ORGANIZATION.id,
          user_id: PEOPLE.ethan.id,
          notification_type: 'account.password_reset',
          source_event_id: uuidv7(),
          to_address: 'ethan.kowalski@a5roofing.example',
          to_name: 'Ethan Kowalski',
          subject: 'Reset your A5 Sales Academy password',
          sealed_content: sealer.seal({ text: 'reset link', html: '<p>reset link</p>' }),
          sensitive: true,
          scheduled_at: new Date(Date.now() - 25 * 3_600_000),
        },
      ])
      .execute();

    const result = await h.app.get(MaintenanceService).runOnce();
    expect(result).toMatchObject({ requeued: 1, expiredSealed: 1 });
    await waitFor(async () => (await h.db.selectFrom('email_deliveries').select('status').where('id', '=', lostId).executeTakeFirstOrThrow()).status === 'sent');
    const sealed = await h.db.selectFrom('email_deliveries').selectAll().where('id', '=', sealedId).executeTakeFirstOrThrow();
    expect(sealed).toMatchObject({ status: 'failed', sealed_content: null });
    expect(sealed.last_error).toContain('Request a new one');
    expect(h.transport.to('ethan.kowalski@a5roofing.example')).toHaveLength(0);
  });

  it('delays notifications and emails of rules with a delay', async () => {
    const admin = await h.as('grant');
    const rule = (await h.http.get('/api/v1/notification-rules?eventType=program.enrolled').set(admin)).body.items[0];
    expect((await h.http.patch(`/api/v1/notification-rules/${rule.id}`).set(admin).send({ delayMinutes: 30 })).status).toBe(200);
    const event = await enroll('devon');
    const notification = await h.db.selectFrom('notifications').selectAll().where('source_event_id', '=', event.id).executeTakeFirstOrThrow();
    expect(notification.available_at.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    const delivery = await deliveryFor(event.id);
    expect(delivery.status).toBe('queued');
    expect(delivery.scheduled_at.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    const queues = h.app.get(QueueFactory);
    // Jobs are enqueued right after the transaction commits, so give them a moment to appear.
    const stateOf = (queue: string, jobId: string) => async () => (await queues.queue(queue).getJob(jobId))?.getState();
    expect(await waitFor(stateOf(EMAIL_QUEUE, emailJobId(delivery.id)), { message: 'email job' })).toBe('delayed');
    expect(await waitFor(stateOf(PUSH_QUEUE, `push-${notification.id}`), { message: 'push job' })).toBe('delayed');
    const devon = await h.http.get('/api/v1/notifications').set(await h.as('devon'));
    expect(devon.body.items.some((n: { id: string }) => n.id === notification.id)).toBe(false);
    await h.http.patch(`/api/v1/notification-rules/${rule.id}`).set(admin).send({ delayMinutes: 0 });
  });

  it('applies retention to old read notifications', async () => {
    const old = new Date(Date.now() - 800 * 86_400_000);
    const id = uuidv7(old.getTime());
    await h.db
      .insertInto('notifications')
      .values({
        id,
        organization_id: ORGANIZATION.id,
        user_id: PEOPLE.ashlyn.id,
        type: 'assessment.passed',
        title: 'You passed Week 1 Knowledge Check',
        body: 'You scored 90%.',
        link: null,
        data: '{}',
        source_event_id: uuidv7(),
        available_at: old,
        read_at: old,
      })
      .execute();
    const result = await h.app.get(MaintenanceService).runOnce();
    expect(result.deletedNotifications).toBeGreaterThanOrEqual(1);
    expect(await h.db.selectFrom('notifications').select('id').where('id', '=', id).execute()).toHaveLength(0);
    expect((await deliveriesTo(h, 'kayla')).length).toBeGreaterThan(0);
  });
});
