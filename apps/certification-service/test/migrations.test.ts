import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateDown, migrateToLatest, sql, type Database } from '@a5/database';
import { createTestDatabase, type TestDatabase } from '@a5/testing';
import { migrations } from '../src/database/migrations/index.js';

let tdb: TestDatabase;
let database: Database<unknown>;

beforeAll(async () => {
  tdb = await createTestDatabase('cert_migrations');
  database = createDatabase({ url: tdb.url, poolMax: 2 });
});
afterAll(async () => {
  await database?.destroy();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await tdb?.drop();
});

const tables = async () =>
  (await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = 'public' order by table_name`.execute(database.db)).rows.map((r) => r.table_name);

describe('migrations', () => {
  it('apply, reverse completely and apply again', async () => {
    await migrateToLatest(database.db, migrations);
    const up = await tables();
    expect(up).toEqual(
      expect.arrayContaining([
        'certificate_number_sequences',
        'certificate_snapshots',
        'certificate_template_versions',
        'certification_candidates',
        'issued_certificates',
        'learner_ai_results',
        'learner_assessment_results',
        'learner_program_status',
        'dir_users',
        'inbox_events',
        'outbox_events',
        'program_assessments',
      ]),
    );

    await migrateDown(database.db, migrations);
    expect((await tables()).filter((t) => !t.startsWith('schema_migrations'))).toEqual([]);

    await migrateToLatest(database.db, migrations);
    expect(await tables()).toEqual(up);
  });

  it('enforces the certificate invariants in the database', async () => {
    const indexes = (await sql<{ indexname: string; indexdef: string }>`select indexname, indexdef from pg_indexes where tablename = 'issued_certificates'`.execute(database.db)).rows;
    const byName = Object.fromEntries(indexes.map((i) => [i.indexname, i.indexdef]));
    expect(byName.issued_certificates_one_active_uq).toMatch(/UNIQUE.*\(definition_id, user_id\).*WHERE.*status.*issued/s);
    expect(byName.issued_certificates_number_uq).toMatch(/UNIQUE.*\(certificate_number\)/);
    expect(byName.issued_certificates_token_uq).toMatch(/UNIQUE.*\(verification_token\)/);
    expect(byName.issued_certificates_expiry_idx).toMatch(/WHERE.*status.*issued/s);
  });
});
