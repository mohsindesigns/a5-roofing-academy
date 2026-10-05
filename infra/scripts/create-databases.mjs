#!/usr/bin/env node
// Creates one database per service on the configured PostgreSQL server (idempotent).
import pg from 'pg';

const admin =
  process.env.POSTGRES_ADMIN_URL ?? 'postgres://a5:a5_dev_password@127.0.0.1:5432/postgres';
const databases = [
  'a5_identity',
  'a5_learning',
  'a5_media',
  'a5_assessment',
  'a5_ai',
  'a5_certification',
  'a5_notification',
  'a5_analytics',
  'a5_audit',
];
const client = new pg.Client({ connectionString: admin });
await client.connect();
try {
  const existing = new Set(
    (await client.query('select datname from pg_database')).rows.map((r) => r.datname),
  );
  for (const db of databases) {
    if (existing.has(db)) {
      console.log(`exists   ${db}`);
    } else {
      await client.query(`create database "${db}"`);
      console.log(`created  ${db}`);
    }
  }
} finally {
  await client.end();
}
