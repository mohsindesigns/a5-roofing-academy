import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { renderWithDataRouter } from '../test-render';
import { BANK_ID, bankDetail, bankSummary, ids, questionDetail } from '../test-fixtures';
import { grant } from '../test-session';
import { QuestionEditorPage } from './question-editor-page';

vi.mock('@/lib/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/features/auth/session', () => import('../test-session'));

let detail = questionDetail();

const versionList = () => {
  const current = detail.currentVersion;
  return {
    items: [
      current,
      { ...current, id: ids.id(602), version: 2, changeNote: 'Added the adjuster', points: 1 },
      {
        ...current,
        id: ids.id(601),
        version: 1,
        changeNote: null,
        prompt: 'Who approves a photo report?',
        points: 1,
      },
    ],
  };
};

function mockApi() {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === `/questions/${detail.id}`) return detail;
    if (path === `/questions/${detail.id}/versions`) return versionList();
    if (path === `/questions/${detail.id}/preview`)
      return {
        versionId: detail.currentVersion.id,
        version: detail.currentVersion.version,
        manualReview: false,
        explanation: null,
        correctAnswer: { type: 'multiple_choice', optionId: 'oAAA' },
        question: {
          id: ids.id(1),
          position: 1,
          prompt: detail.currentVersion.prompt,
          points: 2,
          response: null,
          savedAt: null,
          type: 'multiple_choice',
          options: [
            { id: 'oCCC', text: 'The insurance adjuster' },
            { id: 'oAAA', text: 'The homeowner' },
          ],
        },
      };
    if (path === '/question-banks')
      return { items: [bankSummary()], page: 1, pageSize: 100, total: 1, pageCount: 1 };
    if (path.startsWith('/question-banks/')) return bankDetail();
    throw new ApiError(404, 'NOT_FOUND', `Unmocked GET ${path}`);
  });
}

function renderEditor(id: string, search = '') {
  return renderWithDataRouter(<QuestionEditorPage />, {
    route: `/content/questions/${id}${search}`,
    path: '/content/questions/:id',
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) vi.mocked(fn).mockReset();
  detail = questionDetail();
  mockApi();
  grant('assessments.view', 'assessments.create', 'assessments.update');
});

