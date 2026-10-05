import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assessmentEvents, identityEvents, learningEvents } from '@a5/events';
import { principalHeaders } from '@a5/nest-kit/testing';
import { uuidv7 } from '@a5/observability';
import { ASSESSMENTS, PEOPLE, PROGRAM } from '@a5/seed-data';
import { waitFor } from '@a5/testing';
import { NOTIFICATION_TYPE_DEFS } from '../src/catalog/notification-types.js';
import { APP_URL, createNotificationHarness, notificationsOf, processed, type NotificationHarness } from './harness.js';

let h: NotificationHarness;
let admin: Record<string, string>;

beforeAll(async () => {
  h = await createNotificationHarness('admin');
  admin = await h.as('grant');
});
afterAll(() => h?.close());

async function template(type: string, channel: 'in_app' | 'email') {
  const res = await h.http.get(`/api/v1/notification-templates?type=${type}&channel=${channel}`).set(admin);
  expect(res.status).toBe(200);
  return res.body.items[0] as { id: string; subject: string; body: string; isDefault: boolean };
}

async function rule(type: string) {
  const res = await h.http.get('/api/v1/notification-rules').set(admin);
  return res.body.items.find((r: { type: string }) => r.type === type) as { id: string; recipients: string[]; enabled: boolean };
}

async function auditActions(): Promise<Array<{ action: string; resourceId: string; actorDisplay: string; before: unknown; after: unknown }>> {
  const rows = await h.db.selectFrom('outbox_events').select('envelope').where('type', '=', 'audit.recorded').orderBy('created_at').execute();
  return rows.map((r) => (r.envelope as { payload: never }).payload);
}

