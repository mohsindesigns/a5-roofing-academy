import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Principal } from '@a5/auth';
import {
  createDatabase,
  createInboxTable,
  migrateToLatest,
  sql,
  type Database,
  type InboxSchema,
} from '@a5/database';
import type { DirectoryUserRecord } from '@a5/events';
import { createTestDatabase, type TestDatabase } from '@a5/testing';
import {
  DirectoryReader,
  applyDirectoryTeam,
  applyDirectoryUser,
  createDirectoryTables,
  userScopeCondition,
  type DirectorySchema,
} from './index.js';

interface Schema extends DirectorySchema, InboxSchema {
  enrollments: { id: string; user_id: string; organization_id: string };
}

const ORG = '0190a3b2-0000-7000-8000-000000000e01';
const OTHER_ORG = '0190a3b2-0000-7000-8000-000000000e02';
const TEAM_A = '0190a3b2-0000-7000-8000-000000000e10';
const TEAM_B = '0190a3b2-0000-7000-8000-000000000e11';
const MANAGER = '0190a3b2-0000-7000-8000-000000000e20';
const REP_A = '0190a3b2-0000-7000-8000-000000000e21';
const REP_B = '0190a3b2-0000-7000-8000-000000000e22';
const TRAINEE = '0190a3b2-0000-7000-8000-000000000e23';
const OUTSIDER = '0190a3b2-0000-7000-8000-000000000e24';

function user(id: string, overrides: Partial<DirectoryUserRecord> = {}): DirectoryUserRecord {
  return {
    id,
    organizationId: ORG,
    firstName: 'Test',
    lastName: id.slice(-4),
    displayName: `Test ${id.slice(-4)}`,
    email: `${id.slice(-4)}@a5roofing.example`,
    employeeId: null,
    jobTitle: 'Sales Representative',
    status: 'active',
    locationId: null,
    departmentId: null,
    teamIds: [],
    managerIds: [],
    trainerIds: [],
    roleKeys: ['sales_rep'],
    hiredAt: null,
    ...overrides,
  };
}

let tdb: TestDatabase;
let database: Database<Schema>;

beforeAll(async () => {
  tdb = await createTestDatabase('directory');
  database = createDatabase<Schema>({ url: tdb.url });
  await migrateToLatest(database.db as never, {
    '0001': {
      up: async (db) => {
        await createInboxTable(db);
        await createDirectoryTables(db);
        await sql`create table enrollments (id text primary key, user_id uuid not null, organization_id uuid not null)`.execute(
          db,
        );
      },
    },
  });
  await database.db.transaction().execute(async (trx) => {
    await applyDirectoryUser(trx, user(MANAGER, { roleKeys: ['manager'] }), 1);
    await applyDirectoryUser(trx, user(REP_A, { teamIds: [TEAM_A] }), 1);
    await applyDirectoryUser(trx, user(REP_B, { teamIds: [TEAM_B] }), 1);
    await applyDirectoryUser(trx, user(TRAINEE, { trainerIds: [MANAGER] }), 1);
    await applyDirectoryUser(trx, user(OUTSIDER, { organizationId: OTHER_ORG }), 1);
    await applyDirectoryTeam(
      trx,
      {
        id: TEAM_A,
        organizationId: ORG,
        name: 'Dallas Storm A',
        locationId: null,
        departmentId: null,
        managerIds: [MANAGER],
        memberIds: [REP_A],
        archived: false,
      },
      1,
    );
  });
  await database.db
    .insertInto('enrollments')
    .values(
      [REP_A, REP_B, TRAINEE, MANAGER, OUTSIDER].map((u, i) => ({
        id: `e${i}`,
        user_id: u,
        organization_id: u === OUTSIDER ? OTHER_ORG : ORG,
      })),
    )
    .execute();
});

afterAll(async () => {
  await database.destroy();
  await tdb.drop();
});

describe('projection', () => {
  it('ignores stale revisions', async () => {
    const applied = await database.db
      .transaction()
      .execute((trx) =>
        applyDirectoryUser(trx, user(REP_A, { displayName: 'Stale Name', teamIds: [] }), 0),
      );
    expect(applied).toBe(false);
    const reader = new DirectoryReader(database.db);
    expect((await reader.getUser(REP_A))?.teamIds).toEqual([TEAM_A]);
  });

  it('applies newer revisions and replaces team membership', async () => {
    await database.db
      .transaction()
      .execute((trx) =>
        applyDirectoryUser(
          trx,
          user(REP_A, { displayName: 'Marcus Delgado', teamIds: [TEAM_A] }),
          2,
        ),
      );
    const reader = new DirectoryReader(database.db);
    expect((await reader.getUser(REP_A))?.displayName).toBe('Marcus Delgado');
    expect(await reader.managersOf(REP_A)).toEqual([MANAGER]);
    expect(await reader.trainersOf(TRAINEE)).toEqual([MANAGER]);
  });
});

describe('userScopeCondition', () => {
  const manager = new Principal({
    userId: MANAGER,
    organizationId: ORG,
    sessionId: null,
    displayName: 'Manager',
    roles: ['manager'],
    permissions: {
      'enrollments.view': 'managed',
      'training.participate': 'own',
      'reports.view': 'organization',
    },
    managedTeamIds: [TEAM_A],
    managedUserIds: [TRAINEE],
  });

  async function visible(
    permission: 'enrollments.view' | 'training.participate' | 'reports.view' | 'users.view',
  ) {
    const rows = await database.db
      .selectFrom('enrollments as e')
      .select('e.user_id')
      .where(
        userScopeCondition(manager.scopeFilter(permission), {
          userColumn: 'e.user_id',
          orgColumn: 'e.organization_id',
        }),
      )
      .execute();
    return rows.map((r) => r.user_id).sort();
  }

  it('managed scope sees self, managed teams and direct trainees only', async () => {
    expect(await visible('enrollments.view')).toEqual([MANAGER, REP_A, TRAINEE].sort());
  });

  it('own scope sees only self', async () => {
    expect(await visible('training.participate')).toEqual([MANAGER]);
  });

  it('organization scope never crosses organizations', async () => {
    expect(await visible('reports.view')).not.toContain(OUTSIDER);
    expect(await visible('reports.view')).toHaveLength(4);
  });

  it('no permission sees nothing', async () => {
    expect(await visible('users.view')).toEqual([]);
  });
});