describe('QuestionEditorPage (existing question)', () => {
  it('describes the question and offers the four views', async () => {
    renderEditor(detail.id);
    expect(
      await screen.findByRole('heading', { name: detail.currentVersion.prompt }),
    ).toBeInTheDocument();
    expect(screen.getByText('Version 3')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Edit', 'Preview', 'Versions3', 'Usage1']);
  });

  it('keeps unsaved edits while looking at another tab', async () => {
    renderEditor(detail.id);
    const prompt = await screen.findByRole('textbox', { name: /Question text/ });
    await userEvent.type(prompt, ' Please answer.');
    await userEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(await screen.findByRole('region', { name: 'Learner view' })).toBeInTheDocument();
    // The editor stays mounted (so nothing is lost) but is hidden.
    const editPanel = screen
      .getByRole('textbox', { name: /Question text/, hidden: true })
      .closest('[role="tabpanel"]');
    expect(editPanel).toHaveAttribute('data-state', 'inactive');
    expect(editPanel).toHaveClass('data-[state=inactive]:hidden');
    await userEvent.click(screen.getByRole('tab', { name: 'Edit' }));
    expect(screen.getByRole('textbox', { name: /Question text/ })).toHaveValue(
      `${detail.currentVersion.prompt} Please answer.`,
    );
  });

  it('lets the author try the question the way a learner sees it', async () => {
    vi.mocked(api.post).mockResolvedValue({
      outcome: 'correct',
      awardedPoints: 2,
      points: 2,
      correctAnswer: { type: 'multiple_choice', optionId: 'oAAA' },
      explanation: 'A5 never shares photos without a yes.',
    });
    renderEditor(detail.id, '?tab=preview');
    const view = await screen.findByRole('region', { name: 'Learner view' });
    expect(within(view).getByRole('button', { name: 'Check my answer' })).toBeDisabled();
    await userEvent.click(within(view).getByRole('radio', { name: 'The homeowner' }));
    await userEvent.click(within(view).getByRole('button', { name: 'Check my answer' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`/questions/${detail.id}/preview/check`, {
        response: { type: 'multiple_choice', optionId: 'oAAA' },
        versionId: detail.currentVersion.id,
      }),
    );
    expect(await within(view).findByText('Correct')).toBeInTheDocument();
    expect(within(view).getByText('2 of 2 points')).toBeInTheDocument();
  });

  it('lists every version and starts an edit from an older one', async () => {
    renderEditor(detail.id, '?tab=versions');
    const versions = await screen.findByRole('list', { name: 'Versions' });
    const items = within(versions).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Version 3');
    expect(items[0]).toHaveTextContent('Current');
    expect(items[0]).toHaveTextContent('Tightened the wording');
    expect(items[0]).toHaveTextContent('Shelby Hartman');
    expect(
      within(items[0]!).queryByRole('button', { name: 'Start from this version' }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      within(items[2]!).getByRole('button', { name: 'Start from this version' }),
    );
    expect(await screen.findByText('Started from version 1')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Question text/ })).toHaveValue(
      'Who approves a photo report?',
    );
  });

  it('shows where the question is used', async () => {
    renderEditor(detail.id, '?tab=usage');
    expect(await screen.findByText(/given in 14 attempts/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Week 1 Knowledge Check' })).toHaveAttribute(
      'href',
      `/content/assessments/${ids.id(800)}`,
    );
  });

  it('archives after confirmation and shows the server reason when it is refused', async () => {
    vi.mocked(api.post).mockRejectedValue(
      new ApiError(
        409,
        'QUESTION_IN_USE',
        'Published assessments include this question: Week 1 Knowledge Check. Remove it from them before archiving.',
      ),
    );
    renderEditor(detail.id);
    await userEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Published assessments that include it must drop it first.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(
      await within(dialog).findByText(/Remove it from them before archiving/),
    ).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith(`/questions/${detail.id}/archive`);
  });

  it('shows an archived question as read-only with a way back', async () => {
    detail = questionDetail({ status: 'archived' });
    renderEditor(detail.id);
    expect(await screen.findByText('This question is archived')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Question text/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('is read-only without update rights, and offers no archive', async () => {
    grant('assessments.view');
    renderEditor(detail.id);
    expect(
      await screen.findByText('You can view this question but not edit it'),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Question text/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('explains a question that is gone', async () => {
    vi.mocked(api.get).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Question not found.'));
    renderEditor(ids.id(999));
    expect(
      await screen.findByText(
        'This question no longer exists, or you no longer have access to it.',
      ),
    ).toBeInTheDocument();
  });
});

describe('QuestionEditorPage (new question)', () => {
  it('starts in the chosen bank and type', async () => {
    renderEditor('new', `?bankId=${BANK_ID}&type=ordering`);
    expect(await screen.findByRole('heading', { name: 'New question' })).toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: 'Question type' })).toHaveValue('ordering');
    expect(screen.getByRole('combobox', { name: /Question bank/ })).toHaveValue(BANK_ID);
    expect(screen.getByRole('button', { name: 'Create question' })).toBeInTheDocument();
  });

  it('asks for a bank first when none exists', async () => {
    vi.mocked(api.get).mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 100,
      total: 0,
      pageCount: 1,
    });
    renderEditor('new');
    expect(await screen.findByText('Create a question bank first')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create question' })).not.toBeInTheDocument();
  });

  it('does not let a viewer create questions', async () => {
    grant('assessments.view');
    renderEditor('new');
    expect(await screen.findByText("You can't add questions")).toBeInTheDocument();
  });
});
