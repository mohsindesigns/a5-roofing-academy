import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateToLatest, sql } from '@a5/database';
import { QueueFactory } from '@a5/messaging';
import { migrations } from '../src/database/migrations/index.js';
import { PartitionMaintenance, PARTITION_QUEUE } from '../src/partitions/partition-maintenance.js';
import { addMonths, ensurePartitions, listPartitions, monthStart, monthsBetween, partitionName } from '../src/partitions/partitions.js';
import { createAuditHarness, type AuditHarness } from './harness.js';

let h: AuditHarness;

beforeAll(async () => {
  h = await createAuditHarness('partitions');
});
afterAll(() => h?.close());

const names = async () => (await listPartitions(h.db as never)).map((p) => p.name);

async function partitionOf(id: string): Promise<string> {
  const r = await sql<{ part: string }>`select tableoid::regclass::text as part from audit_logs where id = ${id}`.execute(h.db);
  return r.rows[0]!.part;
}

describe('month arithmetic', () => {
  it('names and walks months in UTC', () => {
    expect(partitionName(new Date('2026-12-31T23:59:59Z'))).toBe('audit_logs_y2026m12');
    expect(partitionName(new Date('2027-01-01T00:00:00Z'))).toBe('audit_logs_y2027m01');
    expect(addMonths(new Date('2026-11-15T00:00:00Z'), 3).toISOString()).toBe('2027-02-01T00:00:00.000Z');
    expect(monthsBetween(new Date('2026-11-15T00:00:00Z'), new Date('2027-02-01T00:00:00Z')).map(partitionName)).toEqual([
      'audit_logs_y2026m11',
      'audit_logs_y2026m12',
      'audit_logs_y2027m01',
      'audit_logs_y2027m02',
    ]);
  });
});

