import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@a5/database';
import { principalHeaders } from '@a5/nest-kit/testing';
import { uuidv7 } from '@a5/observability';
import { ORGANIZATION, PEOPLE } from '@a5/seed-data';
import { LogsRepository } from '../src/logs/logs.repository.js';
import { ensurePartitions, monthsBetween } from '../src/partitions/partitions.js';
import { OTHER_ORG, createAuditHarness, type AuditHarness, type TestEntry } from './harness.js';

let h: AuditHarness;
let ruth: Record<string, string>;
let ids: Record<string, string>;

const at = (day: string, hour = 12) => new Date(`2026-09-${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);
const get = (path: string, who: Record<string, string> = ruth) => h.http.get(path).set(who);
const idsOf = (body: { items: Array<{ id: string }> }) => body.items.map((i) => i.id);

/** Minimal RFC 4180 parser for the export tests. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

const specific: Array<TestEntry & { key: string }> = [
  { key: 'enroll', occurredAt: at('02'), actorId: PEOPLE.danielle.id, actorDisplay: 'Danielle Okafor', action: 'enrollment.created', resourceType: 'enrollment', resourceId: 'enr-1', service: 'learning-service', reason: 'Cohort start for Dallas Residential A' },
  { key: 'created', occurredAt: at('03'), action: 'user.created', resourceType: 'user', resourceId: PEOPLE.marcus.id, service: 'identity-service', after: { name: 'Marcus Delgado', roleIds: ['r1'] } },
  { key: 'updated', occurredAt: at('04'), action: 'user.updated', resourceType: 'user', resourceId: PEOPLE.marcus.id, service: 'identity-service', before: { phone: null }, after: { phone: '(214) 555-2201' }, ip: '198.51.100.21', userAgent: 'Mozilla/5.0', requestId: 'req-abcdef12', correlationId: 'corr-abcdef12', metadata: { via: 'admin console' } },
  { key: 'issued', occurredAt: at('05'), actorType: 'system', actorId: null, actorDisplay: 'System', action: 'certificate.issued', resourceType: 'certificate', resourceId: 'cert-1', service: 'certification-service' },
  { key: 'exported', occurredAt: at('06'), actorId: PEOPLE.ruth.id, actorDisplay: 'Ruth Abernathy', action: 'audit_logs.exported', resourceType: 'audit_log', resourceId: null, service: 'audit-service' },
  { key: 'decoy', occurredAt: at('06', 13), actorId: PEOPLE.ruth.id, actorDisplay: 'Ruth Abernathy', action: 'auditXlogs.exported', resourceType: 'audit_log', resourceId: null, service: 'audit-service' },
  { key: 'percent', occurredAt: at('07'), action: 'role.updated', resourceType: 'role', resourceId: 'role-1', service: 'identity-service', reason: 'Grant 100% access to reports' },
  { key: 'apples', occurredAt: at('07', 13), action: 'role.updated', resourceType: 'role', resourceId: 'role-2', service: 'identity-service', reason: '100 apples' },
];

beforeAll(async () => {
  h = await createAuditHarness('api', { role: 'api' });
  ruth = await h.as('ruth');
  await ensurePartitions(h.db as never, monthsBetween(new Date('2026-08-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z')));
  const created = await h.insert(specific);
  ids = Object.fromEntries(specific.map((e, i) => [e.key, created[i]!]));
  await h.insert([
    // Another organization, with entries that look like A5's.
    ...Array.from({ length: 5 }, (_, i) => ({ organizationId: OTHER_ORG, occurredAt: at('03', 10 + i), action: 'user.created', actorDisplay: 'Other Admin', resourceId: `other-user-${i}`, service: 'identity-service' })),
    // Ten entries at the exact same instant: pagination must not skip or repeat any.
    ...Array.from({ length: 10 }, (_, i) => ({ occurredAt: new Date('2026-09-15T14:00:00.000Z'), resourceType: 'tie', resourceId: `tie-${i}`, action: 'tie.test', service: 'tie-service' })),
  ]);
});
afterAll(() => h?.close());

describe('permissions', () => {
  const paths = (id: string) => [
    '/api/v1/audit/logs',
    `/api/v1/audit/logs/${id}`,
    '/api/v1/audit/resources/user/abc/history',
    '/api/v1/audit/facets',
    '/api/v1/audit/export?service=nothing-here',
  ];

  it('requires authentication', async () => {
    for (const path of paths(ids.created!)) expect((await h.http.get(path)).status, path).toBe(401);
  });

  it('requires audit_logs.view', async () => {
    for (const person of ['marcus', 'danielle', 'hector', 'shelby'] as const) {
      const who = await h.as(person);
      for (const path of paths(ids.created!)) {
        const res = await get(path, who);
        expect(res.status, `${person} ${path}`).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
    }
    for (const person of ['ruth', 'grant', 'priya'] as const) {
      const who = await h.as(person);
      for (const path of paths(ids.created!)) expect((await get(path, who)).status, `${person} ${path}`).toBe(200);
    }
  });

  it('offers no way to change entries', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await h.http[method](`/api/v1/audit/logs/${ids.created}`).set(ruth).send({});
      expect(res.status, method).toBe(404);
    }
  });
});

describe('listing and filters', () => {
  const only = '?service=';

  it('lists newest first with the actor, resource and change flag', async () => {
    const res = await get('/api/v1/audit/logs?service=identity-service&limit=50');
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ id: string; occurredAt: string; hasChanges: boolean }>;
    const times = items.map((i) => i.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
    const updated = items.find((i) => i.id === ids.updated);
    expect(updated).toEqual({
      id: ids.updated,
      organizationId: ORGANIZATION.id,
      occurredAt: '2026-09-04T12:00:00.000Z',
      actor: { type: 'user', id: PEOPLE.grant.id, displayName: 'Grant Holloway' },
      action: 'user.updated',
      resourceType: 'user',
      resourceId: PEOPLE.marcus.id,
      reason: null,
      service: 'identity-service',
      ip: '198.51.100.21',
      hasChanges: true,
    });
    expect(items.find((i) => i.id === ids.percent)!.hasChanges).toBe(false);
    // Snapshots are only in the detail view.
    expect(JSON.stringify(res.body)).not.toContain('(214) 555-2201');
  });

  it('filters by date range: whole days for dates, exclusive end for timestamps', async () => {
    const inRange = async (query: string) => idsOf((await get(`/api/v1/audit/logs?service=identity-service${query}`)).body).filter((id) => Object.values(ids).includes(id));
    const days = await inRange('&from=2026-09-03&to=2026-09-04');
    expect(new Set(days)).toEqual(new Set([ids.created, ids.updated]));
    const exclusive = await inRange('&from=2026-09-03T00:00:00Z&to=2026-09-04T12:00:00Z');
    expect(exclusive).toEqual([ids.created]);
    const inclusiveStart = await inRange('&from=2026-09-04T12:00:00Z&to=2026-09-04T12:00:00.001Z');
    expect(inclusiveStart).toEqual([ids.updated]);
    const offset = await inRange('&from=2026-09-04T07:00:00-05:00&to=2026-09-04T07:00:01-05:00');
    expect(offset).toEqual([ids.updated]);

    const backwards = await get('/api/v1/audit/logs?from=2026-09-05&to=2026-09-04');
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.fields[0].path).toBe('to');
    expect((await get('/api/v1/audit/logs?from=yesterday')).status).toBe(400);
  });

  it('filters by actor', async () => {
    const byId = await get(`/api/v1/audit/logs?actorId=${PEOPLE.danielle.id}`);
    expect(idsOf(byId.body)).toEqual([ids.enroll]);
    const system = await get('/api/v1/audit/logs?actorType=system&service=certification-service');
    expect(idsOf(system.body)).toEqual([ids.issued]);
    expect(system.body.items[0].actor).toEqual({ type: 'system', id: null, displayName: 'System' });
    expect((await get('/api/v1/audit/logs?actorType=robot')).status).toBe(400);
  });

  it('filters by action prefix and treats wildcards literally', async () => {
    const user = await get('/api/v1/audit/logs?action=user.');
    expect(idsOf(user.body)).toEqual([ids.updated, ids.created]);
    const exact = await get('/api/v1/audit/logs?action=user.created');
    expect(idsOf(exact.body)).toEqual([ids.created]);
    // `_` is a LIKE wildcard; here it must only match a literal underscore.
    const underscore = await get('/api/v1/audit/logs?action=audit_logs&to=2026-09-30');
    expect(idsOf(underscore.body)).toEqual([ids.exported]);
    expect((await get('/api/v1/audit/logs?action=user%25')).status).toBe(400);
  });

  it('filters by resource and service', async () => {
    const resource = await get(`/api/v1/audit/logs?resourceType=user&resourceId=${PEOPLE.marcus.id}`);
    expect(idsOf(resource.body)).toEqual([ids.updated, ids.created]);
    expect(idsOf((await get('/api/v1/audit/logs?resourceType=certificate')).body)).toContain(ids.issued);
    const service = await get(`/api/v1/audit/logs${only}learning-service`);
    expect(idsOf(service.body)).toEqual([ids.enroll]);
    expect((await get(`/api/v1/audit/logs${only}nothing`)).body).toEqual({ items: [], nextCursor: null });
  });

  it('searches text across actor, action, resource and reason, matching wildcards literally', async () => {
    expect(idsOf((await get('/api/v1/audit/logs?q=danielle')).body)).toEqual([ids.enroll]);
    expect(idsOf((await get('/api/v1/audit/logs?q=COHORT')).body)).toEqual([ids.enroll]);
    expect(idsOf((await get('/api/v1/audit/logs?q=cert-1')).body)).toEqual([ids.issued]);
    expect(idsOf((await get('/api/v1/audit/logs?q=certificate.iss')).body)).toEqual([ids.issued]);
    expect(idsOf((await get('/api/v1/audit/logs?q=100%25')).body)).toEqual([ids.percent]);
    expect((await get('/api/v1/audit/logs?q=100_')).body.items).toEqual([]);
  });

  it('combines filters', async () => {
    const res = await get(`/api/v1/audit/logs?resourceType=user&action=user.&actorId=${PEOPLE.grant.id}&from=2026-09-04&to=2026-09-04&service=identity-service&q=updated`);
    expect(idsOf(res.body)).toEqual([ids.updated]);
  });
});

describe('keyset pagination', () => {
  it('never skips or repeats entries that share a timestamp', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: { status: number; body: { items: Array<{ id: string; resourceId: string }>; nextCursor: string | null } } = await get(
        `/api/v1/audit/logs?service=tie-service&limit=3${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((i) => i.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(4);
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it('pages through a large trail in constant-size steps, unaffected by new entries', async () => {
    const base = new Date('2026-08-01T00:00:00Z').getTime();
    const bulk = await h.insert(Array.from({ length: 1_200 }, (_, i) => ({ occurredAt: new Date(base + i * 60_000), action: 'bulk.test', resourceType: 'bulk', resourceId: `b-${i}`, service: 'bulk-service' })));
    const expected = [...bulk].reverse();

    const first = await get('/api/v1/audit/logs?service=bulk-service&limit=200');
    expect(first.body.items).toHaveLength(200);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    // Newer entries appear while the reader is paging: they must not shift later pages.
    await h.insert([{ occurredAt: new Date(base + 5_000 * 60_000), action: 'bulk.late', resourceType: 'bulk', service: 'bulk-service' }]);

    const seen = idsOf(first.body);
    let cursor: string | null = first.body.nextCursor;
    let pages = 1;
    while (cursor) {
      const res: { body: { items: Array<{ id: string }>; nextCursor: string | null } } = await get(`/api/v1/audit/logs?service=bulk-service&limit=200&cursor=${cursor}`);
      seen.push(...idsOf(res.body));
      cursor = res.body.nextCursor;
      pages++;
    }
    expect(pages).toBe(6);
    expect(seen).toEqual(expected);
    const fresh = await get('/api/v1/audit/logs?service=bulk-service&limit=1');
    expect(fresh.body.items[0].action).toBe('bulk.late');
  });

  it('rejects malformed cursors and out-of-range limits', async () => {
    for (const cursor of ['garbage', Buffer.from('2026-09-04|not-a-uuid').toString('base64url'), Buffer.from(`2026-09-04T12:00:00Z|${uuidv7()}`).toString('base64url')]) {
      const res = await get(`/api/v1/audit/logs?cursor=${cursor}`);
      expect(res.status, cursor).toBe(400);
      expect(res.body.error.fields[0].path).toBe('cursor');
    }
    expect((await get('/api/v1/audit/logs?limit=0')).status).toBe(400);
    expect((await get('/api/v1/audit/logs?limit=201')).status).toBe(400);
    expect((await get('/api/v1/audit/logs?limit=200')).status).toBe(200);
  });

  it('serves the organization/time query from the per-partition index', async () => {
    const text = await h.db.transaction().execute(async (trx) => {
      await sql`analyze audit_logs`.execute(trx);
      // Tiny test tables would otherwise be scanned sequentially.
      await sql`set local enable_seqscan = off`.execute(trx);
      const plan = await sql<{ 'QUERY PLAN': string }>`explain select id from audit_logs where organization_id = ${ORGANIZATION.id} order by occurred_at desc, id desc limit 50`.execute(trx);
      return plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(text).toMatch(/Index (Only )?Scan using audit_logs_\w+_organization_id_occurred_at_id_idx/);
    expect(text).not.toMatch(/Seq Scan/);
  });
});

describe('detail and history', () => {
  it('returns the full entry with its snapshots', async () => {
    const res = await get(`/api/v1/audit/logs/${ids.updated}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: ids.updated,
      action: 'user.updated',
      before: { phone: null },
      after: { phone: '(214) 555-2201' },
      ip: '198.51.100.21',
      userAgent: 'Mozilla/5.0',
      requestId: 'req-abcdef12',
      correlationId: 'corr-abcdef12',
      metadata: { via: 'admin console' },
      hasChanges: true,
    });
    expect(res.body.recordedAt).toEqual(expect.any(String));
    expect((await get(`/api/v1/audit/logs/${ids.issued}`)).body).toMatchObject({ before: null, after: null, metadata: {} });
  });

  it('answers 404 for unknown entries and 400 for malformed ids', async () => {
    const missing = await get(`/api/v1/audit/logs/${uuidv7()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    expect((await get('/api/v1/audit/logs/not-an-id')).status).toBe(400);
  });

  it('lists the history of a resource newest first, paged', async () => {
    const history = await get(`/api/v1/audit/resources/user/${PEOPLE.marcus.id}/history`);
    expect(history.status).toBe(200);
    expect(idsOf(history.body)).toEqual([ids.updated, ids.created]);
    const paged = await get(`/api/v1/audit/resources/user/${PEOPLE.marcus.id}/history?limit=1`);
    expect(idsOf(paged.body)).toEqual([ids.updated]);
    const next = await get(`/api/v1/audit/resources/user/${PEOPLE.marcus.id}/history?limit=1&cursor=${paged.body.nextCursor}`);
    expect(idsOf(next.body)).toEqual([ids.created]);
    expect(next.body.nextCursor).toBeNull();
    // Same id, different type: a different resource.
    expect((await get(`/api/v1/audit/resources/team/${PEOPLE.marcus.id}/history`)).body.items).toEqual([]);
    expect(idsOf((await get('/api/v1/audit/resources/enrollment/enr-1/history')).body)).toEqual([ids.enroll]);
  });
});

describe('facets', () => {
  it('counts actions, resource types and services in a range', async () => {
    const res = await get('/api/v1/audit/facets?from=2026-09-02&to=2026-09-07');
    expect(res.status).toBe(200);
    expect(res.body.from).toBe('2026-09-02T00:00:00.000Z');
    expect(res.body.to).toBe('2026-09-08T00:00:00.000Z');
    expect(res.body.actions).toEqual(
      expect.arrayContaining([
        { value: 'role.updated', count: 2 },
        { value: 'user.created', count: 1 },
        { value: 'certificate.issued', count: 1 },
      ]),
    );
    expect(res.body.actions.find((a: { value: string }) => a.value === 'user.created').count).toBe(1);
    expect(res.body.resourceTypes).toEqual(expect.arrayContaining([{ value: 'role', count: 2 }, { value: 'user', count: 2 }]));
    expect(res.body.services).toEqual(expect.arrayContaining([{ value: 'identity-service', count: 4 }, { value: 'audit-service', count: 2 }]));
    // Most frequent first.
    const counts = res.body.actions.map((a: { count: number }) => a.count);
    expect(counts).toEqual([...counts].sort((a: number, b: number) => b - a));
  });

  it('defaults to the last 90 days and bounds the range', async () => {
    const res = await get('/api/v1/audit/facets');
    expect(Date.parse(res.body.to) - Date.parse(res.body.from)).toBe(90 * 86_400_000);
    expect((await get('/api/v1/audit/facets?from=2024-01-01&to=2026-01-01')).status).toBe(400);
    expect((await get('/api/v1/audit/facets?from=2026-09-05&to=2026-09-01')).status).toBe(400);
  });
});

describe('CSV export', () => {
  const csvEntries: TestEntry[] = [
    { occurredAt: at('20'), actorDisplay: '=HYPERLINK("http://evil.example","open")', action: 'user.updated', service: 'csv-service', reason: 'Needs, a comma and "quotes"\nand a second line', before: { note: 'Café ☕' }, after: { n: 1 }, ip: '198.51.100.7', userAgent: 'Mozilla/5.0 (X11; Linux)', requestId: 'req-csv-0001', correlationId: 'corr-csv-0001' },
    { occurredAt: at('21'), actorDisplay: '+1 (214) 555-0100', action: 'user.created', service: 'csv-service' },
    { occurredAt: at('22'), actorType: 'system', actorId: null, actorDisplay: null, action: 'certificate.expired', resourceType: 'certificate', resourceId: 'c-9', service: 'csv-service' },
  ];

  it('streams the selection as a CSV file with escaped, formula-safe cells', async () => {
    const created = await h.insert(csvEntries);
    const res = await h.http.get('/api/v1/audit/export?service=csv-service').set(ruth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers['cache-control']).toBe('no-store');

    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual(['occurred_at', 'action', 'actor_type', 'actor_id', 'actor_display', 'resource_type', 'resource_id', 'reason', 'service', 'ip', 'user_agent', 'request_id', 'correlation_id', 'before', 'after', 'id']);
    expect(rows).toHaveLength(4);
    // Newest first.
    expect(rows.slice(1).map((r) => r[1])).toEqual(['certificate.expired', 'user.created', 'user.updated']);
    const [expired, plus, formula] = rows.slice(1) as [string[], string[], string[]];
    expect(formula[4]).toBe(`'=HYPERLINK("http://evil.example","open")`);
    expect(plus[4]).toBe(`'+1 (214) 555-0100`);
    expect(formula[7]).toBe('Needs, a comma and "quotes"\nand a second line');
    expect(JSON.parse(formula[13]!)).toEqual({ note: 'Café ☕' });
    expect(JSON.parse(formula[14]!)).toEqual({ n: 1 });
    expect(formula.slice(8, 13)).toEqual(['csv-service', '198.51.100.7', 'Mozilla/5.0 (X11; Linux)', 'req-csv-0001', 'corr-csv-0001']);
    expect(formula[0]).toBe('2026-09-20T12:00:00.000Z');
    expect(formula[15]).toBe(created[0]);
    expect(expired.slice(2, 7)).toEqual(['system', '', '', 'certificate', 'c-9']);
  });

  it('applies the same filters as the list', async () => {
    const res = await h.http.get('/api/v1/audit/export?service=csv-service&action=user.c').set(ruth);
    expect(parseCsv(res.text).slice(1).map((r) => r[1])).toEqual(['user.created']);
    const empty = await h.http.get('/api/v1/audit/export?service=csv-service&from=2030-01-01').set(ruth);
    expect(parseCsv(empty.text)).toHaveLength(1);
    expect((await h.http.get('/api/v1/audit/export?from=2026-09-05&to=2026-09-01').set(ruth)).status).toBe(400);
  });

  it('records every export in the trail', async () => {
    const before = (await get('/api/v1/audit/logs?action=audit_logs.exported&service=audit-service&limit=100')).body.items.length;
    await h.http.get('/api/v1/audit/export?service=csv-service&from=2026-09-01').set(ruth);
    const after = await get('/api/v1/audit/logs?action=audit_logs.exported&service=audit-service&limit=100');
    expect(after.body.items).toHaveLength(before + 1);
    const detail = await get(`/api/v1/audit/logs/${after.body.items[0].id}`);
    expect(detail.body).toMatchObject({
      actor: { type: 'user', id: PEOPLE.ruth.id, displayName: 'Ruth Abernathy' },
      resourceType: 'audit_log',
      service: 'audit-service',
      metadata: { format: 'csv', filters: { service: 'csv-service', from: '2026-09-01' }, matchedEntries: 3 },
    });
  });

  it('streams large selections in several chunks over real HTTP', async () => {
    const base = new Date('2026-08-01T00:00:00Z').getTime();
    await h.insert(Array.from({ length: 5_000 }, (_, i) => ({ occurredAt: new Date(base + i * 1_000), action: 'stream.test', resourceType: 'stream', resourceId: `s-${i}`, service: 'stream-service' })));
    const url = await h.listen();
    const res = await fetch(`${url}/api/v1/audit/export?service=stream-service`, { headers: await h.as('ruth') });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let chunks = 0;
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks++;
      text += decoder.decode(value, { stream: true });
    }
    const lines = text.trimEnd().split('\r\n');
    expect(lines).toHaveLength(5_001);
    expect(chunks).toBeGreaterThan(1);
    expect(new Set(lines.slice(1).map((l) => l.split(',').at(-1))).size).toBe(5_000);
    expect((await fetch(`${url}/health/live`)).status).toBe(200);
  });

  it('survives a client that disconnects mid-download', async () => {
    const url = await h.listen();
    const controller = new AbortController();
    const res = await fetch(`${url}/api/v1/audit/export?service=stream-service`, { headers: await h.as('ruth'), signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 200));
    expect((await fetch(`${url}/health/ready`)).status).toBe(200);
    expect((await get('/api/v1/audit/logs?limit=1')).status).toBe(200);
  });

  it('aborts the download when the database fails mid-stream, so a partial file never looks complete', async () => {
    const repo = h.app.get(LogsRepository);
    const original = repo.stream.bind(repo);
    const spy = vi.spyOn(repo, 'stream').mockImplementation(async function* (filter, max) {
      for await (const batch of original(filter, max)) {
        yield batch;
        throw new Error('connection to the database was lost');
      }
    });
    try {
      const url = await h.listen();
      const res = await fetch(`${url}/api/v1/audit/export?service=stream-service`, { headers: await h.as('ruth') });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      await expect(
        (async () => {
          for (;;) {
            const { done } = await reader.read();
            if (done) return 'completed';
          }
        })(),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect((await fetch(`${await h.listen()}/health/live`)).status).toBe(200);
  });

  it('refuses selections above the limit instead of truncating them', async () => {
    const small = await createAuditHarness('api-limit', { role: 'api', env: { AUDIT_EXPORT_MAX_ROWS: '25' } });
    try {
      await small.insert(Array.from({ length: 26 }, (_, i) => ({ occurredAt: new Date(Date.UTC(2026, 8, 1, 0, i)), service: 'limit-service' })));
      const headers = await small.as('ruth');
      const refused = await small.http.get('/api/v1/audit/export?service=limit-service').set(headers);
      expect(refused.status).toBe(422);
      expect(refused.body.error).toMatchObject({ code: 'EXPORT_TOO_LARGE', details: { maxRows: 25 } });
      expect(refused.body.error.message).toContain('Narrow the date range');
      // Nothing was exported, so nothing was recorded either.
      expect((await small.db.selectFrom('audit_logs').select('id').where('action', '=', 'audit_logs.exported').execute())).toHaveLength(0);
      const ok = await small.http.get('/api/v1/audit/export?service=limit-service&from=2026-09-01T00:01:00Z').set(headers);
      expect(ok.status).toBe(200);
      expect(parseCsv(ok.text)).toHaveLength(26);
    } finally {
      await small.close();
    }
  });
});

describe('organization isolation', () => {
  const otherOrg = () =>
    principalHeaders({ userId: uuidv7(), organizationId: OTHER_ORG, displayName: 'Other Auditor', permissions: ['audit_logs.view'], scope: 'organization' });

  it('shows each organization only its own trail', async () => {
    const who = await otherOrg();
    const list = await get('/api/v1/audit/logs?limit=100', who);
    expect(list.body.items).toHaveLength(5);
    expect(list.body.items.every((i: { organizationId: string; actor: { displayName: string } }) => i.organizationId === OTHER_ORG && i.actor.displayName === 'Other Admin')).toBe(true);
    expect((await get(`/api/v1/audit/logs/${ids.created}`, who)).status).toBe(404);
    expect((await get(`/api/v1/audit/resources/user/${PEOPLE.marcus.id}/history`, who)).body.items).toEqual([]);
    expect((await get('/api/v1/audit/facets?from=2026-09-01&to=2026-09-30', who)).body.actions).toEqual([{ value: 'user.created', count: 5 }]);
    expect(parseCsv((await h.http.get('/api/v1/audit/export').set(who)).text)).toHaveLength(6);
    // A5 never sees theirs.
    expect((await get('/api/v1/audit/logs?actorType=user&q=Other%20Admin')).body.items).toEqual([]);
  });

  it('lets only platform administrators read another organization', async () => {
    const asAdmin = await get(`/api/v1/audit/logs?organizationId=${OTHER_ORG}`, await h.as('grant'));
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body.error.message).toContain('platform administrators');
    expect((await get(`/api/v1/audit/facets?organizationId=${OTHER_ORG}`, await h.as('ruth'))).status).toBe(403);
    expect((await get(`/api/v1/audit/export?organizationId=${OTHER_ORG}`, await h.as('ruth'))).status).toBe(403);

    const platform = await get(`/api/v1/audit/logs?organizationId=${OTHER_ORG}&action=user.created&limit=100`, await h.as('priya'));
    expect(platform.status).toBe(200);
    expect(platform.body.items).toHaveLength(5);
    // Naming your own organization is always fine.
    expect((await get(`/api/v1/audit/logs?organizationId=${ORGANIZATION.id}&limit=1`, await h.as('grant'))).status).toBe(200);
  });
});
