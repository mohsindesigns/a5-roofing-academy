import { env, z } from '@a5/config';
import { loadServiceConfig } from '@a5/nest-kit';

const assessmentEnv = z.object({
  /** How often the worker closes attempts whose time limit has passed. */
  ATTEMPT_EXPIRY_SWEEP_SECONDS: env.int(60),
  /**
   * Network tolerance after an attempt's deadline: autosaves and submissions that arrive within it
   * are still accepted. Attempts are auto-submitted once the deadline plus this grace has passed.
   */
  ATTEMPT_DEADLINE_GRACE_SECONDS: env.int(5),
});

export function loadAssessmentConfig(source?: Record<string, string | undefined>) {
  const config = loadServiceConfig('assessment-service', 4040, assessmentEnv, { source });
  const e = config.env;
  if (e.ATTEMPT_EXPIRY_SWEEP_SECONDS < 5) {
    throw new Error('Invalid configuration:\n  - ATTEMPT_EXPIRY_SWEEP_SECONDS must be at least 5');
  }
  if (e.ATTEMPT_DEADLINE_GRACE_SECONDS < 0 || e.ATTEMPT_DEADLINE_GRACE_SECONDS > 120) {
    throw new Error(
      'Invalid configuration:\n  - ATTEMPT_DEADLINE_GRACE_SECONDS must be between 0 and 120',
    );
  }
  return {
    ...config,
    attempts: {
      expirySweepSeconds: e.ATTEMPT_EXPIRY_SWEEP_SECONDS,
      deadlineGraceMs: e.ATTEMPT_DEADLINE_GRACE_SECONDS * 1000,
    },
    /** Lesson grants are signed by learning-service with the shared internal secret (audience a5-grant). */
    grantSecret: config.internalAuthSecret,
  };
}

export type AssessmentConfig = ReturnType<typeof loadAssessmentConfig>;
export const ASSESSMENT_CONFIG = Symbol('ASSESSMENT_CONFIG');
