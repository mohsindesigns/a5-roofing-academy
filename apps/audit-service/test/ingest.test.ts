import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@a5/database';
import { PRODUCERS, type Producer } from '@a5/events';
import { uuidv7 } from '@a5/observability';
import { ORGANIZATION, PEOPLE } from '@a5/seed-data';
import { waitFor } from '@a5/testing';
import { AuditIngest } from '../src/ingest/audit-ingest.js';
import { createAuditHarness, stored, type AuditHarness } from './harness.js';

let h: AuditHarness;

beforeAll(async () => {
  h = await createAuditHarness('ingest');
});
afterAll(() => h?.close());

describe('consumption from every producer stream', () => {
  it('stores audit.recorded events published on each service’s own stream', async () => {
    const services: Array<[Producer, string, string]> = [
      ['identity-service', 'user.created', 'user'],
      ['learning-service', 'program.published', 'program'],
      ['assessment-service', 'assessment.updated', 'assessment'],
      ['ai-coaching-service', 'ai_scenario.updated', 'ai_scenario'],
      ['certification-service', 'certificate.issued', 'certificate'],
      ['notification-service', 'notification_template.updated', 'notification_template'],
      ['media-service', 'media_asset.deleted', 'media_asset'],
      ['analytics-service', 'report.exported', 'report'],
    ];
    const events = services.map(([producer, action, resourceType], i) =>
      h.event(
        producer,
        {
          action,
          resourceType,
          resourceId: uuidv7(),
          actorDisplay: 'Grant Holloway',
          after: { n: i },
          reason: i === 0 ? 'Onboarding a new hire' : null,
          ip: '198.51.100.21',
          userAgent: 'Mozilla/5.0 (Macintosh)',
          requestId: `req-${i}-abcdefgh`,
          metadata: { source: producer },
        },
        { occurredAt: new Date(`2026-09-1${i}T15:00:00Z`), correlationId: `corr-${i}-abcdefgh` },
      ),
    );
    for (const event of events) await h.publish(event);
    const rows = await Promise.all(events.map((e) => stored(h, e.id)));

    rows.forEach((row, i) => {
      const [producer, action, resourceType] = services[i]!;
      expect(row).toMatchObject({
        id: events[i]!.id,
        organization_id: ORGANIZATION.id,
        occurred_at: new Date(`2026-09-1${i}T15:00:00Z`),
        actor_type: 'user',
        actor_id: PEOPLE.grant.id,
        actor_display: 'Grant Holloway',
        action,
        resource_type: resourceType,
        service: producer,
        after: { n: i },
        before: null,
        ip: '198.51.100.21',
        user_agent: 'Mozilla/5.0 (Macintosh)',
        request_id: `req-${i}-abcdefgh`,
        correlation_id: `corr-${i}-abcdefgh`,
        metadata: { source: producer },
      });
    });
    expect(rows[0]!.reason).toBe('Onboarding a new hire');
    expect(rows[1]!.reason).toBeNull();
  });

  it('reads the streams of every known producer', async () => {
    // The consumer group exists on all producer streams, including the gateway’s.
    for (const producer of PRODUCERS) {
      const event = h.event(producer, { action: `probe.${producer}`, resourceType: 'probe', resourceId: null, actorDisplay: null }, { actor: { type: 'service', id: producer } });
      await h.publish(event);
      const row = await stored(h, event.id);
      expect(row).toMatchObject({ service: producer, actor_type: 'service', actor_id: producer, resource_id: null, actor_display: null });
    }
  });

  it('keeps entries without an organization (platform-level actions)', async () => {
    const event = h.event(
      'identity-service',
      { action: 'organization.created', resourceType: 'organization', resourceId: uuidv7(), actorDisplay: 'Priya Raman' },
      { organizationId: null, actor: { type: 'system', id: null } },
    );
    await h.publish(event);
    expect(await stored(h, event.id)).toMatchObject({ organization_id: null, actor_type: 'system', actor_id: null });
  });
});

