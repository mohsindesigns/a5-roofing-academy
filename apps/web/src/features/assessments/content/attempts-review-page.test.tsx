import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { renderWithProviders } from '../test-render';
import { ids, reviewDetail, reviewSummary } from '../test-fixtures';
import { grant } from '../test-session';
import { AttemptsReviewPage } from './attempts-review-page';
import { categoryBreakdown } from './attempt-detail-sheet';

vi.mock('@/lib/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/features/auth/session', () => import('../test-session'));

const page = (items: unknown[]) => ({
  items,
  page: 1,
  pageSize: 25,
  total: items.length,
  pageCount: 1,
});

function Where() {
  const { search } = useLocation();
  return <p data-testid="search">{search}</p>;
}

const attempts = [
  reviewSummary(),
  reviewSummary({
    id: ids.id(951),
    learner: { id: ids.id(3), displayName: 'Brianna Castillo' },
    status: 'pending_review',
    scorePercent: null,
    passed: null,
    pendingReviewCount: 2,
  }),
  reviewSummary({
    id: ids.id(952),
    learner: { id: ids.id(4), displayName: 'Ashlyn Pierce' },
    scorePercent: 92,
    passed: true,
    overridden: true,
  }),
];

function mockApi() {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/attempts') return page(attempts);
    if (path === `/attempts/${ids.id(950)}/review`) return reviewDetail();
    if (path === '/assessments')
      return { ...page([{ id: ids.id(800), title: 'Week 1 Knowledge Check' }]) };
    throw new Error(`Unmocked GET ${path}`);
  });
}

function renderPage(route = '/content/assessments/attempts') {
  return renderWithProviders(
    <>
      <Where />
      <Routes>
        <Route path="/content/assessments/attempts" element={<AttemptsReviewPage />} />
      </Routes>
    </>,
    { route },
  );
}

const lastQuery = () =>
  vi
    .mocked(api.get)
    .mock.calls.filter((c) => c[0] === '/attempts')
    .at(-1)![1] as Record<string, unknown>;

beforeEach(() => {
  for (const fn of Object.values(api)) vi.mocked(fn).mockReset();
  mockApi();
  grant('assessments.view', 'assessment_attempts.view', 'users.view');
});