describe('permissions', () => {
  it('limits administration to notifications.manage', async () => {
    for (const path of ['/api/v1/notification-templates', '/api/v1/notification-rules', '/api/v1/notifications/email-deliveries']) {
      expect((await h.http.get(path)).status, path).toBe(401);
      for (const person of ['marcus', 'danielle', 'ruth', 'shelby'] as const) {
        const res = await h.http.get(path).set(await h.as(person));
        expect(res.status, `${person} ${path}`).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
      expect((await h.http.get(path).set(admin)).status, path).toBe(200);
      expect((await h.http.get(path).set(await h.as('priya'))).status, path).toBe(200);
    }
    const t = await template('training.assigned', 'email');
    expect((await h.http.patch(`/api/v1/notification-templates/${t.id}`).set(await h.as('danielle')).send({ subject: 'x' })).status).toBe(403);
  });

  it('isolates organizations', async () => {
    const t = await template('training.assigned', 'email');
    const outsider = await principalHeaders({
      userId: uuidv7(),
      organizationId: uuidv7(),
      displayName: 'Other Org Admin',
      permissions: ['notifications.manage'],
    });
    expect((await h.http.get(`/api/v1/notification-templates/${t.id}`).set(outsider)).status).toBe(404);
    // Their own organization gets its own defaults.
    const own = await h.http.get('/api/v1/notification-templates').set(outsider);
    expect(own.body.items.map((i: { id: string }) => i.id)).not.toContain(t.id);
    expect((await h.http.get('/api/v1/notifications/email-deliveries').set(outsider)).body.total).toBe(0);
  });
});

describe('templates', () => {
  it('lists every template with its variables', async () => {
    const res = await h.http.get('/api/v1/notification-templates').set(admin);
    const expected = NOTIFICATION_TYPE_DEFS.reduce((n, d) => n + d.channels.length, 0);
    expect(res.body.items).toHaveLength(expected);
    const invitation = res.body.items.find((i: { type: string }) => i.type === 'account.invitation');
    expect(invitation).toMatchObject({ channel: 'email', sensitive: true, isDefault: true, updatedBy: null, category: 'account' });
    expect(invitation.variables.map((v: { name: string }) => v.name)).toEqual(['recipientFirstName', 'recipientName', 'link', 'appUrl', 'learnerName', 'learnerFirstName', 'inviterName', 'expiresAt']);
    const byCategory = await h.http.get('/api/v1/notification-templates?category=approvals').set(admin);
    expect(new Set(byCategory.body.items.map((i: { type: string }) => i.type))).toEqual(new Set(['approval.requested', 'approval.approved', 'approval.rejected']));
  });

  it('validates placeholders against the type’s variables', async () => {
    const t = await template('assessment.failed', 'in_app');
    const unknown = await h.http.patch(`/api/v1/notification-templates/${t.id}`).set(admin).send({ body: 'Score: {{score}}' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.fields[0].path).toBe('body');
    expect(unknown.body.error.fields[0].message).toContain('Unknown variable {{score}}');
    expect(unknown.body.error.fields[0].message).toContain('{{scorePercent}}');
    const malformed = await h.http.patch(`/api/v1/notification-templates/${t.id}`).set(admin).send({ subject: 'Try {{assessmentTitle again' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.fields[0].message).toContain('Fix the placeholder');
    expect((await h.http.patch(`/api/v1/notification-templates/${t.id}`).set(admin).send({})).status).toBe(400);

    const invite = await template('account.invitation', 'email');
    const leak = await h.http.patch(`/api/v1/notification-templates/${invite.id}`).set(admin).send({ subject: 'Activate: {{link}}' });
    expect(leak.status).toBe(400);
    const disable = await h.http.patch(`/api/v1/notification-templates/${invite.id}`).set(admin).send({ enabled: false });
    expect(disable.status).toBe(422);
    expect(disable.body.error.code).toBe('TEMPLATE_REQUIRED');
  });

  it('applies edits to new notifications, audits them and resets to the default', async () => {
    const t = await template('assessment.failed', 'in_app');
    const updated = await h.http
      .patch(`/api/v1/notification-templates/${t.id}`)
      .set(admin)
      .send({ subject: 'Keep going on {{assessmentTitle}}', body: '{{scorePercent}}% this time; {{passingPercent}}% passes. Review and retake.' });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ isDefault: false, updatedBy: { id: PEOPLE.grant.id, displayName: 'Grant Holloway' } });

    const quiz = ASSESSMENTS[0]!;
    const event = h.event(assessmentEvents.attemptGraded, {
      attemptId: uuidv7(),
      assessmentId: quiz.id,
      assessmentTitle: quiz.title,
      kind: 'quiz',
      userId: PEOPLE.jordan.id,
      attemptNumber: 2,
      scorePercent: 62.5,
      passed: false,
      passingPercent: 80,
      gradedAt: new Date().toISOString(),
      overridden: false,
      context: {},
      questionResults: [],
    });
    await h.publish(event);
    await processed(h, event.id);
    const [n] = await notificationsOf(h, 'jordan');
    expect(n).toMatchObject({ title: 'Keep going on Week 1 Knowledge Check', body: '62.5% this time; 80% passes. Review and retake.' });

    const reset = await h.http.post(`/api/v1/notification-templates/${t.id}/reset`).set(admin);
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ isDefault: true, subject: '{{assessmentTitle}}: {{scorePercent}}%, not passed yet', enabled: true });

    const audits = await auditActions();
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['notification_template.updated', 'notification_template.reset']));
    const edit = audits.find((a) => a.action === 'notification_template.updated' && a.resourceId === t.id)!;
    expect(edit).toMatchObject({ actorDisplay: 'Grant Holloway', before: { subject: t.subject }, after: { subject: 'Keep going on {{assessmentTitle}}' } });
  });

  it('previews templates with sample data, escaping HTML', async () => {
    const t = await template('approval.requested', 'email');
    const res = await h.http
      .post(`/api/v1/notification-templates/${t.id}/preview`)
      .set(admin)
      .send({ data: { learnerName: '<img src=x onerror=alert(1)>' }, body: 'Hi {{recipientFirstName}},\n\n{{learnerName}} needs {{lessonTitle}}.' });
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('email');
    expect(res.body.subject).toBe('Approval needed: <img src=x onerror=alert(1)>, Manager Field-Ready Sign-off');
    expect(res.body.text).toContain('Hi Andre,');
    expect(res.body.html).toContain('&lt;img src=x onerror=alert(1)&gt; needs Manager Field-Ready Sign-off.');
    expect(res.body.html).not.toContain('<img');
    expect(res.body.html).toContain(`${APP_URL}/training`);

    const inApp = await template('certificate.issued', 'in_app');
    const preview = await h.http.post(`/api/v1/notification-templates/${inApp.id}/preview`).set(admin).send({});
    expect(preview.body).toMatchObject({ channel: 'in_app', subject: 'Certificate earned: A5 Roofing Certified Sales Representative', html: null });
    expect((await h.http.post(`/api/v1/notification-templates/${inApp.id}/preview`).set(admin).send({ body: '{{nope}}' })).status).toBe(400);
  });
});

