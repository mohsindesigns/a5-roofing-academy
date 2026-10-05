import { createDatabase, runMigrationCli } from '@a5/database';
import { migrations } from './migrations/index.js';

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(1);
}
const database = createDatabase({ url, applicationName: 'ai-coaching-migrate' });
try {
  await runMigrationCli(database.db as never, migrations, process.argv[2] ?? 'latest');
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await database.destroy();
}
