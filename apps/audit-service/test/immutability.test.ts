import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@a5/database';
import { ensurePartitions } from '../src/partitions/partitions.js';
import { createAuditHarness, type AuditHarness } from './harness.js';

let h: AuditHarness;
let monthId: string;
let defaultId: string;

beforeAll(async () => {
  h = await createAuditHarness('immutability', { role: 'api' });
  await ensurePartitions(h.db as never, [new Date('2026-04-01T00:00:00Z')]);
  [monthId, defaultId] = await h.insert([
    { occurredAt: new Date('2026-04-15T15:00:00Z'), action: 'user.created', reason: 'original reason', after: { name: 'Marcus Delgado' } },
    { occurredAt: new Date('2012-04-15T15:00:00Z'), action: 'user.created', reason: 'original reason' },
  ]) as [string, string];
});
afterAll(() => h?.close());

async function rejected(statement: ReturnType<typeof sql>): Promise<{ code: string; message: string }> {
  try {
    await statement.execute(h.db);
  } catch (err) {
    const e = err as { code?: string; message: string };
    return { code: e.code ?? '', message: e.message };
  }
  throw new Error('The statement was not rejected');
}

describe('audit_logs is append-only', () => {
  it.each([
    ['UPDATE through the parent table', () => sql`update audit_logs set reason = 'edited' where id = ${monthId}`, 'UPDATE'],
    ['UPDATE of every row', () => sql`update audit_logs set action = 'tampered'`, 'UPDATE'],
    ['UPDATE directly on a month partition', () => sql`update audit_logs_y2026m04 set reason = 'edited'`, 'UPDATE'],
    ['UPDATE directly on the default partition', () => sql`update audit_logs_default set reason = 'edited'`, 'UPDATE'],
    ['moving a row to another month by changing occurred_at', () => sql`update audit_logs set occurred_at = '2026-05-01T00:00:00Z' where id = ${monthId}`, 'UPDATE'],
    ['DELETE through the parent table', () => sql`delete from audit_logs where id = ${monthId}`, 'DELETE'],
    ['DELETE of every row', () => sql`delete from audit_logs`, 'DELETE'],
    ['DELETE directly on a month partition', () => sql`delete from audit_logs_y2026m04`, 'DELETE'],
    ['DELETE directly on the default partition', () => sql`delete from audit_logs_default where id = ${defaultId}`, 'DELETE'],
    ['upsert that would update an existing row', () => sql`insert into audit_logs (id, occurred_at, actor_type, action, resource_type, service) select id, occurred_at, actor_type, action, resource_type, service from audit_logs where id = ${monthId} on conflict (id, occurred_at) do update set action = 'tampered'`, 'UPDATE'],
  ])('rejects %s', async (_name, statement, operation) => {
    const error = await rejected(statement());
    expect(error.code).toBe('55000');
    expect(error.message).toBe(`audit_logs is append-only: ${operation} is not allowed`);
  });

  it.each([
    ['the parent table', 'truncate audit_logs'],
    ['a month partition', 'truncate audit_logs_y2026m04'],
    ['the default partition', 'truncate audit_logs_default'],
    ['with cascade', 'truncate audit_logs cascade'],
  ])('rejects TRUNCATE of %s', async (_name, text) => {
    const error = await rejected(sql.raw(text));
    expect(error.code).toBe('55000');
    expect(error.message).toBe('audit_logs is append-only: TRUNCATE is not allowed');
  });

  it('leaves the stored entries untouched after every attempt', async () => {
    const rows = await h.db.selectFrom('audit_logs').select(['id', 'action', 'reason', 'after']).where('id', 'in', [monthId, defaultId]).orderBy('occurred_at').execute();
    expect(rows).toEqual([
      { id: defaultId, action: 'user.created', reason: 'original reason', after: null },
      { id: monthId, action: 'user.created', reason: 'original reason', after: { name: 'Marcus Delgado' } },
    ]);
  });

  it('still accepts new entries and ignores duplicate ids', async () => {
    const [id] = await h.insert([{ action: 'user.updated', occurredAt: new Date('2026-04-20T10:00:00Z') }]);
    const duplicate = await sql`
      insert into audit_logs (id, occurred_at, actor_type, action, resource_type, service)
      select id, occurred_at, actor_type, 'duplicate', resource_type, service from audit_logs where id = ${id!}
      on conflict (id, occurred_at) do nothing
    `.execute(h.db);
    expect(duplicate.numAffectedRows).toBe(0n);
    expect((await h.db.selectFrom('audit_logs').select('action').where('id', '=', id!).executeTakeFirstOrThrow()).action).toBe('user.updated');
  });

});
