import pg from 'pg';
import { randomBytes } from 'node:crypto';

export const TEST_ADMIN_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://a5:a5_dev_password@127.0.0.1:5432/postgres';

export interface TestDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * Create an isolated, empty database for a test file. Each test file gets its own database so
 * suites can run in parallel without sharing state.
 */
export async function createTestDatabase(prefix: string): Promise<TestDatabase> {
  const safe = prefix.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
  const name = `t_${safe}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  return {
    name,
    url: withDatabase(TEST_ADMIN_DATABASE_URL, name),
    async drop() {
      const client = new pg.Client({ connectionString: TEST_ADMIN_DATABASE_URL });
      await client.connect();
      try {
        await client.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await client.end();
      }
    },
  };
}
