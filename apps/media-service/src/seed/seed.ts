import { createDatabase } from '@a5/database';
import { loadStorageConfigForTools } from '../config.js';
import type { MediaDatabase } from '../database/schema.js';
import { createObjectStorage } from '../storage/storage.factory.js';
import { seedMedia } from './seed-media.js';

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  process.stderr.write('Refusing to seed demo data in production\n');
  process.exit(1);
}

const storageConfig = loadStorageConfigForTools();
const storage = createObjectStorage(storageConfig);
const database = createDatabase<MediaDatabase>({
  url,
  applicationName: 'media-seed',
  statementTimeoutMs: 120_000,
});
try {
  process.stdout.write(
    `media: storage driver ${storageConfig.driver}${storageConfig.driver === 'local' ? ` (${storageConfig.root})` : ` (bucket ${storageConfig.bucket})`}\n`,
  );
  await seedMedia(database.db, storage, {
    log: (line) => process.stdout.write(`${line}\n`),
    ffmpegPath: process.env.FFMPEG_PATH,
    ffprobePath: process.env.FFPROBE_PATH,
    workDir: process.env.MEDIA_WORK_DIR,
  });
} catch (err) {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
} finally {
  await database.destroy();
}