describe('rules', () => {
  it('describes each rule with what can be configured', async () => {
    const res = await h.http.get('/api/v1/notification-rules?eventType=assessment.attempt.graded').set(admin);
    expect(res.body.items.map((r: { type: string }) => r.type)).toEqual(['assessment.passed', 'assessment.failed', 'assessment.failed.manager']);
    expect(res.body.items[2]).toMatchObject({
      eventType: 'assessment.attempt.graded',
      recipients: ['managers'],
      channels: ['in_app'],
      supportedChannels: ['in_app', 'email'],
      fixedConditions: { passed: false },
      conditions: { kind: ['quiz', 'exam', 'final'] },
      allowedRecipients: ['subject', 'managers', 'team_managers', 'trainers', 'enrolled_learners', 'role:<key>'],
      enabled: true,
      mandatory: false,
    });
  });

  it('validates recipients and channels', async () => {
    const approval = await rule('approval.requested');
    const res = await h.http.patch(`/api/v1/notification-rules/${approval.id}`).set(admin).send({ recipients: ['managers', 'role:'] });
    expect(res.status).toBe(400);
    const generated = await rule('certificate.generated');
    const channel = await h.http.patch(`/api/v1/notification-rules/${generated.id}`).set(admin).send({ channels: ['email'] });
    expect(channel.status).toBe(400);
    expect(channel.body.error.fields[0]).toEqual({ path: 'channels.0', message: 'Certificate ready to download is only sent by in-app notification.' });
    const enrolled = await rule('certificate.issued');
    const recipients = await h.http.patch(`/api/v1/notification-rules/${enrolled.id}`).set(admin).send({ recipients: ['enrolled_learners'] });
    expect(recipients.status).toBe(400);
    const conditions = await h.http.patch(`/api/v1/notification-rules/${enrolled.id}`).set(admin).send({ conditions: { 'mode..x': 1 } });
    expect(conditions.status).toBe(400);
  });

  it('locks security rules', async () => {
    const reset = await rule('account.password_reset');
    const res = await h.http.post(`/api/v1/notification-rules/${reset.id}/disable`).set(admin);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RULE_LOCKED');
  });

  it('disables, re-enables and narrows rules with conditions', async () => {
    const assigned = await rule('training.assigned');
    const disabled = await h.http.post(`/api/v1/notification-rules/${assigned.id}/disable`).set(admin);
    expect(disabled.body.enabled).toBe(false);
    const event = h.event(learningEvents.enrolled, {
      enrollmentId: uuidv7(),
      programId: PROGRAM.id,
      userId: PEOPLE.isaiah.id,
      programTitle: PROGRAM.title,
      assignedBy: null,
      dueAt: null,
      source: 'rule',
    });
    await h.publish(event);
    await processed(h, event.id);
    expect((await notificationsOf(h, 'isaiah')).some((n) => n.source_event_id === event.id)).toBe(false);
    expect((await h.http.post(`/api/v1/notification-rules/${assigned.id}/enable`).set(admin)).body.enabled).toBe(true);

    const managerRule = await rule('assessment.failed.manager');
    const narrowed = await h.http.patch(`/api/v1/notification-rules/${managerRule.id}`).set(admin).send({ conditions: { kind: ['final'] } });
    expect(narrowed.body.conditions).toEqual({ kind: ['final'] });
    const quiz = ASSESSMENTS[1]!;
    const failed = h.event(assessmentEvents.attemptGraded, {
      attemptId: uuidv7(),
      assessmentId: quiz.id,
      assessmentTitle: quiz.title,
      kind: 'quiz',
      userId: PEOPLE.naomi.id,
      attemptNumber: 1,
      scorePercent: 60,
      passed: false,
      passingPercent: 80,
      gradedAt: new Date().toISOString(),
      overridden: false,
      context: {},
      questionResults: [],
    });
    await h.publish(failed);
    await processed(h, failed.id);
    expect((await notificationsOf(h, 'luis')).some((n) => n.source_event_id === failed.id)).toBe(false);
    expect((await notificationsOf(h, 'naomi')).some((n) => n.source_event_id === failed.id)).toBe(true);

    const audits = (await auditActions()).map((a) => a.action);
    expect(audits).toEqual(expect.arrayContaining(['notification_rule.disabled', 'notification_rule.enabled', 'notification_rule.updated']));
  });
});

describe('email delivery log', () => {
  it('lists deliveries and hides security email content', async () => {
    const token = 'tok_e2a6f1c7b0d94a3fa7f1';
    const invite = h.event(identityEvents.invitationCreated, {
      userId: uuidv7(),
      email: 'paige.lindqvist@a5roofing.example',
      displayName: 'Paige Lindqvist',
      activationUrl: `${APP_URL}/activate?token=${token}`,
      expiresAt: '2026-10-08T15:00:00Z',
      invitedByName: 'Grant Holloway',
    });
    await h.publish(invite);
    await processed(h, invite.id);
    await waitFor(async () => (await h.http.get('/api/v1/notifications/email-deliveries?status=sent&q=paige').set(admin)).body.total === 1);

    const list = await h.http.get('/api/v1/notifications/email-deliveries?pageSize=5').set(admin);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ page: 1, pageSize: 5 });
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    const entry = (await h.http.get('/api/v1/notifications/email-deliveries?q=paige').set(admin)).body.items[0];
    expect(entry).toMatchObject({ type: 'account.invitation', to: 'paige.lindqvist@a5roofing.example', toName: 'Paige Lindqvist', status: 'sent', sensitive: true, attempts: 1 });
    const detail = await h.http.get(`/api/v1/notifications/email-deliveries/${entry.id}`).set(admin);
    expect(detail.body).toMatchObject({ text: null, html: null });
    expect(JSON.stringify(detail.body)).not.toContain(token);

    const filtered = await h.http.get('/api/v1/notifications/email-deliveries?type=account.invitation&status=failed').set(admin);
    expect(filtered.body.items.every((i: { status: string }) => i.status === 'failed')).toBe(true);
    expect((await h.http.get(`/api/v1/notifications/email-deliveries/${uuidv7()}`).set(admin)).status).toBe(404);
    expect((await h.http.get('/api/v1/notifications/email-deliveries?status=bounced').set(admin)).status).toBe(400);
  });
});
