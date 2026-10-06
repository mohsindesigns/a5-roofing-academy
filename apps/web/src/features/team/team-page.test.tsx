import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionKey } from '@a5/permissions';
import { sessionKeys } from '@/features/auth/session';
import { useAuth } from '@/lib/auth-store';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ api: { get, post: vi.fn(), put: vi.fn() } }));

import { TeamPage } from './team-page';

const U1 = '0192f7a0-0000-7000-8000-000000000001';
const U2 = '0192f7a0-0000-7000-8000-000000000002';
const PROGRAM = { id: '0192f7a0-0000-7000-8000-0000000000p1', title: 'A5 New Hire Sales Academy' };

const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  enrollmentId: `e-${id}`,
  learner: {
    id,
    displayName: name,
    email: `${name}@a5roofing.example`,
    jobTitle: 'Sales Representative',
    teams: [{ id: 't1', name: 'Dallas Residential A' }],
  },
  program: PROGRAM,
  status: 'active',
  progressPercent: 32,
  requiredTotal: 25,
  requiredCompleted: 8,
  currentPhase: { id: 'ph', title: 'Roofing', label: 'Week 2', position: 2 },
  enrolledAt: '2026-09-01T12:00:00.000Z',
  lastActivityAt: '2026-10-01T12:00:00.000Z',
  dueAt: '2026-10-20T12:00:00.000Z',
  overdue: false,
  attention: [],
  ...extra,
});

const rows = [
  row(U1, 'Marcus Delgado', {
    overdue: true,
    attention: [
      { code: 'inactive', message: 'No activity in 11 days' },
      { code: 'overdue', message: 'Overdue by 7 days' },
    ],
  }),
  row(U2, 'Jordan Whitfield'),
];

function Where() {
  return <p data-testid="url">{useLocation().search}</p>;
}

function renderTeam(
  permissions: PermissionKey[] = ['enrollments.view', 'programs.view', 'teams.view'],
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionKeys.me, {
    user: { id: 'me', displayName: 'Danielle Okafor' },
    permissions: Object.fromEntries(permissions.map((p) => [p, 'managed'])),
    featureFlags: {},
    managedTeamIds: [],
  });
  useAuth.setState({ status: 'authenticated', accessToken: 't', expiresAt: Date.now() + 600_000 });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/team']}>
        <TeamPage />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (path: string, query: Record<string, unknown> = {}) => {
    if (path === '/progress/team') {
      const items = query.attention === 'true' ? rows.filter((r) => r.attention.length) : rows;
      return {
        items,
        page: 1,
        pageSize: Number(query.pageSize ?? 25),
        total: items.length,
        pageCount: 1,
      };
    }
    if (path === '/programs')
      return {
        items: [{ ...PROGRAM, status: 'published' }],
        page: 1,
        pageSize: 100,
        total: 1,
        pageCount: 1,
      };
    if (path === '/teams') return { items: [{ id: 't1', name: 'Dallas Residential A' }] };
    if (path.startsWith('/progress/learners/'))
      return {
        learner: rows[0]!.learner,
        enrollments: [rows[0]],
        assessments: [
          {
            id: 'a1',
            title: 'Week 1 Knowledge Check',
            kind: 'quiz',
            bestScore: 90,
            lastScore: 90,
            passed: true,
            attempts: 1,
            lastAt: '2026-09-20T12:00:00.000Z',
          },
        ],
        aiScenarios: [],
      };
    return {};
  });
});
afterEach(cleanup);

describe('Team page', () => {
  it('lists enrollments with progress and the flags the API computed', async () => {
    renderTeam();
    const table = await screen.findByRole('table', { name: 'Team progress' });
    expect(within(table).getByText('Marcus Delgado')).toBeInTheDocument();
    expect(within(table).getByText('Jordan Whitfield')).toBeInTheDocument();
    // The most urgent flag leads, and the less urgent one is counted.
    // (Phones get the same figures stacked in the first cell, so each appears twice in the DOM.)
    expect(within(table).getAllByText('Overdue').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('+1 more').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('On track').length).toBeGreaterThan(0);
    expect(within(table).getAllByRole('progressbar')[0]).toHaveAttribute('aria-valuenow', '32');
  });

  it('keeps the attention filter in the URL and asks the API for flagged rows only', async () => {
    const user = userEvent.setup();
    renderTeam();
    await screen.findByRole('table', { name: 'Team progress' });
    await user.click(screen.getByRole('switch', { name: 'Needs attention only' }));
    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('attention=true'));
    await waitFor(() => expect(screen.queryByText('Jordan Whitfield')).not.toBeInTheDocument());
    expect(get).toHaveBeenCalledWith(
      '/progress/team',
      expect.objectContaining({ attention: 'true' }),
      expect.anything(),
    );
  });

  it('searches after a pause and writes the search to the URL', async () => {
    const user = userEvent.setup();
    renderTeam();
    await screen.findByRole('table', { name: 'Team progress' });
    await user.type(screen.getByRole('searchbox', { name: 'Search people' }), 'marc');
    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('q=marc'));
    expect(get).toHaveBeenCalledWith(
      '/progress/team',
      expect.objectContaining({ q: 'marc' }),
      expect.anything(),
    );
  });

  it('opens a person from the table and keeps the table where it was', async () => {
    const user = userEvent.setup();
    renderTeam();
    await user.click(
      await screen.findByRole('button', { name: 'Marcus Delgado, open progress details' }),
    );
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('Week 1 Knowledge Check')).toBeInTheDocument();
    expect(within(drawer).getByText('Overdue by 7 days')).toBeInTheDocument();
    expect(screen.getByTestId('url')).toHaveTextContent(`learner=${U1}`);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('url')).not.toHaveTextContent('learner=');
  });

  it('only offers assignment to people who may assign', async () => {
    const { unmount } = renderTeam();
    await screen.findByRole('table', { name: 'Team progress' });
    expect(screen.queryByRole('button', { name: 'Assign program' })).not.toBeInTheDocument();
    unmount();
    renderTeam(['enrollments.view', 'programs.view', 'programs.assign']);
    expect(await screen.findByRole('button', { name: 'Assign program' })).toBeInTheDocument();
  });

  it('explains an API failure and lets the user retry', async () => {
    const user = userEvent.setup();
    get.mockImplementation(async (path: string) => {
      if (path === '/progress/team') throw new Error('The server could not complete the request.');
      return { items: [] };
    });
    renderTeam();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The server could not complete the request.');
    get.mockImplementation(async (path: string) =>
      path === '/progress/team'
        ? { items: rows, page: 1, pageSize: 25, total: 2, pageCount: 1 }
        : { items: [] },
    );
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Marcus Delgado')).toBeInTheDocument();
  });
});
