import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@a5/testing';
import {
  claimInbox,
  createDatabase,
  createInboxTable,
  createOutboxTable,
  createUpdatedAtFunction,
  addUpdatedAtTrigger,
  isUniqueViolation,
  migrateDown,
  migrateToLatest,
  migrationStatus,
  paginate,
  sql,
  writeOutbox,
  type Database,
  type Generated,
  type InboxSchema,
  type MigrationMap,
  type OutboxSchema,
} from './index.js';

interface Schema extends OutboxSchema, InboxSchema {
  widgets: { id: Generated<number>; name: string; updated_at: Generated<Date> };
}

const migrations: MigrationMap = {
  '0001_init': {
    async up(db) {
      await createUpdatedAtFunction(db);
      await createOutboxTable(db);
      await createInboxTable(db);
      await sql`create table widgets (id serial primary key, name text not null unique, updated_at timestamptz not null default now())`.execute(
        db,
      );
      await addUpdatedAtTrigger(db, 'widgets');
    },
    async down(db) {
      await sql`drop table widgets; drop table inbox_events; drop table outbox_events; drop function set_updated_at`.execute(
        db,
      );
    },
  },
};

let tdb: TestDatabase;
let database: Database<Schema>;

beforeAll(async () => {
  tdb = await createTestDatabase('database');
  database = createDatabase<Schema>({ url: tdb.url, poolMax: 4 });
  await migrateToLatest(database.db as never, migrations);
});

afterAll(async () => {
  await database?.destroy();
  await tdb?.drop();
});

describe('migrations', () => {
  it('reports applied migrations and is reversible', async () => {
    expect((await migrationStatus(database.db as never, migrations))[0]?.executedAt).toBeInstanceOf(
      Date,
    );
    await migrateDown(database.db as never, migrations);
    expect(
      (await migrationStatus(database.db as never, migrations))[0]?.executedAt,
    ).toBeUndefined();
    await migrateToLatest(database.db as never, migrations);
  });
});

describe('outbox and inbox', () => {
  it('writes outbox rows transactionally and rolls back with the transaction', async () => {
    await expect(
      database.db.transaction().execute(async (trx) => {
        await writeOutbox(trx, [
          {
            id: '0190a3b2-0000-7000-8000-00000000aaaa',
            type: 'x.y',
            version: 1,
            stream: 's',
            envelope: {},
            published_at: null,
            last_error: null,
          },
        ]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const count = await database.db
      .selectFrom('outbox_events')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(count.n).toBe(0);
  });

  it('claims an inbox entry exactly once per handler', async () => {
    const id = '0190a3b2-0000-7000-8000-00000000bbbb';
    const first = await database.db
      .transaction()
      .execute((trx) => claimInbox(trx, id, 'h1', 'x.y'));
    const second = await database.db
      .transaction()
      .execute((trx) => claimInbox(trx, id, 'h1', 'x.y'));
    const other = await database.db
      .transaction()
      .execute((trx) => claimInbox(trx, id, 'h2', 'x.y'));
    expect([first, second, other]).toEqual([true, false, true]);
  });
});

describe('helpers', () => {
  it('detects unique violations', async () => {
    await database.db.insertInto('widgets').values({ name: 'ridge vent' }).execute();
    try {
      await database.db.insertInto('widgets').values({ name: 'ridge vent' }).execute();
      expect.fail('should violate');
    } catch (err) {
      expect(isUniqueViolation(err)).toBe(true);
      expect(isUniqueViolation(err, 'widgets_name_key')).toBe(true);
    }
  });

  it('paginates with totals, including past the last page', async () => {
    await database.db
      .insertInto('widgets')
      .values(['a', 'b', 'c', 'd'].map((name) => ({ name })))
      .execute();
    const q = database.db.selectFrom('widgets').select(['id', 'name']).orderBy('id');
    const page = await paginate(q, { page: 2, pageSize: 2 });
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).not.toHaveProperty('__total');
    const empty = await paginate(q, { page: 10, pageSize: 2 });
    expect(empty).toMatchObject({ total: 5, items: [], pageCount: 3 });
  });

  it('maintains updated_at through the trigger', async () => {
    const before = await database.db
      .selectFrom('widgets')
      .select(['id', 'updated_at'])
      .where('name', '=', 'a')
      .executeTakeFirstOrThrow();
    await new Promise((r) => setTimeout(r, 10));
    await database.db
      .updateTable('widgets')
      .set({ name: 'a2' })
      .where('id', '=', before.id)
      .execute();
    const after = await database.db
      .selectFrom('widgets')
      .select('updated_at')
      .where('id', '=', before.id)
      .executeTakeFirstOrThrow();
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});
