import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateDown, migrateToLatest, sql, type Database } from '@a5/database';
import { CERTIFICATION, ORGANIZATION, PEOPLE } from '@a5/seed-data';
import { createTestDatabase, type TestDatabase } from '@a5/testing';
import { NOTIFICATION_TYPE_DEFS } from '../src/catalog/notification-types.js';
import { migrations } from '../src/database/migrations/index.js';
import type { NotificationDatabase } from '../src/database/schema.js';
import { seedNotification } from '../src/seed/seed-notification.js';

let tdb: TestDatabase;
let database: Database<NotificationDatabase>;

beforeAll(async () => {
  tdb = await createTestDatabase('notification_seed');
  database = createDatabase<NotificationDatabase>({ url: tdb.url, poolMax: 2 });
  await migrateToLatest(database.db as never, migrations);
});
afterAll(async () => {
  await database?.destroy();
  await tdb?.drop();
});

const inbox = (person: keyof typeof PEOPLE) =>
  database.db.selectFrom('notifications').selectAll().where('user_id', '=', PEOPLE[person].id).orderBy('available_at', 'desc').execute();

describe('notification seed', () => {
  it('seeds the directory, defaults and a realistic inbox history', async () => {
    const result = await seedNotification(database.db, { appUrl: 'https://academy.a5roofing.example' });
    expect(result.notifications).toBeGreaterThan(100);
    expect(result.emails).toBeGreaterThan(5);

    const counts = await sql<{ users: number; teams: number; templates: number; rules: number; learners: number }>`
      select (select count(*) from dir_users)::int as users, (select count(*) from dir_teams)::int as teams,
             (select count(*) from notification_templates)::int as templates, (select count(*) from notification_rules)::int as rules,
             (select count(*) from program_learners)::int as learners
    `.execute(database.db);
    expect(counts.rows[0]).toEqual({
      users: Object.keys(PEOPLE).length,
      teams: 4,
      templates: NOTIFICATION_TYPE_DEFS.reduce((n, d) => n + d.channels.length, 0),
      rules: NOTIFICATION_TYPE_DEFS.length,
      learners: 16,
    });

    // Brianna (Dallas Residential B) is waiting for Andre Coleman's sign-off, not Danielle Okafor's.
    const [andre] = await inbox('andre');
    expect(andre).toMatchObject({ type: 'approval.requested', title: 'Approval needed: Brianna Castillo', read_at: null, priority: 'high' });
    expect((await inbox('danielle')).some((n) => n.type === 'approval.requested')).toBe(false);

    // Tyler's first Week 1 attempt (70%) failed; his manager heard about it.
    const tyler = await inbox('tyler');
    expect(tyler.filter((n) => n.type === 'assessment.failed').map((n) => n.title)).toEqual(['Week 1 Knowledge Check: 70%, not passed yet']);
    expect(tyler.filter((n) => n.type === 'assessment.passed').map((n) => n.title)).toEqual(['You passed Week 1 Knowledge Check']);
    expect((await inbox('danielle')).map((n) => n.title)).toContain('Tyler Brennan did not pass Week 1 Knowledge Check');

    // Certificates earned, and Sofia's is about to expire.
    expect((await inbox('ashlyn')).find((n) => n.type === 'certificate.issued')!.title).toBe(`Certificate earned: ${CERTIFICATION.name}`);
    const [sofia] = await inbox('sofia');
    expect(sofia).toMatchObject({ type: 'certificate.expiring', read_at: null, title: `${CERTIFICATION.name} expires in 49 days` });
    expect((await inbox('meilin')).some((n) => n.title === `Destiny Morales earned ${CERTIFICATION.name}`)).toBe(true);

    // Recent items are unread, older ones read.
    const devon = await inbox('devon');
    expect(devon.map((n) => n.type)).toEqual(['training.assigned', 'account.welcome']);
    const unread = await database.db.selectFrom('notifications').select((eb) => eb.fn.countAll<number>().as('n')).where('read_at', 'is', null).executeTakeFirstOrThrow();
    expect(Number(unread.n)).toBeGreaterThan(3);

    const emails = await database.db.selectFrom('email_deliveries').selectAll().where('organization_id', '=', ORGANIZATION.id).execute();
    expect(emails.every((e) => e.status === 'sent' && e.body_html?.includes('A5 Roofing Sales Academy'))).toBe(true);
    expect(emails.map((e) => e.to_address)).toContain('andre.coleman@a5roofing.example');
  });

  it('is idempotent', async () => {
    const before = await database.db.selectFrom('notifications').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    expect(await seedNotification(database.db)).toEqual({ notifications: 0, emails: 0 });
    const after = await database.db.selectFrom('notifications').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
  });

  it('migrates down completely and up again', async () => {
    await migrateDown(database.db as never, migrations);
    const tables = await sql<{ n: number }>`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name not like 'schema_migrations%'`.execute(database.db);
    expect(tables.rows[0]!.n).toBe(0);
    await migrateToLatest(database.db as never, migrations);
    expect(await seedNotification(database.db, { demo: false })).toEqual({ notifications: 0, emails: 0 });
  });
});
