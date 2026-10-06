import { env, z } from '@a5/config';
import { loadServiceConfig } from '@a5/nest-kit';

const learningEnv = z.object({
  /** Lifetime of signed lesson grants handed to media, assessment and AI services. */
  LESSON_GRANT_TTL_SECONDS: env.int(4 * 3600),
  /** TTL of cached published program trees (the key is also versioned on every change). */
  PROGRAM_TREE_CACHE_SECONDS: env.int(600),
  /** Cron pattern of the daily overdue sweep (BullMQ job scheduler). */
  OVERDUE_SWEEP_CRON: z.string().trim().min(9).default('5 6 * * *'),
  OVERDUE_SWEEP_TZ: z.string().trim().default('America/Chicago'),
});

export function loadLearningConfig(source?: Record<string, string | undefined>) {
  const config = loadServiceConfig('learning-service', 4020, learningEnv, { source });
  const e = config.env;
  if (e.LESSON_GRANT_TTL_SECONDS < 60 || e.LESSON_GRANT_TTL_SECONDS > 24 * 3600) {
    throw new Error(
      'Invalid configuration:\n  - LESSON_GRANT_TTL_SECONDS must be between 60 and 86400.',
    );
  }
  return {
    ...config,
    learning: {
      grantTtlSeconds: e.LESSON_GRANT_TTL_SECONDS,
      treeCacheSeconds: e.PROGRAM_TREE_CACHE_SECONDS,
      overdueCron: e.OVERDUE_SWEEP_CRON,
      overdueTimezone: e.OVERDUE_SWEEP_TZ,
    },
  };
}

export type LearningConfig = ReturnType<typeof loadLearningConfig>;
export const LEARNING_CONFIG = Symbol('LEARNING_CONFIG');
