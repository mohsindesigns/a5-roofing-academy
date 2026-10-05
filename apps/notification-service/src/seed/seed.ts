import { createDatabase } from '@a5/database';
import type { NotificationDatabase } from '../database/schema.js';
import { seedNotification } from './seed-notification.js';

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  process.stderr.write('Refusing to seed demo data in production\n');
  process.exit(1);
}
const database = createDatabase<NotificationDatabase>({ url, applicationName: 'notification-seed' });
try {
  await seedNotification(database.db, {
    appUrl: process.env.PUBLIC_APP_URL,
    timezone: process.env.NOTIFICATION_TIMEZONE,
    log: (line) => process.stdout.write(`${line}\n`),
  });
} catch (err) {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
} finally {
  await database.destroy();
}
