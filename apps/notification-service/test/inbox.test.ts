import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@a5/observability';
import { ORGANIZATION, PEOPLE, type PersonKey } from '@a5/seed-data';
import { createNotificationHarness, type NotificationHarness } from './harness.js';

let h: NotificationHarness;

const types = [
  'training.assigned',
  'assessment.passed',
  'ai.feedback_ready',
  'certificate.generated',
] as const;

/** Insert inbox rows directly: `count` notifications one minute apart, the oldest `read` of them read. */
async function fillInbox(person: PersonKey, count: number, read: number) {
  const base = Date.now() - 60_000;
  const rows = Array.from({ length: count }, (_, i) => {
    const at = new Date(base - i * 60_000);
    return {
      id: uuidv7(at.getTime()),
      organization_id: ORGANIZATION.id,
      user_id: PEOPLE[person].id,
      type: types[i % types.length]!,
      title: `Notification ${i + 1}`,
      body: 'Body text',
      link: '/training',
      data: JSON.stringify({ index: i + 1 }),
      source_event_id: uuidv7(),
      available_at: at,
      read_at: i >= count - read ? new Date(at.getTime() + 1_000) : null,
    };
  });
  await h.db.insertInto('notifications').values(rows).execute();
  return rows;
}

beforeAll(async () => {
  h = await createNotificationHarness('inbox', { role: 'api' });
});
afterAll(() => h?.close());

