import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ai } from '@a5/contracts';
import { json, meHandler, mockApi, renderRoute } from '@/test/render';
import { CoachPage } from './coach-page';
import { session } from './test-fixtures';

afterEach(() => vi.restoreAllMocks());

const ID = {
  card: '00000000-0000-4000-8000-0000000000e1',
  roof: '00000000-0000-4000-8000-0000000000e2',
};

function scenario(over: Partial<ai.PracticeScenario>): ai.PracticeScenario {
  return {
    id: ID.card,
    title: 'Just Leave Your Card',
    category: 'Brush-off',
    difficulty: 'beginner',
    objection: 'Just leave your card.',
    persona: { name: 'Busy homeowner' },
    passingScore: 75,
    maxTurns: 8,
    myStats: { attempts: 0, bestScore: null, passed: false, lastPracticedAt: null },
    ...over,
  };
}

const catalog = [
  scenario({}),
  scenario({
    id: ID.roof,
    title: 'My Roof Looks Fine',
    category: 'Need',
    difficulty: 'intermediate',
    objection: 'My roof looks fine.',
    persona: { name: 'Friendly homeowner' },
    maxTurns: 10,
    myStats: {
      attempts: 2,
      bestScore: 71,
      passed: false,
      lastPracticedAt: '2026-09-30T17:46:00.000Z',
    },
  }),
];

const page = <T,>(items: T[]) => ({
  items,
  page: 1,
  pageSize: 12,
  total: items.length,
  pageCount: 1,
});

const brief = {
  ...catalog[0]!,
  repBrief: 'It is a Monday morning in Irving.',
  persona: { name: 'Busy homeowner', description: 'Always mid-task.' },
  scoredOn: [
    { key: 'discovery', label: 'Discovery' },
    { key: 'empathy', label: 'Empathy' },
  ],
};

function setup(
  extra: Parameters<typeof mockApi>[0] = {},
  route = '/ai-coach',
  perms = ['ai_practice.use'],
) {
  const api = mockApi({
    'GET /auth/me': meHandler(perms as never),
    'GET /ai/practice/scenarios': () => page(catalog),
    [`GET /ai/practice/scenarios/${ID.card}`]: () => brief,
    'GET /ai/me/sessions': (req) => (req.query.get('status') === 'active' ? page([]) : page([])),
    ...extra,
  });
  renderRoute(<CoachPage />, { route, path: '/ai-coach' });
  return api;
}

describe('scenario picker', () => {
  it('lists scenarios with difficulty, turn limit, objection and the learner’s best score', async () => {
    setup();
    const list = await screen.findByRole('list', { name: 'Practice scenarios' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Just Leave Your Card')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Beginner')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Up to 8 turns')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Not tried yet')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(within(rows[1]!).getByText('71')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/pass 75/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Not passed yet')).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('button', { name: 'Practice again' })).toBeInTheDocument();
  });

  it('does not invent an estimated time or a locked state the API does not provide', async () => {
    setup();
    await screen.findByRole('list', { name: 'Practice scenarios' });
    expect(screen.queryByText(/\bmin\b|minutes/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/locked/i)).not.toBeInTheDocument();
  });

  it('filters on the server by difficulty and search text', async () => {
    const user = userEvent.setup();
    const api = setup();
    await screen.findByRole('list', { name: 'Practice scenarios' });
    await user.selectOptions(screen.getByLabelText('Difficulty'), 'intermediate');
    await waitFor(() =>
      expect(
        api
          .callsTo('GET /ai/practice/scenarios')
          .some((c) => c.query.get('difficulty') === 'intermediate'),
      ).toBe(true),
    );
  });

  it('builds the category filter from the catalog', async () => {
    setup();
    const select = await screen.findByLabelText('Category');
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: 'Need' })).toBeInTheDocument(),
    );
    expect(within(select).getByRole('option', { name: 'Brush-off' })).toBeInTheDocument();
  });

  it('explains an empty catalog and an empty search differently', async () => {
    setup({ 'GET /ai/practice/scenarios': () => page([]) });
    await screen.findByText('No scenarios to practice yet');
  });

  it('shows an error with a retry when the catalog cannot load', async () => {
    const user = userEvent.setup();
    let fail = true;
    setup({
      'GET /ai/practice/scenarios': () =>
        fail
          ? json(400, { error: { code: 'BAD', message: 'The catalog is unavailable.' } })
          : page(catalog),
    });
    await screen.findByText('The catalog is unavailable.');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('list', { name: 'Practice scenarios' });
  });

  it('requires the practice permission', async () => {
    setup({}, '/ai-coach', ['training.participate']);
    await screen.findByText("You don't have access to this page");
  });
});

