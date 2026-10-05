import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { assessment } from '@a5/contracts';
import { renderWithProviders } from '../test-render';
import { attemptResult, ids, learnerAttempt } from '../test-fixtures';
import { AttemptResultView } from './attempt-result';

const attempt = learnerAttempt({ status: 'graded' });
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

function view(
  over: Partial<assessment.AttemptResult> = {},
  props: Partial<Parameters<typeof AttemptResultView>[0]> = {},
) {
  const onRetake = vi.fn();
  renderWithProviders(
    <AttemptResultView
      attempt={attempt}
      result={attemptResult(over)}
      crumbs={[{ label: 'Training', to: '/training' }]}
      backTo="/training/p/lessons/l"
      introTo="/training/p/lessons/l/assessment"
      nextLessonTo="/training/p/lessons/next"
      retaking={false}
      retakeError={null}
      onRetake={onRetake}
      {...props}
    />,
  );
  return { onRetake };
}

describe('AttemptResultView', () => {
  it('shows the score against the configured pass mark and the verdict', () => {
    view({ scorePercent: 62.5, passingPercent: 80 });
    expect(screen.getByText('Not passed')).toBeInTheDocument();
    expect(screen.getByText('62.5%')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Score 62.5%, pass mark 80%' })).toBeInTheDocument();
    expect(screen.getByText('5 of 8 points')).toBeInTheDocument();
    expect(screen.getByText(/You did not reach the passing score of 80%/)).toBeInTheDocument();
  });

  it('uses the pass mark the API returns, not a fixed one', () => {
    view({
      scorePercent: 70,
      passed: true,
      passingPercent: 65,
      retakeAvailableAt: null,
      message: 'You passed this quiz with 70%.',
    });
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Score 70%, pass mark 65%' })).toBeInTheDocument();
  });

  describe('retake', () => {
    it('offers a retake with the attempts that remain', async () => {
      const { onRetake } = view({ retakeAvailableAt: inMinutes(-1), attemptsRemaining: 2 });
      const retry = screen.getByRole('button', { name: 'Try again' });
      expect(retry).toBeEnabled();
      expect(screen.getByText(/2 attempts left/)).toBeInTheDocument();
      await userEvent.click(retry);
      expect(onRetake).toHaveBeenCalledTimes(1);
    });

    it('says when the cooldown ends and keeps the button disabled until then', () => {
      view({ retakeAvailableAt: inMinutes(10), attemptsRemaining: 1 });
      expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
      expect(screen.getByText(/1 attempt left/)).toBeInTheDocument();
      expect(screen.getByText(/available at/)).toBeInTheDocument();
    });

    it('mentions unlimited attempts', () => {
      view({ retakeAvailableAt: inMinutes(-1), attemptsRemaining: null });
      expect(screen.getByText(/Unlimited attempts/)).toBeInTheDocument();
    });

    it('offers no retake when no attempts are left', () => {
      view({
        retakeAvailableAt: null,
        attemptsRemaining: 0,
        message: 'You have no attempts left; your trainer will follow up with you.',
      });
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      expect(screen.getByText(/no attempts left/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'All attempts' })).toHaveAttribute(
        'href',
        '/training/p/lessons/l/assessment',
      );
    });

    it('shows a retake error from the server', () => {
      view(
        { retakeAvailableAt: inMinutes(-1) },
        { retakeError: 'You can start another attempt in 3 minutes.' },
      );
      expect(screen.getByRole('alert')).toHaveTextContent(
        'You can start another attempt in 3 minutes.',
      );
    });
  });

  it('points a learner who passed to the next lesson', () => {
    view({ passed: true, retakeAvailableAt: null, message: 'You passed this quiz with 90%.' });
    expect(screen.getByRole('link', { name: /Continue to next lesson/ })).toHaveAttribute(
      'href',
      '/training/p/lessons/next',
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('does not invent a score when the assessment hides it', () => {
    view({
      scoreVisible: false,
      scorePercent: null,
      scorePoints: null,
      maxPoints: null,
      questions: [{ ...attemptResult().questions[0]!, outcome: null, awardedPoints: null }],
    });
    expect(screen.queryByText(/^\d+(\.\d+)?%$/)).not.toBeInTheDocument();
    expect(screen.getByText('Pass mark 80%')).toBeInTheDocument();
    expect(screen.getByText('Your answers were submitted')).toBeInTheDocument();
  });

  it('waits for a trainer when open answers need review', () => {
    view({
      status: 'pending_review',
      passed: null,
      scoreVisible: false,
      scorePercent: null,
      retakeAvailableAt: null,
      message: 'A trainer will review your written answers.',
    });
    expect(screen.getByText('Awaiting review')).toBeInTheDocument();
    expect(screen.queryByText('Not passed')).not.toBeInTheDocument();
  });

  it('flags a score a trainer adjusted', () => {
    view({ overridden: true });
    expect(screen.getByText('Score adjusted by a trainer')).toBeInTheDocument();
  });

  describe('per-question feedback', () => {
    it('shows outcomes but not the answer key when answers are not revealed', () => {
      view({ answersRevealed: false });
      const list = screen.getByRole('list', { name: 'Question results' });
      expect(within(list).getByText('Incorrect')).toBeInTheDocument();
      expect(within(list).getByText('The sales manager')).toBeInTheDocument();
      expect(screen.queryByText('Correct answer')).not.toBeInTheDocument();
      expect(
        screen.getByText('Correct answers are not shown for this assessment.'),
      ).toBeInTheDocument();
    });

    it('shows the correct answer and explanation when the API reveals them', () => {
      view({
        answersRevealed: true,
        questions: [
          {
            ...attemptResult().questions[0]!,
            correctAnswer: { type: 'multiple_choice', optionId: 'a' },
            explanation: 'A5 never shares photos without the homeowner saying yes.',
          },
        ],
      });
      expect(screen.getByText('Correct answer')).toBeInTheDocument();
      expect(screen.getByText('The homeowner')).toBeInTheDocument();
      expect(screen.getByText(/never shares photos/)).toBeInTheDocument();
      expect(
        screen.queryByText('Correct answers are not shown for this assessment.'),
      ).not.toBeInTheDocument();
    });

    it('renders ordering and matching answers as readable text', () => {
      const q = (
        n: number,
        type: 'ordering' | 'matching',
        response: assessment.AnswerResponse,
        correct: assessment.CorrectAnswer,
      ) => ({
        attemptQuestionId: ids.id(n),
        position: n,
        type,
        prompt: type,
        points: 1,
        response,
        outcome: 'partial' as const,
        awardedPoints: 0.5,
        feedback: null,
        correctAnswer: correct,
        explanation: null,
      });
      view({
        answersRevealed: true,
        questions: [
          q(
            7,
            'ordering',
            { type: 'ordering', order: ['i3', 'i1', 'i2'] },
            { type: 'ordering', order: ['i1', 'i2', 'i3'] },
          ),
          q(
            8,
            'matching',
            { type: 'matching', matches: { p1: 'c2' } },
            { type: 'matching', matches: { p1: 'c1', p2: 'c2' } },
          ),
        ],
      });
      const items = screen.getAllByRole('listitem').map((li) => li.textContent);
      expect(items).toContain('Install');
      expect(
        items.some((t) => t?.includes('Underlayment') && t.includes('Secondary water barrier')),
      ).toBe(true);
      expect(
        within(screen.getByRole('list', { name: 'Question results' })).getAllByText(
          'Partly correct',
        ),
      ).toHaveLength(2);
    });

    it('shows reviewer feedback on open answers', () => {
      view({
        questions: [
          {
            ...attemptResult().questions[0]!,
            outcome: 'pending_review',
            awardedPoints: null,
            feedback: 'Good opening. Add a question about the roof age.',
          },
        ],
      });
      expect(screen.getByText('Feedback from your trainer')).toBeInTheDocument();
      expect(screen.getByText(/Add a question about the roof age/)).toBeInTheDocument();
    });
  });
});
