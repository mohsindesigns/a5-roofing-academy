import type { assessment } from '@a5/contracts';
import { round2 } from './question-types.js';

/** How the assessment is called in learner-facing messages. */
export function kindNoun(kind: assessment.AssessmentKind): string {
  switch (kind) {
    case 'quiz':
      return 'quiz';
    case 'exam':
      return 'exam';
    case 'final':
      return 'final assessment';
    case 'practice':
      return 'practice quiz';
  }
}

export function scorePercent(scorePoints: number, maxPoints: number): number {
  return maxPoints > 0 ? Math.min(100, round2((scorePoints / maxPoints) * 100)) : 0;
}

export function isPassing(percent: number, passingPercent: number): boolean {
  return percent + 1e-9 >= passingPercent;
}

/**
 * Whether a learner may see correct answers and explanations for an attempt.
 * - never: never
 * - after_submit: once the attempt is closed
 * - after_pass: once this attempt's effective result is a pass
 * - after_final_attempt: once the learner has no attempts left (unlimited attempts never qualify)
 */
export function answersRevealed(
  policy: assessment.RevealPolicy,
  state: { closed: boolean; passed: boolean | null; attemptsUsed: number; maxAttempts: number | null },
): boolean {
  if (!state.closed) return false;
  switch (policy) {
    case 'never':
      return false;
    case 'after_submit':
      return true;
    case 'after_pass':
      return state.passed === true;
    case 'after_final_attempt':
      return state.maxAttempts !== null && state.attemptsUsed >= state.maxAttempts;
  }
}

/** Minutes until an instant, rounded up, phrased for a learner ("in 1 hour 5 minutes"). */
export function waitPhrase(until: Date, now: Date): string {
  const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = `${hours} hour${hours === 1 ? '' : 's'}`;
  return rest ? `${h} ${rest} minute${rest === 1 ? '' : 's'}` : h;
}
