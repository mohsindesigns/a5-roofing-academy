import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { json, meHandler, mockApi, renderRoute } from '@/test/render';
import { ScorecardPage, scorecardPollInterval } from './scorecard-page';
import { message, scorecard, session } from './test-fixtures';

afterEach(() => vi.restoreAllMocks());

const opening = message(1, 'homeowner', "I don't have time right now.");
const rep = message(2, 'rep', 'What have you noticed on the roof?');
const reply = message(3, 'homeowner', 'A stain over the garage.');
const transcript = [opening, rep, reply];

function evaluated(overrides: Parameters<typeof session>[0] = {}) {
  return session({
    status: 'evaluated',
    endReason: 'rep_ended',
    endedAt: '2026-10-05T16:04:00.000Z',
    messages: transcript,
    turnCount: 1,
    evaluation: scorecard(),
    ...overrides,
  });
}

function setup(initial: ReturnType<typeof session>, extra: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    'GET /auth/me': meHandler(['ai_practice.use']),
    [`GET /ai/sessions/${initial.id}`]: () => initial,
    [`GET /ai/practice/scenarios/${initial.scenario.id}`]: () => ({
      id: initial.scenario.id,
      title: initial.scenario.title,
      category: 'Brush-off',
      difficulty: 'beginner',
      objection: 'x',
      persona: { name: 'Busy homeowner', description: 'Always mid-task.' },
      passingScore: 75,
      maxTurns: 10,
      myStats: { attempts: 1, bestScore: 65, passed: false, lastPracticedAt: null },
      repBrief: 'brief',
      scoredOn: [],
    }),
    ...extra,
  });
  renderRoute(<ScorecardPage />, {
    route: `/ai-coach/sessions/${initial.id}/scorecard`,
    path: '/ai-coach/sessions/:id/scorecard',
  });
  return { api, initial };
}