describe('inbox', () => {
  it('requires authentication', async () => {
    expect((await h.http.get('/api/v1/notifications')).status).toBe(401);
    expect((await h.http.get('/api/v1/notifications/unread-count')).status).toBe(401);
  });

  it('pages through the caller’s notifications newest first with a keyset cursor', async () => {
    const rows = await fillInbox('kayla', 25, 10);
    await fillInbox('jordan', 3, 0);
    const kayla = await h.as('kayla');

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await h.http
        .get(`/api/v1/notifications?limit=10${cursor ? `&cursor=${cursor}` : ''}`)
        .set(kayla);
      expect(res.status).toBe(200);
      expect(res.body.unreadCount).toBe(15);
      seen.push(...res.body.items.map((n: { id: string }) => n.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(rows.map((r) => r.id));

    const first = (await h.http.get('/api/v1/notifications?limit=1').set(kayla)).body.items[0];
    expect(first).toMatchObject({
      id: rows[0]!.id,
      type: 'training.assigned',
      category: 'training',
      title: 'Notification 1',
      link: '/training',
      data: { index: 1 },
      priority: 'normal',
      readAt: null,
    });

    const unread = await h.http.get('/api/v1/notifications?unread=true&limit=100').set(kayla);
    expect(unread.body.items).toHaveLength(15);
    expect(unread.body.items.every((n: { readAt: string | null }) => n.readAt === null)).toBe(true);

    const certs = await h.http
      .get('/api/v1/notifications?category=certifications&limit=100')
      .set(kayla);
    expect(certs.body.items.every((n: { type: string }) => n.type.startsWith('certificate.'))).toBe(
      true,
    );
    expect(certs.body.items.length).toBe(6);

    expect((await h.http.get('/api/v1/notifications?cursor=not-a-cursor').set(kayla)).status).toBe(
      400,
    );
    expect((await h.http.get('/api/v1/notifications?limit=500').set(kayla)).status).toBe(400);
  });

  it('counts unread, marks one or all as read, and never touches other inboxes', async () => {
    const jordan = await h.as('jordan');
    const kayla = await h.as('kayla');
    expect((await h.http.get('/api/v1/notifications/unread-count').set(jordan)).body).toEqual({
      count: 3,
    });

    const [target] = (await h.http.get('/api/v1/notifications?limit=1').set(jordan)).body.items;
    const read = await h.http.post(`/api/v1/notifications/${target.id}/read`).set(jordan);
    expect(read.status).toBe(200);
    expect(read.body.readAt).toEqual(expect.any(String));
    expect((await h.http.get('/api/v1/notifications/unread-count').set(jordan)).body).toEqual({
      count: 2,
    });
    // Idempotent.
    const again = await h.http.post(`/api/v1/notifications/${target.id}/read`).set(jordan);
    expect(again.status).toBe(200);
    expect(again.body.readAt).toBe(read.body.readAt);

    // Someone else's notification is indistinguishable from a missing one.
    expect((await h.http.post(`/api/v1/notifications/${target.id}/read`).set(kayla)).status).toBe(
      404,
    );
    expect((await h.http.post(`/api/v1/notifications/${uuidv7()}/read`).set(jordan)).status).toBe(
      404,
    );
    expect((await h.http.post('/api/v1/notifications/nope/read').set(jordan)).status).toBe(400);

    const all = await h.http.post('/api/v1/notifications/read-all').set(jordan);
    expect(all.body).toEqual({ updated: 2, unreadCount: 0 });
    expect((await h.http.get('/api/v1/notifications/unread-count').set(kayla)).body).toEqual({
      count: 15,
    });
  });

  it('keeps delayed notifications out of the inbox until they are due', async () => {
    const colton = await h.as('colton');
    await h.db
      .insertInto('notifications')
      .values({
        id: uuidv7(),
        organization_id: ORGANIZATION.id,
        user_id: PEOPLE.colton.id,
        type: 'training.overdue',
        title: 'A5 New Hire Sales Academy is overdue',
        body: 'Pick up where you left off today.',
        link: null,
        data: '{}',
        source_event_id: uuidv7(),
        available_at: new Date(Date.now() + 3_600_000),
      })
      .execute();
    expect((await h.http.get('/api/v1/notifications').set(colton)).body.items).toHaveLength(0);
    expect((await h.http.get('/api/v1/notifications/unread-count').set(colton)).body).toEqual({
      count: 0,
    });
    expect((await h.http.post('/api/v1/notifications/read-all').set(colton)).body).toEqual({
      updated: 0,
      unreadCount: 0,
    });
  });
});

describe('preferences', () => {
  it('lists what a person can receive, with manager topics only for managers', async () => {
    const rep = await h.http.get('/api/v1/notifications/preferences').set(await h.as('marcus'));
    expect(rep.status).toBe(200);
    const repTypes = rep.body.items.map((i: { type: string }) => i.type);
    expect(repTypes).toContain('assessment.failed');
    expect(repTypes).not.toContain('approval.requested');
    expect(repTypes).not.toContain('account.invitation');
    expect(rep.body.items.find((i: { type: string }) => i.type === 'assessment.failed')).toEqual({
      type: 'assessment.failed',
      label: 'Assessment not passed',
      description: 'Tells the learner they did not reach the pass mark and what to do next.',
      category: 'assessments',
      channels: [
        { channel: 'in_app', enabled: true },
        { channel: 'email', enabled: true },
      ],
    });
    // Only the channels the organization's rule actually uses are offered.
    expect(
      rep.body.items.find((i: { type: string }) => i.type === 'assessment.passed').channels,
    ).toEqual([{ channel: 'in_app', enabled: true }]);

    const manager = await h.http
      .get('/api/v1/notifications/preferences')
      .set(await h.as('danielle'));
    expect(manager.body.items.map((i: { type: string }) => i.type)).toEqual(
      expect.arrayContaining(['approval.requested', 'assessment.failed.manager']),
    );
  });

  it('saves opt-outs and rejects security messages and unsupported channels', async () => {
    const marcus = await h.as('marcus');
    const saved = await h.http
      .put('/api/v1/notifications/preferences')
      .set(marcus)
      .send({ preferences: [{ type: 'training.assigned', channel: 'email', enabled: false }] });
    expect(saved.status).toBe(200);
    expect(
      saved.body.items.find((i: { type: string }) => i.type === 'training.assigned').channels,
    ).toEqual([
      { channel: 'in_app', enabled: true },
      { channel: 'email', enabled: false },
    ]);

    const security = await h.http
      .put('/api/v1/notifications/preferences')
      .set(marcus)
      .send({
        preferences: [{ type: 'account.password_reset', channel: 'email', enabled: false }],
      });
    expect(security.status).toBe(400);
    expect(security.body.error.fields[0]).toEqual({
      path: 'preferences.0.type',
      message: 'Password reset messages are always sent for account security',
    });

    const channel = await h.http
      .put('/api/v1/notifications/preferences')
      .set(marcus)
      .send({ preferences: [{ type: 'certificate.generated', channel: 'email', enabled: false }] });
    expect(channel.status).toBe(400);
    expect(channel.body.error.fields[0].path).toBe('preferences.0.channel');

    expect(
      (await h.http.put('/api/v1/notifications/preferences').set(marcus).send({ preferences: [] }))
        .status,
    ).toBe(400);
  });
});
