import type { assessment } from '@a5/contracts';
import type { Tone } from '@/components/ui';

export const KIND_LABELS: Record<assessment.AssessmentKind, string> = {
  quiz: 'Quiz',
  exam: 'Exam',
  final: 'Final assessment',
  practice: 'Practice quiz',
};

export const ASSESSMENT_STATUS: Record<assessment.AssessmentStatus, { label: string; tone: Tone }> =
  {
    draft: { label: 'Draft', tone: 'neutral' },
    published: { label: 'Published', tone: 'success' },
    archived: { label: 'Archived', tone: 'warning' },
  };

export const DIFFICULTY_LABELS: Record<assessment.Difficulty, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

export const ATTEMPT_STATUS: Record<assessment.AttemptStatus, { label: string; tone: Tone }> = {
  in_progress: { label: 'In progress', tone: 'information' },
  submitted: { label: 'Submitted', tone: 'information' },
  pending_review: { label: 'Awaiting review', tone: 'warning' },
  graded: { label: 'Graded', tone: 'neutral' },
  expired: { label: 'Timed out', tone: 'warning' },
};

export const OUTCOME: Record<assessment.QuestionOutcome, { label: string; tone: Tone }> = {
  correct: { label: 'Correct', tone: 'success' },
  partial: { label: 'Partly correct', tone: 'warning' },
  incorrect: { label: 'Incorrect', tone: 'danger' },
  unanswered: { label: 'Not answered', tone: 'neutral' },
  pending_review: { label: 'Awaiting review', tone: 'information' },
};

export const REVEAL_LABELS: Record<assessment.RevealPolicy, string> = {
  never: 'Never',
  after_submit: 'After they submit',
  after_pass: 'After they pass',
  after_final_attempt: 'After their last attempt',
};

export const REVEAL_HINTS: Record<assessment.RevealPolicy, string> = {
  never: 'Learners see how they scored but never the correct answers.',
  after_submit: 'Correct answers and explanations appear as soon as an attempt is submitted.',
  after_pass: 'Correct answers appear only on an attempt that passes.',
  after_final_attempt:
    'Correct answers appear once the learner has no attempts left. Not available with unlimited attempts.',
};

/** "20 minutes", "1 hour 30 minutes". Whole minutes are rounded up; sub-minute values read in seconds. */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${Math.max(0, Math.ceil(totalSeconds))} seconds`;
  const minutes = Math.ceil(totalSeconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = `${hours} hour${hours === 1 ? '' : 's'}`;
  return rest ? `${h} ${rest} minute${rest === 1 ? '' : 's'}` : h;
}

/** Clock face for countdowns: 9:05, 1:02:09. */
export function formatClockTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/** "0 attempts" style helper used on intro and result screens. */
export function attemptsPhrase(remaining: number | null): string {
  if (remaining === null) return 'Unlimited attempts';
  if (remaining === 0) return 'No attempts left';
  return `${remaining} attempt${remaining === 1 ? '' : 's'} left`;
}

export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

export function formatPoints(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
