import { createDatabase } from '@a5/database';
import type { IdentityDatabase } from '../database/schema.js';
import { seedIdentity } from './seed-identity.js';

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  process.stderr.write('Refusing to seed demo data in production\n');
  process.exit(1);
}
const database = createDatabase<IdentityDatabase>({ url, applicationName: 'identity-seed' });
try {
  await seedIdentity(database.db, { log: (line) => process.stdout.write(`${line}\n`) });
} catch (err) {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
} finally {
  await database.destroy();
}