describe('idempotency', () => {
  it('stores a redelivered event once', async () => {
    const event = h.event('certification-service', { action: 'certificate.revoked', resourceType: 'certificate', resourceId: uuidv7(), actorDisplay: 'Shelby Hartman', reason: 'Issued in error' });
    await h.publish(event);
    await stored(h, event.id);
    // The relay crashed after XADD and published again; the stream consumer sees it twice.
    await h.publish(event);
    await h.publish(event);
    await new Promise((r) => setTimeout(r, 400));
    const rows = await h.db.selectFrom('audit_logs').select('id').where('id', '=', event.id).execute();
    expect(rows).toHaveLength(1);
    const inbox = await h.db.selectFrom('inbox_events').select('handler').where('event_id', '=', event.id).execute();
    expect(inbox).toEqual([{ handler: 'audit.record' }]);
  });

  it('is a no-op when the handler runs again, even without the inbox row', async () => {
    const ingest = h.app.get(AuditIngest);
    const event = h.event('learning-service', { action: 'enrollment.created', resourceType: 'enrollment', resourceId: uuidv7(), actorDisplay: 'Danielle Okafor' });
    expect(await ingest.record(event)).toBe(true);
    expect(await ingest.record(event)).toBe(false);
    await h.db.deleteFrom('inbox_events').where('event_id', '=', event.id).execute();
    expect(await ingest.record(event)).toBe(false);
    expect(await h.db.selectFrom('audit_logs').select('id').where('id', '=', event.id).execute()).toHaveLength(1);
  });
});

describe('what is stored', () => {
  it('masks secret-looking keys in snapshots and metadata', async () => {
    const event = h.event('identity-service', {
      action: 'user.updated',
      resourceType: 'user',
      resourceId: PEOPLE.marcus.id,
      actorDisplay: 'Grant Holloway',
      before: { email: 'marcus.delgado@a5roofing.example', passwordHash: '$argon2id$v=19$m=19456', profile: { refreshToken: 'rt_abc', phone: '(214) 555-2201' } },
      after: { email: 'marcus.d@a5roofing.example', items: [{ apiKey: 'sk_live_123', label: 'CRM' }] },
      metadata: { authorization: 'Bearer abc.def.ghi', note: 'rotated' },
    });
    await h.publish(event);
    const row = await stored(h, event.id);
    expect(row.before).toEqual({ email: 'marcus.delgado@a5roofing.example', passwordHash: '[redacted]', profile: { refreshToken: '[redacted]', phone: '(214) 555-2201' } });
    expect(row.after).toEqual({ email: 'marcus.d@a5roofing.example', items: [{ apiKey: '[redacted]', label: 'CRM' }] });
    expect(row.metadata).toEqual({ authorization: '[redacted]', note: 'rotated' });
    const raw = JSON.stringify(row);
    for (const secret of ['argon2id', 'rt_abc', 'sk_live_123', 'abc.def.ghi']) expect(raw).not.toContain(secret);
  });

  it('replaces oversized snapshots with a marker and clips long text', async () => {
    const event = h.event('learning-service', {
      action: 'program.published',
      resourceType: 'program',
      resourceId: uuidv7(),
      actorDisplay: 'S'.repeat(500),
      after: { blob: 'x'.repeat(100_000) },
      before: { small: true },
      reason: 'r'.repeat(5_000),
      ip: '1'.repeat(200),
    });
    await h.publish(event);
    const row = await stored(h, event.id);
    expect(row.after).toMatchObject({ _truncated: true, _bytes: expect.any(Number) });
    expect(row.before).toEqual({ small: true });
    expect(row.actor_display).toHaveLength(200);
    expect(row.reason).toHaveLength(2_000);
    expect(row.ip).toHaveLength(64);
  });

  it('dead-letters events that violate the contract instead of storing them', async () => {
    const bad = h.event('identity-service', { action: 'user.created', resourceType: 'user', resourceId: null, actorDisplay: null });
    const envelope = { ...bad, payload: { resourceType: 'user' } };
    await h.redis.xadd(h.ns.stream('events:identity'), '*', 'id', bad.id, 'type', bad.type, 'envelope', JSON.stringify(envelope));
    await waitFor(async () => (await h.redis.xlen(h.ns.key('dlq', 'audit-service'))) === 1, { message: 'dead letter', timeoutMs: 10_000 });
    expect(await h.db.selectFrom('audit_logs').select('id').where('id', '=', bad.id).execute()).toHaveLength(0);
  });

  it('routes entries to the default partition when their month has no partition yet', async () => {
    const event = h.event('identity-service', { action: 'user.created', resourceType: 'user', resourceId: uuidv7(), actorDisplay: 'Grant Holloway' }, { occurredAt: new Date('2019-03-04T16:00:00Z') });
    await h.publish(event);
    await stored(h, event.id);
    const inDefault = await sql<{ id: string }>`select id from audit_logs_default where id = ${event.id}`.execute(h.db);
    expect(inDefault.rows).toHaveLength(1);
  });
});