describe('scorecard', () => {
  it('shows the overall score against the pass mark', async () => {
    setup(evaluated());
    const result = await screen.findByRole('region', { name: 'Overall score' });
    expect(within(result).getByText('65')).toBeInTheDocument();
    expect(within(result).getByText('Below the pass mark')).toBeInTheDocument();
    expect(
      within(result).getByText(/Pass mark 75\. You are 10 points short\./),
    ).toBeInTheDocument();
    expect(within(result).getByText(/never asked for a next step/)).toBeInTheDocument();
    expect(within(result).getByText(/Propose one specific next step/)).toBeInTheDocument();
    expect(within(result).getByRole('meter', { name: 'Overall score' })).toHaveAttribute(
      'aria-valuetext',
      '65 out of 100, pass mark 75',
    );
    expect(screen.getByText('Your scorecard is ready.')).toBeInTheDocument();
  });

  it('celebrates a pass without exaggerating it', async () => {
    setup(
      evaluated({
        evaluation: scorecard({ overallScore: 82, passed: true }),
      }),
    );
    const result = await screen.findByRole('region', { name: 'Overall score' });
    expect(within(result).getByText('Passed')).toBeInTheDocument();
    expect(within(result).getByText(/7 above it/)).toBeInTheDocument();
  });

  it('lists each criterion with its weight, score and the evidence behind it', async () => {
    const user = userEvent.setup();
    setup(evaluated());
    await screen.findByText('How you scored');
    const rows = screen.getAllByRole('listitem').filter((li) => li.querySelector('details'));
    expect(rows).toHaveLength(2);
    // Weights are relative: 30 of 40 and 10 of 40.
    expect(within(rows[0]!).getByText('75% of score')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('25% of score')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('meter', { name: 'Discovery score' })).toHaveAttribute(
      'aria-valuenow',
      '66',
    );

    await user.click(within(rows[0]!).getByText('Discovery'));
    expect(within(rows[0]!).getByText('Asked one open question before pitching.')).toBeVisible();
    const quote = within(rows[0]!).getByText(/What have you noticed on the roof\?/);
    expect(quote).toBeInTheDocument();
    // Evidence says which of the learner's turns it is and links to the transcript.
    expect(within(rows[0]!).getByText(/Your turn 1/)).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('link', { name: 'See in transcript' })).toHaveAttribute(
      'href',
      '#message-2',
    );
    expect(within(rows[1]!).getByText(/No specific line was cited/)).toBeInTheDocument();
  });

  it('shows strengths, improvements, questions and the transcript', async () => {
    setup(evaluated());
    await screen.findByText('What went well');
    expect(screen.getByText('Built on the homeowner’s own words')).toBeInTheDocument();
    expect(screen.getByText('What to work on')).toBeInTheDocument();
    expect(screen.getByText('Did not isolate the objection')).toBeInTheDocument();
    expect(screen.getByText(/Ask whether anything else is holding them back/)).toBeInTheDocument();
    expect(screen.getByText('Who else weighs in on the decision?')).toBeInTheDocument();
    const transcriptList = screen.getByRole('list', { name: 'Transcript' });
    expect(within(transcriptList).getByText('A stain over the garage.')).toBeInTheDocument();
    expect(within(transcriptList).getByText('You, turn 1')).toBeInTheDocument();
    // Sections with nothing to say are left out rather than shown empty.
    expect(screen.queryByText('Statements to avoid')).not.toBeInTheDocument();
  });

  it('says plainly when the scorecard came from the development simulator', async () => {
    setup(evaluated());
    await screen.findByText('Scored by the development simulator');
  });

  it('starts a fresh conversation on the same scenario with Try again', async () => {
    const user = userEvent.setup();
    const s = evaluated();
    const next = session({ scenario: s.scenario });
    const { api } = setup(s, { 'POST /ai/sessions': () => next });
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    await screen.findByText(`Elsewhere: /ai-coach/sessions/${next.id}`);
    expect(api.callsTo('POST /ai/sessions')[0]!.body).toEqual({
      scenarioId: s.scenario.id,
      modality: 'text',
    });
  });

  it('sends a lesson attempt back to its lesson and keeps practice-only retries separate', async () => {
    const programId = '00000000-0000-4000-8000-0000000000c1';
    const lessonId = '00000000-0000-4000-8000-0000000000c2';
    setup(evaluated({ mode: 'assigned', context: { programId, lessonId } }));
    const link = await screen.findByRole('link', { name: 'Try again from the lesson' });
    expect(link).toHaveAttribute('href', `/training/${programId}/lessons/${lessonId}`);
    expect(screen.getByRole('button', { name: 'Practice again' })).toBeInTheDocument();
  });

  it('runs a trainer test again through the test endpoint and returns to the scenario', async () => {
    const user = userEvent.setup();
    const s = evaluated({ isTest: true });
    const next = session({ scenario: s.scenario, isTest: true });
    const { api } = setup(s, {
      'GET /auth/me': meHandler(['ai_scenarios.update']),
      [`GET /ai/scenarios/${s.scenario.id}`]: () =>
        json(403, { error: { code: 'FORBIDDEN', message: 'No' } }),
      [`POST /ai/scenarios/${s.scenario.id}/test-sessions`]: () => next,
    });
    expect(await screen.findByText('Test run')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to scenario' })).toHaveAttribute(
      'href',
      `/content/ai-scenarios/${s.scenario.id}`,
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText(`Elsewhere: /ai-coach/sessions/${next.id}`);
    expect(api.callsTo(`POST /ai/scenarios/${s.scenario.id}/test-sessions`)).toHaveLength(1);
  });

  describe('while scoring', () => {
    it('shows progress and swaps in the scorecard when it is ready', async () => {
      const pending = session({
        status: 'ended',
        endedAt: new Date().toISOString(),
        messages: transcript,
        turnCount: 1,
      });
      let reads = 0;
      setup(pending, {
        [`GET /ai/sessions/${pending.id}`]: () =>
          ++reads < 2 ? pending : { ...evaluated(), id: pending.id, scenario: pending.scenario },
      });
      await screen.findByText('Scoring your conversation');
      // The transcript is already readable while the scorecard is on its way.
      expect(screen.getByRole('list', { name: 'Transcript' })).toBeInTheDocument();
      await screen.findByRole('region', { name: 'Overall score' }, { timeout: 5000 });
      expect(screen.queryByText('Scoring your conversation')).not.toBeInTheDocument();
    });

    it('lets the learner retry scoring after a failure', async () => {
      const user = userEvent.setup();
      const failed = session({
        status: 'evaluation_failed',
        evaluationError:
          'The scoring service was unavailable. Retry the evaluation in a few minutes.',
        endedAt: '2026-10-05T16:04:00.000Z',
        messages: transcript,
        turnCount: 1,
      });
      const { api } = setup(failed, {
        [`POST /ai/sessions/${failed.id}/evaluation/retry`]: () => ({
          ...failed,
          status: 'ended',
          evaluationError: null,
          endedAt: new Date().toISOString(),
        }),
      });
      await screen.findByText(/scoring service was unavailable/);
      await user.click(screen.getByRole('button', { name: 'Retry scoring' }));
      await screen.findByText('Scoring your conversation');
      expect(api.callsTo(`POST /ai/sessions/${failed.id}/evaluation/retry`)).toHaveLength(1);
    });
  });

  it('explains an empty conversation instead of showing a blank scorecard', async () => {
    setup(session({ status: 'abandoned', messages: [opening], turnCount: 0 }));
    await screen.findByText('Nothing to score');
    expect(screen.queryByText('Transcript')).not.toBeInTheDocument();
  });

  it('points a conversation still in progress back to the chat', async () => {
    const s = session();
    setup(s);
    const notice = await screen.findByText('This conversation is still going');
    expect(notice).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute(
      'href',
      `/ai-coach/sessions/${s.id}`,
    );
  });

  it('says so when the transcript was removed by retention', async () => {
    setup(evaluated({ transcriptPurged: true, messages: [] }));
    await screen.findByText('The transcript was removed');
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'See in transcript' })).toBeNull(),
    );
  });

  it('shows coach feedback from reviewers', async () => {
    setup(
      evaluated({
        reviews: [
          {
            id: '00000000-0000-4000-8000-0000000000d1',
            reviewer: {
              id: '00000000-0000-4000-8000-0000000000d2',
              displayName: 'Hector Villanueva',
            },
            comment: 'Slow down and ask for the appointment earlier.',
            recommendation: 'practice_again',
            createdAt: '2026-10-05T17:00:00.000Z',
          },
        ],
      }),
    );
    await screen.findByText('Coach feedback');
    expect(screen.getByText('Hector Villanueva')).toBeInTheDocument();
    expect(screen.getByText('Practice again')).toBeInTheDocument();
  });

  it('reports a missing scorecard as unavailable', async () => {
    const s = session();
    setup(s, {
      [`GET /ai/sessions/${s.id}`]: () =>
        json(404, { error: { code: 'NOT_FOUND', message: 'Practice session not found.' } }),
    });
    await screen.findByText('This scorecard is not available');
  });
});

describe('scorecardPollInterval', () => {
  const now = Date.parse('2026-10-05T16:10:00.000Z');
  const ended = (endedAt: string, status: 'ended' | 'evaluating' = 'ended') =>
    session({ status, endedAt });

  it('polls quickly right after the conversation, then more slowly', () => {
    expect(scorecardPollInterval(ended('2026-10-05T16:09:45.000Z'), now)).toBe(2_000);
    expect(scorecardPollInterval(ended('2026-10-05T16:05:00.000Z', 'evaluating'), now)).toBe(5_000);
  });

  it('stops once there is nothing left to wait for', () => {
    expect(scorecardPollInterval(evaluated(), now)).toBe(false);
    expect(scorecardPollInterval(session({ status: 'evaluation_failed' }), now)).toBe(false);
    expect(scorecardPollInterval(session({ status: 'abandoned' }), now)).toBe(false);
    expect(scorecardPollInterval(undefined, now)).toBe(false);
  });
});
