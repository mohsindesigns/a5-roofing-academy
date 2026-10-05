import type { Selectable } from '@a5/database';
import type { AttemptRow, DbOrTrx, ScoreOverridesTable } from '../database/index.js';

export type ScoreOverrideRow = Selectable<ScoreOverridesTable>;

export interface EffectiveScore {
  scorePercent: number | null;
  passed: boolean | null;
  overridden: boolean;
}

/** Latest override per attempt. Overrides never modify the graded attempt; the newest one wins. */
export async function latestOverrides(db: DbOrTrx, attemptIds: readonly string[]): Promise<Map<string, ScoreOverrideRow>> {
  if (attemptIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('score_overrides')
    .selectAll()
    .distinctOn('attempt_id')
    .where('attempt_id', 'in', [...new Set(attemptIds)])
    .orderBy('attempt_id')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return new Map(rows.map((r) => [r.attempt_id, r]));
}

export function effectiveScore(attempt: Pick<AttemptRow, 'status' | 'score_percent' | 'passed'>, override: ScoreOverrideRow | undefined): EffectiveScore {
  if (attempt.status !== 'graded') return { scorePercent: null, passed: null, overridden: false };
  if (override) return { scorePercent: override.new_score_percent, passed: override.new_passed, overridden: true };
  return { scorePercent: attempt.score_percent, passed: attempt.passed, overridden: false };
}