describe('AttemptsReviewPage', () => {
  it('lists attempts with status, score and result', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'Attempts' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Marcus Delgado');
    expect(rows[0]).toHaveTextContent('66.7%');
    expect(rows[0]).toHaveTextContent('Not passed');
    expect(rows[1]).toHaveTextContent('Awaiting review');
    expect(rows[1]).toHaveTextContent('2 to review');
    expect(rows[2]).toHaveTextContent('92%');
    expect(rows[2]).toHaveTextContent('adjusted');
  });

  it('asks newest submissions first and keeps filters in the URL', async () => {
    renderPage();
    await screen.findByRole('table');
    expect(lastQuery()).toMatchObject({ sort: '-submittedAt', page: 1 });
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Status' }),
      'Awaiting review',
    );
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Assessment' }),
      'Week 1 Knowledge Check',
    );
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({ status: 'pending_review', assessmentId: ids.id(800) }),
    );
    expect(screen.getByTestId('search')).toHaveTextContent('status=pending_review');
    expect(screen.getByTestId('search')).toHaveTextContent(`assessmentId=${ids.id(800)}`);
  });

  it('turns a date range into instants the API accepts', async () => {
    renderPage('/content/assessments/attempts?from=2026-10-01&to=2026-10-03');
    await screen.findByRole('table');
    const q = lastQuery() as { submittedFrom: string; submittedTo: string };
    expect(new Date(q.submittedFrom).getTime()).toBe(new Date('2026-10-01T00:00:00').getTime());
    // The end date is inclusive: the API is given the start of the next day.
    expect(new Date(q.submittedTo).getTime()).toBe(new Date('2026-10-04T00:00:00').getTime());
    expect(screen.getByLabelText('Submitted from')).toHaveValue('2026-10-01');
  });

  it('opens a read-only breakdown of one attempt and keeps it in the URL', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /^Marcus Delgado/ }));
    const sheet = await screen.findByRole('dialog', { name: /Marcus Delgado: attempt 1/ });
    expect(screen.getByTestId('search')).toHaveTextContent(`attempt=${ids.id(950)}`);
    expect(await within(sheet).findByText('Result')).toBeInTheDocument();
    expect(within(sheet).getByText('Pass mark 80%')).toBeInTheDocument();
    expect(within(sheet).getAllByRole('listitem').length).toBeGreaterThanOrEqual(4);
    // Nothing in it can be edited.
    expect(within(sheet).queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      within(sheet).queryByRole('button', { name: /grade|override|save/i }),
    ).not.toBeInTheDocument();
  });

  it('shows points by category, with open answers kept apart from zeros', async () => {
    renderPage(`/content/assessments/attempts?attempt=${ids.id(950)}`);
    const sheet = await screen.findByRole('dialog', { name: /Marcus Delgado: attempt 1/ });
    const table = await within(sheet).findByRole('table', { name: 'Points by category' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('No category');
    expect(rows[0]).toHaveTextContent('1 awaiting review');
    expect(rows[1]).toHaveTextContent('Objection handling');
    expect(rows[1]).toHaveTextContent('2 of 2');
    expect(rows[1]).toHaveTextContent('100%');
    expect(rows[2]).toHaveTextContent('Storm damage');
    expect(rows[2]).toHaveTextContent('2 of 4');
    expect(rows[2]).toHaveTextContent('50%');
  });

  it('shows the learner answer next to the correct one, with option text', async () => {
    renderPage(`/content/assessments/attempts?attempt=${ids.id(950)}`);
    const sheet = await screen.findByRole('dialog', { name: /Marcus Delgado: attempt 1/ });
    const answers = await within(sheet).findByRole('list', { name: 'Answers' });
    const second = within(answers).getAllByRole('listitem')[1]!;
    expect(within(second).getByText('The sales manager')).toBeInTheDocument();
    expect(within(second).getByText('The homeowner')).toBeInTheDocument();
    expect(within(second).getByText('Incorrect')).toBeInTheDocument();
  });

  it('closing the breakdown removes it from the URL but keeps the list filters', async () => {
    renderPage(`/content/assessments/attempts?status=graded&attempt=${ids.id(950)}`);
    const sheet = await screen.findByRole('dialog', { name: /Marcus Delgado: attempt 1/ });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('search')).toHaveTextContent('status=graded');
    expect(screen.getByTestId('search')).not.toHaveTextContent('attempt=');
  });

  it('shows the API message when an attempt is out of scope', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/attempts') return page(attempts);
      if (path.endsWith('/review'))
        throw new ApiError(
          404,
          'NOT_FOUND',
          'This item no longer exists or you no longer have access to it.',
        );
      throw new Error(`Unmocked GET ${path}`);
    });
    renderPage(`/content/assessments/attempts?attempt=${ids.id(999)}`);
    expect(
      await screen.findByText('This item no longer exists or you no longer have access to it.'),
    ).toBeInTheDocument();
  });

  describe('for a manager', () => {
    beforeEach(() => grant('assessment_attempts.view'));

    it('does not ask for the assessment list or offer its filter', async () => {
      renderPage();
      await screen.findByRole('table');
      expect(api.get).not.toHaveBeenCalledWith(
        '/assessments',
        expect.anything(),
        expect.anything(),
      );
      expect(screen.queryByRole('combobox', { name: 'Assessment' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('navigation', { name: 'Assessment sections' }),
      ).not.toBeInTheDocument();
    });

    it('does not link the learner or the assessment without view rights for them', async () => {
      renderPage(`/content/assessments/attempts?attempt=${ids.id(950)}`);
      const sheet = await screen.findByRole('dialog', { name: /Marcus Delgado: attempt 1/ });
      await within(sheet).findByText('Result');
      expect(within(sheet).queryByRole('link', { name: 'Marcus Delgado' })).not.toBeInTheDocument();
      expect(
        within(sheet).queryByRole('link', { name: 'Week 1 Knowledge Check' }),
      ).not.toBeInTheDocument();
    });
  });

  it('explains when nothing matches, and when there is nothing yet', async () => {
    vi.mocked(api.get).mockResolvedValue(page([]));
    renderPage('/content/assessments/attempts?status=expired');
    expect(await screen.findByText('No attempts match these filters')).toBeInTheDocument();
  });

  it('denies a role without attempt access', async () => {
    grant('assessments.view');
    renderPage();
    expect(await screen.findByText("You don't have access to this page")).toBeInTheDocument();
  });
});

describe('categoryBreakdown', () => {
  it('groups points by category name, sorted', () => {
    const rows = categoryBreakdown(reviewDetail().questions);
    expect(rows.map((r) => r.name)).toEqual(['No category', 'Objection handling', 'Storm damage']);
    expect(rows.find((r) => r.name === 'Storm damage')).toMatchObject({
      earned: 2,
      possible: 4,
      questions: 2,
      awaitingReview: 0,
    });
    expect(rows.find((r) => r.name === 'No category')).toMatchObject({
      earned: 0,
      possible: 0,
      awaitingReview: 1,
    });
  });
});
