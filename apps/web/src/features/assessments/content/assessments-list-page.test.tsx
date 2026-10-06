import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { renderWithProviders } from '../test-render';
import { assessmentDetail, ids } from '../test-fixtures';
import { grant } from '../test-session';
import { AssessmentsListPage } from './assessments-list-page';

vi.mock('@/lib/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/features/auth/session', () => import('../test-session'));

const row = (n: number, over: Record<string, unknown> = {}) => ({
  id: ids.id(800 + n),
  title: `Assessment ${n}`,
  description: n === 1 ? 'Checks how A5 earns trust.' : null,
  kind: 'quiz',
  status: 'published',
  passingPercent: 80,
  itemCount: 8,
  questionCount: 8,
  attemptCount: 21,
  publishedAt: '2026-09-16T10:00:00.000Z',
  archivedAt: null,
  createdAt: '2026-09-02T10:00:00.000Z',
  updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  ...over,
});

const page = (items: unknown[]) => ({
  items,
  page: 1,
  pageSize: 25,
  total: items.length,
  pageCount: 1,
});

function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{`${pathname}${search}`}</p>;
}

function renderPage(route = '/content/assessments') {
  return renderWithProviders(
    <>
      <Where />
      <Routes>
        <Route path="/content/assessments" element={<AssessmentsListPage />} />
        <Route path="/content/assessments/attempts" element={<p>Attempts page</p>} />
        <Route path="/content/assessments/:id" element={<p>Builder page</p>} />
      </Routes>
    </>,
    { route },
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) vi.mocked(fn).mockReset();
  vi.mocked(api.get).mockResolvedValue(
    page([row(1), row(2, { status: 'draft', attemptCount: 0 })]),
  );
  grant('assessments.view', 'assessments.create', 'assessments.update');
});

describe('AssessmentsListPage', () => {
  it('lists assessments with their status, pass mark and size', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'Assessments' });
    expect(within(table).getByRole('link', { name: /Assessment 1/ })).toHaveAttribute(
      'href',
      `/content/assessments/${ids.id(801)}`,
    );
    expect(within(table).getByText('Published')).toBeInTheDocument();
    expect(within(table).getByText('Draft')).toBeInTheDocument();
    expect(within(table).getAllByText('80%')).toHaveLength(2);
  });

  it('hides draft and archived clutter by default and keeps filters in the URL', async () => {
    renderPage();
    await screen.findByRole('table');
    expect(api.get).toHaveBeenLastCalledWith(
      '/assessments',
      expect.objectContaining({ status: 'draft,published', sort: '-updatedAt', page: 1 }),
      expect.anything(),
    );
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Archived');
    await waitFor(() =>
      expect(api.get).toHaveBeenLastCalledWith(
        '/assessments',
        expect.objectContaining({ status: 'archived' }),
        expect.anything(),
      ),
    );
    expect(screen.getByTestId('where')).toHaveTextContent('status=archived');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'All statuses');
    await waitFor(() =>
      expect(vi.mocked(api.get).mock.calls.at(-1)![1]).not.toHaveProperty('status', 'archived'),
    );
    expect(vi.mocked(api.get).mock.calls.at(-1)![1]).toMatchObject({ status: undefined });
  });

  it('restores filters from the URL', async () => {
    renderPage('/content/assessments?status=published&kind=final&q=sales');
    await screen.findByRole('table');
    expect(api.get).toHaveBeenCalledWith(
      '/assessments',
      expect.objectContaining({ status: 'published', kind: 'final', q: 'sales' }),
      expect.anything(),
    );
    expect(screen.getByRole('combobox', { name: 'Type' })).toHaveValue('final');
    expect(screen.getByRole('searchbox', { name: 'Search assessments' })).toHaveValue('sales');
  });

  it('offers a way out when filters match nothing', async () => {
    vi.mocked(api.get).mockResolvedValue(page([]));
    renderPage('/content/assessments?kind=exam');
    expect(await screen.findByText('No assessments match these filters')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByTestId('where')).not.toHaveTextContent('kind=exam'));
  });

  it('invites an author to create the first assessment', async () => {
    vi.mocked(api.get).mockResolvedValue(page([]));
    renderPage();
    expect(await screen.findByText('No assessments yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New assessment' }).length).toBeGreaterThan(0);
  });

  it('tells a viewer without create rights to ask for one instead', async () => {
    grant('assessments.view');
    vi.mocked(api.get).mockResolvedValue(page([]));
    renderPage();
    expect(
      await screen.findByText('Ask a training administrator to create one.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New assessment' })).not.toBeInTheDocument();
  });

  it('shows the error and retries', async () => {
    vi.mocked(api.get)
      .mockRejectedValueOnce(
        new ApiError(
          500,
          'INTERNAL',
          'The server could not complete the request. Try again in a moment.',
        ),
      )
      .mockResolvedValue(page([row(1)]));
    renderPage();
    expect(
      await screen.findByText('The server could not complete the request. Try again in a moment.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('creates a draft and opens it in the builder', async () => {
    vi.mocked(api.post).mockResolvedValue(assessmentDetail({ id: ids.id(899) }));
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: 'New assessment' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));
    expect(await within(dialog).findByText('Give the assessment a title')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Title/ }),
      'Week 5 Knowledge Check',
    );
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: /Type/ }), 'Exam');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/assessments', {
        title: 'Week 5 Knowledge Check',
        kind: 'exam',
        description: null,
      }),
    );
    expect(await screen.findByText('Builder page')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(`/content/assessments/${ids.id(899)}`);
  });

  it('sends a person who can only follow attempts to the attempts page', async () => {
    grant('assessment_attempts.view');
    renderPage();
    expect(await screen.findByText('Attempts page')).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('explains when the role has no access at all', async () => {
    grant('programs.view');
    renderPage();
    expect(await screen.findByText("You don't have access to this page")).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });
});