describe('starting a conversation', () => {
  it('shows the brief before starting, then opens the conversation', async () => {
    const user = userEvent.setup();
    const started = session({ scenario: { ...session().scenario, id: ID.card } });
    const api = setup({ 'POST /ai/sessions': () => started });

    await user.click((await screen.findAllByRole('button', { name: 'Start' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: /Just Leave Your Card/ });
    expect(
      await within(dialog).findByText('It is a Monday morning in Irving.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Always mid-task/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Discovery, Empathy/)).toBeInTheDocument();
    expect(within(dialog).getByText(/up to 8 turns/)).toBeInTheDocument();
    expect(within(dialog).getByText(/score of 75 or more/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Start conversation' }));
    await screen.findByText(`Elsewhere: /ai-coach/sessions/${started.id}`);
    expect(api.callsTo('POST /ai/sessions')[0]!.body).toEqual({
      scenarioId: ID.card,
      modality: 'text',
    });
  });

  it('opens the brief straight from a link and keeps the dialog on the page', async () => {
    setup({}, `/ai-coach?scenario=${ID.card}`);
    await screen.findByRole('dialog', { name: /Just Leave Your Card/ });
  });

  it('tells the learner why a conversation could not start', async () => {
    const user = userEvent.setup();
    setup(
      {
        'POST /ai/sessions': () =>
          json(429, {
            error: {
              code: 'DAILY_SESSION_LIMIT',
              message:
                "You've reached today's limit of 5 practice sessions. Your limit resets at midnight.",
            },
          }),
      },
      `/ai-coach?scenario=${ID.card}`,
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Start conversation' }));
    await within(dialog).findByText(/limit of 5 practice sessions/);
    expect(within(dialog).getByRole('button', { name: 'Start conversation' })).toBeEnabled();
  });
});

describe('resume and history', () => {
  const summary = (over: Partial<ai.SessionSummary>): ai.SessionSummary => ({
    id: '00000000-0000-4000-8000-0000000000f1',
    scenario: {
      id: ID.roof,
      title: 'My Roof Looks Fine',
      category: 'Need',
      difficulty: 'beginner',
      objection: 'My roof looks fine.',
    },
    mode: 'practice',
    isTest: false,
    status: 'evaluated',
    endReason: 'rep_ended',
    turnCount: 6,
    startedAt: '2026-09-30T17:46:00.000Z',
    endedAt: '2026-09-30T17:58:00.000Z',
    overallScore: 71,
    passed: false,
    provider: {
      name: 'dev_simulator',
      label: 'Development simulator',
      model: 'm',
      simulated: true,
    },
    ...over,
  });

  it('offers to continue a conversation that is still open', async () => {
    const open = summary({
      id: '00000000-0000-4000-8000-0000000000f2',
      status: 'active',
      overallScore: null,
      passed: null,
    });
    setup({
      'GET /ai/me/sessions': (req) =>
        req.query.get('status') === 'active' ? page([open]) : page([]),
    });
    await screen.findByText('Conversation in progress: My Roof Looks Fine');
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute(
      'href',
      `/ai-coach/sessions/${open.id}`,
    );
  });

  it('lists past conversations with their result and links to the scorecard', async () => {
    const user = userEvent.setup();
    const done = summary({});
    const scoring = summary({
      id: '00000000-0000-4000-8000-0000000000f3',
      status: 'ended',
      overallScore: null,
      passed: null,
    });
    setup({ 'GET /ai/me/sessions': () => page([done, scoring]) });
    await user.click(await screen.findByRole('tab', { name: 'History' }));
    const table = await screen.findByRole('table', { name: /practice conversations/ });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]!).getByText('Below pass mark')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('71')).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('link', { name: /View/ })).toHaveAttribute(
      'href',
      `/ai-coach/sessions/${done.id}/scorecard`,
    );
    expect(within(rows[2]!).getByText('Scoring')).toBeInTheDocument();
  });

  it('invites a first conversation when there is no history', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('tab', { name: 'History' }));
    await screen.findByText('No conversations yet');
  });
});