describe('monthly partitions', () => {
  it('the migration creates the default, current and next three months', async () => {
    const now = new Date();
    const expected = ['audit_logs_default', ...[0, 1, 2, 3].map((i) => partitionName(addMonths(monthStart(now), i)))].sort();
    expect(await names()).toEqual(expected);
    const first = (await listPartitions(h.db as never)).find((p) => p.name === partitionName(now))!;
    expect(first.from).toMatch(/^\d{4}-\d{2}-01 00:00:00\+00$/);
  });

  it('creates missing future partitions idempotently', async () => {
    const maintenance = h.app.get(PartitionMaintenance);
    const now = new Date('2031-03-15T12:00:00Z');
    expect(await maintenance.ensure(now)).toEqual(['audit_logs_y2031m03', 'audit_logs_y2031m04', 'audit_logs_y2031m05', 'audit_logs_y2031m06']);
    expect(await maintenance.ensure(now)).toEqual([]);
    // The next month rolls the window forward by one partition.
    expect(await maintenance.ensure(new Date('2031-04-02T00:00:00Z'))).toEqual(['audit_logs_y2031m07']);
  });

  it('schedules the recurring partition job', async () => {
    const scheduler = await h.app.get(QueueFactory).queue(PARTITION_QUEUE).getJobScheduler('audit-partitions');
    expect(scheduler).toMatchObject({ key: 'audit-partitions', every: h.config.partitions.intervalMs });
  });

  it('routes rows to the partition of their month (UTC boundaries) and the default otherwise', async () => {
    await ensurePartitions(h.db as never, [new Date('2028-05-01T00:00:00Z'), new Date('2028-06-01T00:00:00Z')]);
    const [lastMay, firstJune, lateJune, farFuture, farPast] = await h.insert([
      { occurredAt: new Date('2028-05-31T23:59:59.999Z') },
      { occurredAt: new Date('2028-06-01T00:00:00.000Z') },
      { occurredAt: new Date('2028-06-30T23:59:59.999Z') },
      { occurredAt: new Date('2041-01-01T00:00:00Z') },
      { occurredAt: new Date('2001-09-09T00:00:00Z') },
    ]);
    expect(await partitionOf(lastMay!)).toBe('audit_logs_y2028m05');
    expect(await partitionOf(firstJune!)).toBe('audit_logs_y2028m06');
    expect(await partitionOf(lateJune!)).toBe('audit_logs_y2028m06');
    expect(await partitionOf(farFuture!)).toBe('audit_logs_default');
    expect(await partitionOf(farPast!)).toBe('audit_logs_default');
  });

  it('moves rows collected in the default partition when their month gets a partition', async () => {
    const ids = await h.insert(Array.from({ length: 40 }, (_, i) => ({ occurredAt: new Date(Date.UTC(2029, 4, 1 + (i % 28), 10, i)), action: `move.test.${i}` })));
    const neighbour = (await h.insert([{ occurredAt: new Date('2029-07-04T10:00:00Z'), action: 'move.neighbour' }]))[0]!;
    expect(await partitionOf(ids[0]!)).toBe('audit_logs_default');

    const before = await sql<{ id: string; action: string; recorded_at: Date }>`select id, action, recorded_at from audit_logs where action like 'move.%' order by id`.execute(h.db);
    expect(await ensurePartitions(h.db as never, [new Date('2029-05-10T00:00:00Z')])).toEqual(['audit_logs_y2029m05']);
    const after = await sql<{ id: string; action: string; recorded_at: Date }>`select id, action, recorded_at from audit_logs where action like 'move.%' order by id`.execute(h.db);

    expect(after.rows).toEqual(before.rows);
    for (const id of ids) expect(await partitionOf(id)).toBe('audit_logs_y2029m05');
    // Rows of other months stay where they were, and the swap left a single, empty-of-May default.
    expect(await partitionOf(neighbour)).toBe('audit_logs_default');
    expect(await names()).not.toContain('audit_logs_default_moving');
    const mayInDefault = await sql<{ n: number }>`select count(*)::int as n from audit_logs_default where occurred_at >= '2029-05-01' and occurred_at < '2029-06-01'`.execute(h.db);
    expect(mayInDefault.rows[0]!.n).toBe(0);
  });

  it('keeps inserting while a partition is being created', async () => {
    const early = await h.insert([{ occurredAt: new Date('2030-02-10T09:00:00Z'), action: 'race.early' }]);
    const writers = Array.from({ length: 60 }, (_, i) => h.insert([{ occurredAt: new Date(Date.UTC(2030, 1, 11 + (i % 10), 9, i)), action: `race.${i}` }]));
    const [created] = await Promise.all([ensurePartitions(h.db as never, [new Date('2030-02-01T00:00:00Z')]), ...writers]);
    expect(created).toEqual(['audit_logs_y2030m02']);
    const total = await sql<{ n: number; distinct: number }>`select count(*)::int as n, count(distinct id)::int as distinct from audit_logs where action like 'race.%'`.execute(h.db);
    expect(total.rows[0]).toEqual({ n: 61, distinct: 61 });
    expect(await partitionOf(early[0]!)).toBe('audit_logs_y2030m02');
    const strays = await sql<{ n: number }>`select count(*)::int as n from audit_logs_default where action like 'race.%'`.execute(h.db);
    expect(strays.rows[0]!.n).toBe(0);
  });

  it('protects every partition, including ones created later', async () => {
    const triggers = await sql<{ rel: string; trigger: string }>`
      select tgrelid::regclass::text as rel, tgname as trigger from pg_trigger
      where not tgisinternal and tgrelid in (select inhrelid from pg_inherits where inhparent = 'audit_logs'::regclass union select 'audit_logs'::regclass)
    `.execute(h.db);
    const byRelation = new Map<string, string[]>();
    for (const t of triggers.rows) byRelation.set(t.rel, [...(byRelation.get(t.rel) ?? []), t.trigger].sort());
    const partitions = await names();
    expect([...byRelation.keys()].sort()).toEqual(['audit_logs', ...partitions].sort());
    for (const [rel, list] of byRelation) expect(list, rel).toEqual(['audit_logs_immutable', 'audit_logs_no_truncate']);
  });
});

describe('migration', () => {
  it('reverses completely and applies again', async () => {
    await migrateDown(h.db as never, migrations);
    const left = await sql<{ n: number }>`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name not like 'schema_migrations%'`.execute(h.db);
    expect(left.rows[0]!.n).toBe(0);
    const functions = await sql<{ n: number }>`select count(*)::int as n from pg_proc where proname like 'audit_logs_%'`.execute(h.db);
    expect(functions.rows[0]!.n).toBe(0);
    await migrateToLatest(h.db as never, migrations);
    expect(await names()).toContain('audit_logs_default');
    expect((await h.insert([{ action: 'after.reapply' }])).length).toBe(1);
  });
});
