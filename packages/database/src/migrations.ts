import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationResultSet } from 'kysely/migration';

export type MigrationMap = Record<string, Migration>;

/**
 * Migrations are registered through a static import map instead of a folder scan so that they
 * survive bundling and are type checked with the service.
 */
export function createMigrator(db: Kysely<unknown>, migrations: MigrationMap): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
    migrationTableName: 'schema_migrations',
    migrationLockTableName: 'schema_migrations_lock',
  });
}

function assertOk(result: MigrationResultSet): string[] {
  if (result.error) {
    const failed = result.results?.find((r) => r.status === 'Error');
    const name = failed ? ` (${failed.migrationName})` : '';
    throw new Error(
      `Migration failed${name}: ${String((result.error as Error).message ?? result.error)}`,
    );
  }
  return (result.results ?? []).map((r) => `${r.direction} ${r.migrationName}`);
}

export async function migrateToLatest(
  db: Kysely<unknown>,
  migrations: MigrationMap,
): Promise<string[]> {
  return assertOk(await createMigrator(db, migrations).migrateToLatest());
}

export async function migrateDown(
  db: Kysely<unknown>,
  migrations: MigrationMap,
): Promise<string[]> {
  return assertOk(await createMigrator(db, migrations).migrateDown());
}

export async function migrationStatus(
  db: Kysely<unknown>,
  migrations: MigrationMap,
): Promise<Array<{ name: string; executedAt: Date | undefined }>> {
  const list = await createMigrator(db, migrations).getMigrations();
  return list.map((m) => ({ name: m.name, executedAt: m.executedAt }));
}

/** Small CLI used by every service: `migrate [latest|down|status|reset]`. */
export async function runMigrationCli(
  db: Kysely<unknown>,
  migrations: MigrationMap,
  command: string = 'latest',
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<void> {
  switch (command) {
    case 'latest':
      for (const line of await migrateToLatest(db, migrations)) log(line);
      log('migrations up to date');
      return;
    case 'down':
      for (const line of await migrateDown(db, migrations)) log(line);
      return;
    case 'status':
      for (const m of await migrationStatus(db, migrations)) {
        log(`${m.executedAt ? 'applied ' : 'pending '} ${m.name}`);
      }
      return;
    case 'reset': {
      if (process.env.NODE_ENV === 'production') throw new Error('reset is disabled in production');
      const migrator = createMigrator(db, migrations);
      for (;;) {
        const result = await migrator.migrateDown();
        assertOk(result);
        if (!result.results?.length) break;
        for (const r of result.results) log(`down ${r.migrationName}`);
      }
      for (const line of await migrateToLatest(db, migrations)) log(line);
      return;
    }
    default:
      throw new Error(`Unknown migration command "${command}"`);
  }
}

/** Shared trigger that keeps `updated_at` current. Created by the first migration of a service. */
export async function createUpdatedAtFunction(db: Kysely<unknown>): Promise<void> {
  await sql`
    create or replace function set_updated_at() returns trigger as $$
    begin
      new.updated_at = now();
      return new;
    end;
    $$ language plpgsql
  `.execute(db);
}

export async function addUpdatedAtTrigger(db: Kysely<unknown>, table: string): Promise<void> {
  await sql`
    create trigger ${sql.raw(`${table}_set_updated_at`)}
    before update on ${sql.table(table)}
    for each row execute function set_updated_at()
  `.execute(db);
}
