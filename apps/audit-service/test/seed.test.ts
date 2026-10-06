import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateToLatest, sql } from '@a5/database';
import { CERTIFICATION, PEOPLE, PROGRAM } from '@a5/seed-data';
import { migrations } from '../src/database/migrations/index.js';
import { listPartitions } from '../src/partitions/partitions.js';
import { auditHistory, seedAudit } from '../src/seed/seed-audit.js';
import { createAuditHarness, type AuditHarness } from './harness.js';

let h: AuditHarness;
let ruth: Record<string, string>;

beforeAll(async () => {
  h = await createAuditHarness('seed', { role: 'api', seed: true });
  ruth = await h.as('ruth');
});
afterAll(() => h?.close());

async function everything() {
  const items: Array<{
    id: string;
    action: string;
    actor: { id: string | null; type: string; displayName: string };
    resourceType: string;
    resourceId: string | null;
    reason: string | null;
    occurredAt: string;
    service: string;
  }> = [];
  let cursor: string | null = null;
  do {
    const res: { body: { items: typeof items; nextCursor: string | null } } = await h.http
      .get(`/api/v1/audit/logs?limit=200${cursor ? `&cursor=${cursor}` : ''}`)
      .set(ruth);
    items.push(...res.body.items);
    cursor = res.body.nextCursor;
  } while (cursor);
  return items;
}

describe('audit seed', () => {
  it('stores the whole history, spread over two years of partitions', async () => {
    const items = await everything();
    expect(items).toHaveLength(auditHistory().length);
    expect(items.length).toBeGreaterThan(100);
    const days = items.map((i) => i.occurredAt.slice(0, 10)).sort();
    expect(days[0]).toBe('2024-09-23');
    expect(days.at(-1)! < '2026-10-05').toBe(true);

    const partitions = await listPartitions(h.db as never);
    const dated = partitions.filter((p) => p.name !== 'audit_logs_default');
    expect(dated.length).toBeGreaterThanOrEqual(25);
    expect(partitions.find((p) => p.name === 'audit_logs_default')!.rows).toBe(0);
    expect(dated.reduce((n, p) => n + p.rows, 0)).toBe(items.length);
    expect(dated.some((p) => p.name === 'audit_logs_y2027m01')).toBe(true);
  });

  it('attributes administrative actions to the seeded people', async () => {
    const items = await everything();
    const known = new Set(Object.values(PEOPLE).map((p) => p.id));
    for (const i of items) {
      if (i.actor.type === 'user')
        expect(known.has(i.actor.id!), `${i.action} by ${i.actor.displayName}`).toBe(true);
      else expect(i.actor).toEqual({ type: 'system', id: null, displayName: 'System' });
    }
    const created = items.filter((i) => i.action === 'user.created');
    expect(created).toHaveLength(16);
    expect(new Set(created.map((i) => i.actor.displayName))).toEqual(new Set(['Grant Holloway']));
    const marcus = created.find((i) => i.resourceId === PEOPLE.marcus.id)!;
    expect(marcus.occurredAt.slice(0, 10)).toBe('2026-08-28');
    expect(
      items.filter((i) => i.action === 'program.published').map((i) => i.actor.displayName),
    ).toEqual(Array(5).fill('Shelby Hartman'));
  });

  it('covers user creation, role changes, program publishing and certificate issuance', async () => {
    const facets = await h.http.get('/api/v1/audit/facets?from=2025-10-06&to=2026-10-04').set(ruth);
    const actions = new Map<string, number>(
      facets.body.actions.map((a: { value: string; count: number }) => [a.value, a.count]),
    );
    expect(actions.get('user.created')).toBeGreaterThanOrEqual(10);
    expect(actions.get('program.published')).toBe(2);

    const all = await everything();
    expect(all.filter((i) => i.action === 'user.roles_changed').map((i) => i.resourceId)).toEqual(
      expect.arrayContaining([PEOPLE.shelby.id, PEOPLE.ruth.id]),
    );
    expect(all.filter((i) => i.action.startsWith('role.')).length).toBeGreaterThanOrEqual(2);
    expect(all.filter((i) => i.action === 'certificate.issued')).toHaveLength(3);
    expect(
      all.some((i) => i.service === 'audit-service' && i.actor.displayName === 'Ruth Abernathy'),
    ).toBe(true);
  });

  it('keeps the history of a resource together with before/after details', async () => {
    const history = await h.http
      .get(`/api/v1/audit/resources/program/${PROGRAM.id}/history?limit=50`)
      .set(ruth);
    expect(history.body.items.map((i: { action: string }) => i.action)).toEqual([
      'program.published',
      'program.published',
      'program.published',
      'program.published',
      'program.published',
      'program.created',
    ]);
    const latest = await h.http.get(`/api/v1/audit/logs/${history.body.items[0].id}`).set(ruth);
    expect(latest.body).toMatchObject({
      reason: 'Ahead of the July cohort',
      before: { version: 4 },
      after: { version: 5 },
      metadata: { changedLessons: ['w3-practice-estimates', 'w4-practice-cheaper'] },
      actor: { displayName: 'Shelby Hartman', type: 'user' },
    });
    expect(latest.body.ip).toMatch(/^(198\.51\.100|203\.0\.113)\./);
    expect(latest.body.requestId).toMatch(/^req_[0-9a-f]{20}$/);

    const reissued = await h.http
      .get(`/api/v1/audit/logs?action=certificate.reissued&resourceType=certificate`)
      .set(ruth);
    expect(reissued.body.items).toHaveLength(1);
    expect(reissued.body.items[0]).toMatchObject({
      reason: 'Corrected legal name spelling',
      service: 'certification-service',
    });
    const detail = (await h.http.get(`/api/v1/audit/logs/${reissued.body.items[0].id}`).set(ruth))
      .body;
    expect(detail.after.certificateNumber).toMatch(
      new RegExp(`^A5-${CERTIFICATION.code}-2025-\\d{6}$`),
    );
  });

  it('is idempotent and keeps ids and timestamps stable', async () => {
    const before = await sql<{
      n: number;
      checksum: string;
    }>`select count(*)::int as n, md5(string_agg(id::text || occurred_at::text, ',' order by id)) as checksum from audit_logs`.execute(
      h.db,
    );
    expect(await seedAudit(h.db)).toEqual({ entries: 0, partitions: [] });
    const after = await sql<{
      n: number;
      checksum: string;
    }>`select count(*)::int as n, md5(string_agg(id::text || occurred_at::text, ',' order by id)) as checksum from audit_logs`.execute(
      h.db,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('seeds a fresh database after the migration is reversed and applied again', async () => {
    await migrateDown(h.db as never, migrations);
    await migrateToLatest(h.db as never, migrations);
    const result = await seedAudit(h.db);
    expect(result.entries).toBe(auditHistory().length);
    expect(result.partitions.length).toBeGreaterThanOrEqual(22);
  });
});
