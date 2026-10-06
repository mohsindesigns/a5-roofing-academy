import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { renderWithProviders } from '../test-render';
import { attemptResult, ids, learnerAttempt, learnerQuestions } from '../test-fixtures';
import { AttemptPlayer } from './attempt-player';

vi.mock('@/lib/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const attempt = learnerAttempt();
const saved = (answeredCount = 1, timeRemainingSeconds: number | null = 1190) => ({
  attemptQuestionId: ids.id(1),
  answered: true,
  savedAt: '2026-10-05T15:01:00.000Z',
  applied: true,
  answeredCount,
  timeRemainingSeconds,
});

function renderPlayer(over: Parameters<typeof learnerAttempt>[0] = {}) {
  return renderWithProviders(
    <AttemptPlayer
      attempt={learnerAttempt(over)}
      crumbs={[{ label: 'Training', to: '/training' }]}
    />,
  );
}

beforeEach(() => {
  vi.mocked(api.put).mockReset().mockResolvedValue(saved());
  vi.mocked(api.post).mockReset().mockResolvedValue(attemptResult());
});
afterEach(() => vi.useRealTimers());

describe('AttemptPlayer', () => {
  it('shows one question at a time with a progress indicator and a countdown', () => {
    renderPlayer();
    expect(screen.getByRole('heading', { name: 'Question 1 of 8' })).toBeInTheDocument();
    expect(screen.getByText(/photo report is shared/)).toBeInTheDocument();
    expect(screen.queryByText(/signs of hail damage/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: '0 of 8 questions answered' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent('20:00');
    expect(screen.getByText('Pass mark 80%')).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'Questions' })).getAllByRole('button'),
    ).toHaveLength(8);
  });

  it('says so when there is no time limit', () => {
    renderPlayer({ timeLimitSeconds: null, timeRemainingSeconds: null, expiresAt: null });
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(screen.getByText('No time limit')).toBeInTheDocument();
  });

  it('autosaves a chosen answer and updates progress', async () => {
    renderPlayer();
    await userEvent.click(screen.getByRole('radio', { name: 'The homeowner' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [path, body] = vi.mocked(api.put).mock.calls[0]!;
    expect(path).toBe(`/attempts/${attempt.id}/answers/${ids.id(1)}`);
    expect(body).toEqual({
      response: { type: 'multiple_choice', optionId: 'a' },
      clientSequence: expect.any(Number),
    });
    expect(
      screen.getByRole('progressbar', { name: '1 of 8 questions answered' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Question 1, answered' })).toBeInTheDocument();
  });

  it('moves between questions and puts focus on the new question', async () => {
    renderPlayer();
    await userEvent.click(screen.getByRole('button', { name: /Next/ }));
    const heading = screen.getByRole('heading', { name: 'Question 2 of 8' });
    expect(heading).toHaveFocus();
    expect(screen.getByRole('group', { name: /signs of hail damage/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Previous/ }));
    expect(screen.getByRole('heading', { name: 'Question 1 of 8' })).toHaveFocus();
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled();
  });

  it('jumps to a question from the navigator', async () => {
    renderPlayer();
    await userEvent.click(screen.getByRole('button', { name: 'Question 7, not answered' }));
    expect(screen.getByRole('heading', { name: 'Question 7 of 8' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Question 7, not answered' })).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('resumes at the first unanswered question with the saved answers in place', () => {
    const questions = learnerQuestions().map((q, i) =>
      i === 0 ? { ...q, response: { type: 'multiple_choice' as const, optionId: 'b' } } : q,
    );
    renderPlayer({ questions, answeredCount: 1, resumed: true });
    expect(screen.getByRole('heading', { name: 'Question 2 of 8' })).toBeInTheDocument();
    expect(screen.getByText('Resumed where you left off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Question 1, answered' })).toBeInTheDocument();
  });

  it('keeps the answer and says it is retrying when the network drops', async () => {
    vi.mocked(api.put).mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'offline'));
    renderPlayer();
    await userEvent.click(screen.getByRole('radio', { name: 'The sales manager' }));
    await waitFor(() => expect(screen.getByText(/Not saved yet/)).toBeInTheDocument());
    expect(screen.getByRole('radio', { name: 'The sales manager' })).toBeChecked();
  });

  it('does not send text the server would refuse, and blocks submitting it', async () => {
    renderPlayer();
    await userEvent.click(screen.getByRole('button', { name: 'Question 5, not answered' }));
    const words = Array.from({ length: 13 }, () => 'word').join(' ');
    await userEvent.click(screen.getByRole('textbox'));
    await userEvent.paste(words);
    expect(screen.getByRole('alert')).toHaveTextContent('Keep your answer to 12 words or fewer.');
    await act(() => new Promise((r) => setTimeout(r, 1000)));
    expect(api.put).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Fix these before you submit')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Submit answers' })).toBeDisabled();
  });

  describe('submitting', () => {
    it('asks for confirmation, lists what is unanswered, and submits after saving', async () => {
      renderPlayer();
      await userEvent.click(screen.getByRole('radio', { name: 'The homeowner' }));
      await userEvent.click(screen.getByRole('button', { name: 'Question 8, not answered' }));
      await userEvent.click(screen.getByRole('button', { name: /Review and submit/ }));
      const dialog = screen.getByRole('dialog', { name: 'Submit your answers?' });
      expect(dialog).toHaveTextContent(
        'You have answered 1 of 8 questions. You cannot change your answers after you submit.',
      );
      expect(within(dialog).getAllByRole('button', { name: /^Question \d$/ })).toHaveLength(7);
      expect(api.post).not.toHaveBeenCalled();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Submit answers' }));
      await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/attempts/${attempt.id}/submit`));
      // The pending answer reached the server before the attempt was submitted.
      expect(vi.mocked(api.put).mock.invocationCallOrder[0]!).toBeLessThan(
        vi.mocked(api.post).mock.invocationCallOrder[0]!,
      );
    });

    it('lets the learner go back to an unanswered question from the dialog', async () => {
      renderPlayer();
      await userEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
      await userEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Question 4' }),
      );
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Question 4 of 8' })).toBeInTheDocument();
    });

    it('keeps the dialog open and explains when answers could not be saved', async () => {
      vi.mocked(api.put).mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'offline'));
      renderPlayer();
      await userEvent.click(screen.getByRole('radio', { name: 'The homeowner' }));
      await userEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
      await userEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Submit answers' }),
      );
      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent('Some answers could not be saved'),
      );
      expect(api.post).not.toHaveBeenCalled();
    });

    it('shows the server message when submitting fails', async () => {
      vi.mocked(api.post).mockRejectedValue(
        new ApiError(
          500,
          'INTERNAL',
          'The server could not complete the request. Try again in a moment.',
        ),
      );
      renderPlayer();
      await userEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
      await userEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Submit answers' }),
      );
      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent('Try again in a moment'),
      );
    });
  });

  describe('time limit', () => {
    it('submits automatically when the server time runs out', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderPlayer({ timeRemainingSeconds: 3, timeLimitSeconds: 60 });
      expect(screen.getByRole('timer')).toHaveTextContent('0:03');
      await act(() => vi.advanceTimersByTimeAsync(3_500));
      await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/attempts/${attempt.id}/submit`));
      expect(screen.getByRole('dialog', { name: 'Time is up' })).toBeInTheDocument();
    });

    it('follows the server clock when a save reports a different remaining time', async () => {
      vi.mocked(api.put).mockResolvedValue(saved(1, 100));
      renderPlayer();
      expect(screen.getByRole('timer')).toHaveTextContent('20:00');
      await userEvent.click(screen.getByRole('radio', { name: 'The homeowner' }));
      await waitFor(() => expect(screen.getByRole('timer')).toHaveTextContent('1:4'));
    });

    it('locks the answers once time is up', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderPlayer({ timeRemainingSeconds: 1, timeLimitSeconds: 60 });
      await act(() => vi.advanceTimersByTimeAsync(1_500));
      for (const r of screen.getAllByRole('radio', { hidden: true })) expect(r).toBeDisabled();
    });
  });
});
