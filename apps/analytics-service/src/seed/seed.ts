import { createDatabase } from '@a5/database';
import type { AnalyticsDatabase } from '../database/schema.js';
import { seedAnalytics } from './seed-analytics.js';

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  process.stderr.write('Refusing to seed demo data in production\n');
  process.exit(1);
}
const database = createDatabase<AnalyticsDatabase>({ url, applicationName: 'analytics-seed' });
try {
  await seedAnalytics(database.db, {
    timezone: process.env.REPORTING_TIMEZONE ?? 'America/Chicago',
    log: (line) => process.stdout.write(`${line}\n`),
  });
} catch (err) {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
} finally {
  await database.destroy();
}
