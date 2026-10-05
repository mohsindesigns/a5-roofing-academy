import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { assessment } from '@a5/contracts';
import { renderWithProviders } from '../test-render';
import { ids, intro } from '../test-fixtures';
import { AssessmentIntroView } from './assessment-intro';

function view(
  data: assessment.AssessmentIntro,
  props: Partial<Parameters<typeof AssessmentIntroView>[0]> = {},
) {
  const handlers = { onStart: vi.fn(), onOpen: vi.fn(), onRefresh: vi.fn() };
  renderWithProviders(
    <AssessmentIntroView
      intro={data}
      crumbs={[{ label: 'Training', to: '/training' }]}
      starting={false}
      startError={null}
      backTo="/training/p/lessons/l"
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

const rules = () => within(screen.getByRole('complementary'));

describe('AssessmentIntroView', () => {
  it('presents the rules exactly as configured', () => {
    view(intro());
    expect(rules().getByText('Pass mark').nextSibling).toHaveTextContent('80%');
    expect(rules().getByText('Time limit').nextSibling).toHaveTextContent('20 minutes');
    expect(rules().getByText('Attempts').nextSibling).toHaveTextContent('0 of 3 used');
    expect(rules().getByText('Questions').nextSibling).toHaveTextContent('8');
    expect(rules().getByText('Correct answers').nextSibling).toHaveTextContent(
      'Shown after you submit',
    );
  });

  it('follows different configuration without code changes', () => {
    view(
      intro({
        assessment: {
          ...intro().assessment,
          passingPercent: 65,
          timeLimitSeconds: 5400,
          maxAttempts: null,
          revealScore: false,
          revealCorrectAnswers: 'after_pass',
        },
        attemptsRemaining: null,
      }),
    );
    expect(rules().getByText('Pass mark').nextSibling).toHaveTextContent('65%');
    expect(rules().getByText('Time limit').nextSibling).toHaveTextContent('1 hour 30 minutes');
    expect(rules().getByText('Attempts').nextSibling).toHaveTextContent('Unlimited');
    expect(rules().getByText('Your score after grading').nextSibling).toHaveTextContent(
      'Not shown',
    );
    expect(rules().getByText('Correct answers').nextSibling).toHaveTextContent(
      'Shown once you pass',
    );
    expect(screen.getByText(/You can retake this as often as you like/)).toBeInTheDocument();
  });

  it('leaves out the timer explanation for an untimed assessment', () => {
    view(intro({ assessment: { ...intro().assessment, timeLimitSeconds: null } }));
    expect(rules().getByText('Time limit').nextSibling).toHaveTextContent('No time limit');
    expect(screen.queryByText(/The timer starts when you begin/)).not.toBeInTheDocument();
  });

  it('starts an attempt and tells the learner how many attempts remain', async () => {
    const { onStart } = view(intro({ attemptsUsed: 1, attemptsRemaining: 2 }));
    expect(screen.getByText('2 attempts left.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start another attempt' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('resumes an attempt in progress instead of starting a new one', async () => {
    const { onOpen } = view(
      intro({
        inProgressAttempt: {
          id: ids.id(900),
          attemptNumber: 2,
          startedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        canStart: false,
        attemptsUsed: 2,
        attemptsRemaining: 1,
      }),
    );
    expect(screen.getByText('Attempt 2 is in progress')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume attempt 2' }));
    expect(onOpen).toHaveBeenCalledWith(ids.id(900));
  });

  it('explains a cooldown with the API message and blocks starting', () => {
    const until = new Date(Date.now() + 8 * 60_000).toISOString();
    view(
      intro({
        attemptsUsed: 1,
        attemptsRemaining: 2,
        canStart: false,
        cooldownUntil: until,
        blockedReason: {
          code: 'COOLDOWN_ACTIVE',
          message: 'You can start another attempt in 8 minutes.',
        },
      }),
    );
    expect(screen.getByText('Please wait before your next attempt')).toBeInTheDocument();
    expect(screen.getByText(/You can start another attempt in 8 minutes\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start another attempt' })).toBeDisabled();
  });

  it('explains when every attempt is used', () => {
    view(
      intro({
        attemptsUsed: 3,
        attemptsRemaining: 0,
        canStart: false,
        blockedReason: {
          code: 'ATTEMPTS_EXHAUSTED',
          message:
            'You have used all 3 attempts for this quiz. Ask your trainer if you need another attempt.',
        },
      }),
    );
    expect(screen.getByText(/You have used all 3 attempts/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start another attempt' })).toBeDisabled();
  });

  it('congratulates a learner who already passed', () => {
    view(intro({ passed: true, bestScorePercent: 90, attemptsUsed: 1, attemptsRemaining: 2 }));
    expect(screen.getByText('You have passed')).toBeInTheDocument();
    expect(screen.getByText(/best score is 90%/)).toBeInTheDocument();
  });

  it('lists past attempts and opens a result', async () => {
    const { onOpen } = view(
      intro({
        attemptsUsed: 2,
        attemptsRemaining: 1,
        attempts: [
          {
            id: ids.id(2),
            assessmentId: ids.id(800),
            title: 'Q',
            kind: 'quiz',
            attemptNumber: 2,
            status: 'graded',
            startedAt: '2026-10-05T15:00:00.000Z',
            submittedAt: '2026-10-05T15:10:00.000Z',
            gradedAt: null,
            autoSubmitted: false,
            scorePercent: 85,
            passed: true,
          },
          {
            id: ids.id(1),
            assessmentId: ids.id(800),
            title: 'Q',
            kind: 'quiz',
            attemptNumber: 1,
            status: 'graded',
            startedAt: '2026-10-04T15:00:00.000Z',
            submittedAt: '2026-10-04T15:10:00.000Z',
            gradedAt: null,
            autoSubmitted: false,
            scorePercent: 55,
            passed: false,
          },
        ],
      }),
    );
    const table = screen.getByRole('table', { name: 'Your attempts' });
    expect(within(table).getByText('Passed')).toBeInTheDocument();
    expect(within(table).getByText('Not passed')).toBeInTheDocument();
    expect(within(table).getByText('85%')).toBeInTheDocument();
    await userEvent.click(within(table).getAllByRole('button', { name: 'View result' })[0]!);
    expect(onOpen).toHaveBeenCalledWith(ids.id(2));
  });

  it('shows why starting failed', () => {
    view(intro(), {
      startError:
        'This lesson link has expired. Reopen the lesson from your training plan and try again.',
    });
    expect(screen.getByRole('alert')).toHaveTextContent('This lesson link has expired');
  });

  it('asks the server again once a cooldown has ended', () => {
    vi.useFakeTimers();
    try {
      const { onRefresh } = view(
        intro({
          canStart: false,
          cooldownUntil: new Date(Date.now() + 2_000).toISOString(),
          blockedReason: {
            code: 'COOLDOWN_ACTIVE',
            message: 'You can start another attempt in 1 minute.',
          },
        }),
      );
      expect(onRefresh).not.toHaveBeenCalled();
      vi.advanceTimersByTime(3_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
