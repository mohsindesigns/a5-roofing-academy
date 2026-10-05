import { createDatabase } from '@a5/database';
import { DistributedLock, QueueFactory, RedisNamespace, createRedis } from '@a5/messaging';
import { EventBus } from '@a5/nest-kit';
import { createLogger } from '@a5/observability';
import { RecipientResolver } from '../common/recipients.js';
import { createObjectStorage } from '../common/storage.js';
import { loadCertificationConfig } from '../config.js';
import type { CertificationDatabase } from '../database/schema.js';
import { EligibilityService } from '../eligibility/eligibility.service.js';
import { IssuanceService } from '../issuance/issuance.service.js';
import { LifecycleService } from '../jobs/lifecycle.service.js';
import { seedCertification } from './seed-certification.js';

if (process.env.NODE_ENV === 'production') {
  process.stderr.write('Refusing to seed demo data in production\n');
  process.exit(1);
}

const config = loadCertificationConfig();
const logger = createLogger({ service: 'certification-seed', level: 'warn' });
const database = createDatabase<CertificationDatabase>({ url: config.databaseUrl!, applicationName: 'certification-seed' });
const redis = createRedis(config.redisUrl);
const queues = new QueueFactory({ redisUrl: config.redisUrl, prefix: `${config.redisNamespace}:bull`, logger });
try {
  const events = new EventBus(config);
  const storage = createObjectStorage(config.storage);
  // Historical certificates are issued silently (no events, no queue): Redis is only used for the lock.
  // Names come from the directory projection, so the identity service does not need to be running.
  const recipients = new RecipientResolver(
    { request: () => Promise.reject(new Error('identity is not used while seeding')) } as never,
    { getUser: async () => null } as never,
    logger,
  );
  const issuance = new IssuanceService(database.db, storage, new DistributedLock(redis, new RedisNamespace(config.redisNamespace)), queues, events, recipients, config, logger);
  const eligibility = new EligibilityService(database.db, events, issuance, logger);
  const lifecycle = new LifecycleService(database.db, events, eligibility);
  await seedCertification({ db: database.db, storage, config, issuance, eligibility, lifecycle }, { log: (line) => process.stdout.write(`${line}\n`) });
} catch (err) {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
} finally {
  await queues.close();
  redis.disconnect();
  await database.destroy();
}
