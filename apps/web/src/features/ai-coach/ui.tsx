import type { ai } from '@a5/contracts';
import { StatusText, type Tone } from '@/components/ui';
import { cn } from '@/lib/cn';

const LEVELS: ai.ScenarioDifficulty[] = ['beginner', 'intermediate', 'advanced', 'expert'];

export const DIFFICULTY_LABEL: Record<ai.ScenarioDifficulty, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
  expert: 'Expert',
};

/** Four pips plus the word, so difficulty never relies on the pips alone. */
export function Difficulty({
  level,
  className,
}: {
  level: ai.ScenarioDifficulty;
  className?: string;
}) {
  const rank = LEVELS.indexOf(level);
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm text-text-secondary', className)}>
      <span aria-hidden className="flex items-end gap-px">
        {LEVELS.map((l, i) => (
          <span
            key={l}
            className={cn(
              'w-1 rounded-[1px]',
              i === 0 ? 'h-2' : i === 1 ? 'h-2.5' : i === 2 ? 'h-3' : 'h-3.5',
              i <= rank ? 'bg-text-secondary' : 'bg-border-strong',
            )}
          />
        ))}
      </span>
      {DIFFICULTY_LABEL[level]}
    </span>
  );
}

export function sessionStatusTone(
  status: ai.SessionStatus,
  passed: boolean | null,
): { label: string; tone: Tone } {
  switch (status) {
    case 'active':
      return { label: 'In progress', tone: 'information' };
    case 'ended':
    case 'evaluating':
      return { label: 'Scoring', tone: 'information' };
    case 'evaluated':
      return passed === false
        ? { label: 'Below pass mark', tone: 'warning' }
        : { label: 'Passed', tone: 'success' };
    case 'evaluation_failed':
      return { label: 'Scoring failed', tone: 'danger' };
    case 'abandoned':
      return { label: 'Not scored', tone: 'neutral' };
  }
}

export function SessionStatus({
  status,
  passed,
}: {
  status: ai.SessionStatus;
  passed: boolean | null;
}) {
  const { label, tone } = sessionStatusTone(status, passed);
  return <StatusText tone={tone}>{label}</StatusText>;
}

export const END_REASON_TEXT: Record<ai.EndReason, string> = {
  rep_ended: 'You ended the conversation.',
  objective_reached: 'The homeowner agreed to a next step, so the conversation ended.',
  homeowner_ended: 'The homeowner ended the conversation.',
  max_turns: 'The conversation reached its turn limit.',
  timeout: 'The conversation ended after a period of inactivity.',
};

/**
 * Score against a pass mark: the bar fills to the score and a tick marks the pass mark.
 * Colour reinforces, but the numbers carry the meaning.
 */
export function ScoreMeter({
  score,
  passMark,
  label,
  size = 'md',
}: {
  score: number;
  passMark?: number;
  label: string;
  size?: 'md' | 'lg';
}) {
  // Without a pass mark (a single criterion) the bar is neutral: only the overall score passes or fails.
  const tone =
    passMark === undefined ? 'bg-brand-secondary' : score >= passMark ? 'bg-success' : 'bg-warning';
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={score}
      aria-valuetext={
        passMark === undefined
          ? `${score} out of 100`
          : `${score} out of 100, pass mark ${passMark}`
      }
      className={cn(
        'relative w-full rounded-full bg-surface-sunken',
        size === 'lg' ? 'h-2.5' : 'h-1.5',
      )}
    >
      <div
        className={cn('h-full rounded-full', tone)}
        style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
      />
      {passMark !== undefined && (
        <span
          aria-hidden
          className={cn(
            'absolute top-1/2 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text-primary',
            size === 'lg' ? 'h-5' : 'h-3.5',
          )}
          style={{ left: `${passMark}%` }}
        />
      )}
    </div>
  );
}
