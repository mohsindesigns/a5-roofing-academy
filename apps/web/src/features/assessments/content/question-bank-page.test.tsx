import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import type { assessment } from '@a5/contracts';
import { api } from '@/lib/api/client';
import { renderWithProviders } from '../test-render';
import { BANK_ID, CATEGORY_ID, bankDetail, bankSummary, ids } from '../test-fixtures';
import { grant } from '../test-session';
import { QuestionBankPage } from './question-bank-page';

vi.mock('@/lib/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/features/auth/session', () => import('../test-session'));

const question = (
  n: number,
  over: Partial<assessment.QuestionSummary> = {},
): assessment.QuestionSummary => ({
  id: ids.id(600 + n),
  bank: { id: BANK_ID, title: 'A5 Sales Core' },
  status: 'active',
  versionId: ids.id(700 + n),
  version: n,
  type: 'multiple_choice',
  prompt: `Question prompt ${n}`,
  difficulty: 'medium',
  points: 1,
  category: { id: CATEGORY_ID, name: 'Storm damage' },
  tags: [],
  competencyIds: [],
  manualReview: false,
  usedInAssessments: n === 1 ? 2 : 0,
  updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
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

let banks = [bankSummary()];
let questions: assessment.QuestionSummary[] = [];

function mockApi() {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/question-banks') return page(banks);
    if (path.startsWith('/question-banks/')) return bankDetail();
    if (path === '/questions') return page(questions);
    throw new Error(`Unmocked GET ${path}`);
  });
}

function renderPage(route = '/content/questions') {
  return renderWithProviders(
    <>
      <Where />
      <Routes>
        <Route path="/content/questions" element={<QuestionBankPage />} />
        <Route path="/content/questions/:id" element={<p>Editor page</p>} />
        <Route path="/content/assessments" element={<p>Assessments page</p>} />
      </Routes>
    </>,
    { route },
  );
}

const lastQuery = () =>
  vi
    .mocked(api.get)
    .mock.calls.filter((c) => c[0] === '/questions')
    .at(-1)![1] as Record<string, unknown>;

beforeEach(() => {
  for (const fn of Object.values(api)) vi.mocked(fn).mockReset();
  banks = [bankSummary()];
  questions = [
    question(1),
    question(2, { type: 'long_answer', manualReview: true, difficulty: 'hard', category: null }),
    question(3, { status: 'archived' }),
  ];
  mockApi();
  grant('assessments.view', 'assessments.create', 'assessments.update');
});

describe('QuestionBankPage', () => {
  it('lists questions with type, category, difficulty and where they are used', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'Questions' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Question prompt 1');
    expect(rows[0]).toHaveTextContent('Multiple choice');
    expect(rows[0]).toHaveTextContent('Storm damage');
    expect(rows[1]).toHaveTextContent('Long answer');
    expect(rows[1]).toHaveTextContent('Reviewed by a trainer');
    expect(rows[1]).toHaveTextContent('Hard');
    expect(rows[2]).toHaveTextContent('Archived');
    expect(within(rows[0]!).getByText('2')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Not used')).toBeInTheDocument();
  });

  it('asks for active questions by default', async () => {
    renderPage();
    await screen.findByRole('table');
    expect(lastQuery()).toMatchObject({
      status: 'active',
      sort: '-updatedAt',
      page: 1,
      pageSize: 25,
    });
  });

  it('puts every filter in the URL and sends it to the API', async () => {
    renderPage();
    await screen.findByRole('table');
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Question type' }),
      'Ordering',
    );
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Difficulty' }), 'Hard');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Archived');
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({
        type: 'ordering',
        difficulty: 'hard',
        status: 'archived',
      }),
    );
    const where = screen.getByTestId('where').textContent!;
    expect(where).toContain('type=ordering');
    expect(where).toContain('difficulty=hard');
    expect(where).toContain('status=archived');
  });

  it('can only filter by category once a bank is chosen', async () => {
    renderPage();
    await screen.findByRole('table');
    const category = screen.getByRole('combobox', { name: 'Category' });
    expect(category).toBeDisabled();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Question bank' }),
      'A5 Sales Core',
    );
    await waitFor(() => expect(category).toBeEnabled());
    await userEvent.selectOptions(category, 'Storm damage');
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({ bankId: BANK_ID, categoryId: CATEGORY_ID }),
    );
  });

  it('clears the category when the bank changes', async () => {
    renderPage(`/content/questions?bankId=${BANK_ID}&categoryId=${CATEGORY_ID}`);
    await screen.findByRole('table');
    expect(lastQuery()).toMatchObject({ categoryId: CATEGORY_ID });
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Question bank' }),
      'All banks',
    );
    await waitFor(() => expect(lastQuery().categoryId).toBeUndefined());
    expect(screen.getByTestId('where')).not.toHaveTextContent('categoryId');
  });

  it('restores filters when the page is opened from a link', async () => {
    renderPage('/content/questions?type=matching&difficulty=easy&status=all&q=roof');
    await screen.findByRole('table');
    expect(lastQuery()).toMatchObject({
      type: 'matching',
      difficulty: 'easy',
      status: 'all',
      q: 'roof',
    });
    expect(screen.getByRole('combobox', { name: 'Question type' })).toHaveValue('matching');
    expect(screen.getByRole('searchbox', { name: 'Search questions' })).toHaveValue('roof');
  });

  it('opens the editor from a row', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('link', { name: /Question prompt 1/ }));
    expect(await screen.findByText('Editor page')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(`/content/questions/${ids.id(601)}`);
  });

  it('starts a new question in the chosen bank', async () => {
    renderPage(`/content/questions?bankId=${BANK_ID}`);
    await screen.findByRole('table');
    expect(screen.getByRole('link', { name: 'New question' })).toHaveAttribute(
      'href',
      `/content/questions/new?bankId=${BANK_ID}`,
    );
  });

  it('hides creation from people who cannot create', async () => {
    grant('assessments.view');
    renderPage();
    await screen.findByRole('table');
    expect(screen.queryByRole('link', { name: 'New question' })).not.toBeInTheDocument();
  });

  it('asks for a bank before the first question', async () => {
    banks = [];
    questions = [];
    renderPage();
    expect(await screen.findByText('Create a question bank first')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New question' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a question bank' })).toBeInTheDocument();
  });

  it('opens bank and category management', async () => {
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Banks and categories' }));
    const sheet = await screen.findByRole('dialog', { name: 'Banks and categories' });
    expect(await within(sheet).findByText('Storm damage')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Add category' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Move Storm damage down' })).toBeEnabled();
    expect(within(sheet).getByRole('button', { name: 'Move Storm damage up' })).toBeDisabled();
  });

  it('keeps management read-only without update rights', async () => {
    grant('assessments.view');
    renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Banks and categories' }));
    const sheet = await screen.findByRole('dialog', { name: 'Banks and categories' });
    await within(sheet).findByText('Storm damage');
    expect(within(sheet).queryByRole('button', { name: 'Add category' })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'New bank' })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
  });
});
