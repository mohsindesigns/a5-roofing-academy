import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assessment } from '@a5/contracts';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { renderWithDataRouter } from '../test-render';
import { BANK_ID, CATEGORY_ID, bankDetail, bankSummary, questionDetail } from '../test-fixtures';
import { emptyForm, fromVersion } from './question-form-model';
import { QuestionForm } from './question-form';

vi.mock('@/lib/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

function mockReads() {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/question-banks')
      return { items: [bankSummary()], page: 1, pageSize: 100, total: 1, pageCount: 1 };
    if (path.startsWith('/question-banks/')) return bankDetail();
    throw new Error(`Unmocked GET ${path}`);
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) vi.mocked(fn).mockReset();
  mockReads();
});

const noop = () => undefined;

function renderCreate(
  type: assessment.QuestionType = 'multiple_choice',
  onCreated: (id: string) => void = noop,
) {
  return renderWithDataRouter(
    <QuestionForm
      initial={emptyForm(type, BANK_ID)}
      readOnly={false}
      onCreated={onCreated}
      onReloadLatest={noop}
    />,
  );
}

describe('creating a question', () => {
  it('explains what is missing next to the fields and does not call the API', async () => {
    renderCreate();
    await userEvent.click(screen.getByRole('button', { name: 'Create question' }));
    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(screen.getByText('Mark exactly one option as correct')).toBeInTheDocument();
    expect(screen.getAllByText('Fill this in or remove the row').length).toBeGreaterThan(0);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('creates a multiple choice question with random option ids and the chosen answer', async () => {
    vi.mocked(api.post).mockResolvedValue(
      questionDetail({ id: '00000000-0000-4000-8000-0000000000ff' }),
    );
    const onCreated = vi.fn();
    renderCreate('multiple_choice', onCreated);
    await userEvent.type(
      screen.getByRole('textbox', { name: /Question text/ }),
      'What is the first photo in a report?',
    );
    for (const [i, text] of ['The address', 'The sky', 'The truck', 'The crew'].entries()) {
      await userEvent.type(screen.getByRole('textbox', { name: `Option ${i + 1} text` }), text);
    }
    await userEvent.click(screen.getByRole('radio', { name: 'Option 1 is the correct answer' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create question' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const [path, body] = vi.mocked(api.post).mock.calls[0]! as [
      string,
      {
        bankId: string;
        config: { options: Array<{ id: string; text: string; correct: boolean }> };
      },
    ];
    expect(path).toBe('/questions');
    expect(body).toMatchObject({
      bankId: BANK_ID,
      type: 'multiple_choice',
      prompt: 'What is the first photo in a report?',
      points: 1,
      difficulty: 'medium',
    });
    expect(body.config.options.map((o) => o.text)).toEqual([
      'The address',
      'The sky',
      'The truck',
      'The crew',
    ]);
    expect(body.config.options.map((o) => o.correct)).toEqual([true, false, false, false]);
    for (const o of body.config.options) expect(o.id).toMatch(/^o[a-z0-9]{10}$/);
    expect(assessment.createQuestionRequestSchema.safeParse(body).success).toBe(true);
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith('00000000-0000-4000-8000-0000000000ff'),
    );
  });

  it('shows the server message when a field is refused', async () => {
    vi.mocked(api.post).mockRejectedValue(
      new ApiError(400, 'VALIDATION_FAILED', 'Some fields need attention.', [
        { path: 'prompt', message: 'Another question already uses this wording' },
      ]),
    );
    renderCreate('true_false');
    await userEvent.type(
      screen.getByRole('textbox', { name: /Question text/ }),
      'Insurance always covers the deductible.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create question' }));
    expect(await screen.findByText('Some fields need attention.')).toBeInTheDocument();
    expect(screen.getByText('Another question already uses this wording')).toBeInTheDocument();
  });

  it.each([
    ['multiple_choice', /Answer options/],
    ['multiple_select', /mark every correct answer/],
    ['true_false', /Correct answer/],
    ['short_answer', /Accepted answers/],
    ['long_answer', /Scoring rubric/],
    ['scenario', /What the learner does/],
    ['ordering', /Items in the correct order/],
    ['matching', /Matching pairs/],
  ] as const)('shows the %s editor when that type is chosen', async (type, heading) => {
    renderCreate('multiple_choice');
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Question type' }),
      assessment.QUESTION_TYPE_LABELS[type],
    );
    expect(screen.getAllByText(heading).length).toBeGreaterThan(0);
  });

  it('lets an author build an ordering question with moves and removals', async () => {
    renderCreate('ordering');
    const first = screen.getByRole('textbox', { name: 'Item 1 text' });
    await userEvent.type(first, 'Inspect');
    await userEvent.type(screen.getByRole('textbox', { name: 'Item 2 text' }), 'Estimate');
    await userEvent.type(screen.getByRole('textbox', { name: 'Item 3 text' }), 'Install');
    await userEvent.click(screen.getByRole('button', { name: 'Move item 3 up' }));
    expect((screen.getByRole('textbox', { name: 'Item 2 text' }) as HTMLInputElement).value).toBe(
      'Install',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove item 3' }));
    expect(screen.queryByRole('textbox', { name: 'Item 3 text' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove item 1' })).toBeDisabled();
  });

  it('keeps at least two options and at most the maximum', async () => {
    renderCreate('multiple_choice');
    await userEvent.click(screen.getByRole('button', { name: 'Remove option 4' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove option 3' }));
    expect(screen.getByRole('button', { name: 'Remove option 1' })).toBeDisabled();
    for (let i = 0; i < 8; i += 1)
      await userEvent.click(screen.getByRole('button', { name: 'Add option' }));
    expect(screen.getByRole('button', { name: 'Add option' })).toBeDisabled();
    expect(screen.getAllByRole('textbox', { name: /^Option \d+ text$/ })).toHaveLength(10);
  });

  it('offers the bank categories and competencies of the chosen bank', async () => {
    renderCreate();
    const category = await screen.findByRole('combobox', { name: /^Category/ });
    await waitFor(() =>
      expect(within(category).getByRole('option', { name: 'Storm damage' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('combobox', { name: /Competencies/ })).toBeInTheDocument();
  });
});

describe('editing a question', () => {
  const detail = questionDetail();
  const initial = () => fromVersion(detail.currentVersion, detail.bank.id);
  const renderEdit = (props: Partial<Parameters<typeof QuestionForm>[0]> = {}) =>
    renderWithDataRouter(
      <QuestionForm
        initial={initial()}
        question={detail}
        readOnly={false}
        onCreated={noop}
        onReloadLatest={noop}
        {...props}
      />,
    );

  it('shows the saved category once the bank categories have loaded', async () => {
    renderEdit();
    const category = await screen.findByRole('combobox', { name: /^Category/ });
    await waitFor(() => expect(category).toHaveValue(CATEGORY_ID));
  });

  it('shows the saved content and offers no save until something changes', () => {
    renderEdit();
    expect(
      (screen.getByRole('textbox', { name: /Question text/ }) as HTMLTextAreaElement).value,
    ).toBe(detail.currentVersion.prompt);
    expect(screen.getByRole('radio', { name: 'Option 1 is the correct answer' })).toBeChecked();
    expect(screen.queryByRole('button', { name: /Save as version/ })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Multiple choice')).toBeDisabled();
  });

  it('saves a new version with the version it started from and a change note', async () => {
    vi.mocked(api.put).mockResolvedValue(
      questionDetail({
        currentVersion: {
          ...detail.currentVersion,
          version: 4,
          id: '00000000-0000-4000-8000-000000000604',
          prompt: 'Who must say yes before photos are shared?',
        },
      }),
    );
    renderEdit();
    const prompt = screen.getByRole('textbox', { name: /Question text/ });
    await userEvent.clear(prompt);
    await userEvent.type(prompt, 'Who must say yes before photos are shared?');
    await userEvent.type(screen.getByRole('textbox', { name: /What changed/ }), 'Plainer wording');
    await userEvent.click(screen.getByRole('button', { name: 'Save as version 4' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [path, body] = vi.mocked(api.put).mock.calls[0]! as [string, Record<string, unknown>];
    expect(path).toBe(`/questions/${detail.id}`);
    expect(body).toMatchObject({
      prompt: 'Who must say yes before photos are shared?',
      changeNote: 'Plainer wording',
      expectedVersion: 3,
      type: 'multiple_choice',
    });
    expect((body.config as { options: Array<{ id: string }> }).options.map((o) => o.id)).toEqual([
      'oAAA',
      'oBBB',
      'oCCC',
    ]);
    expect(assessment.updateQuestionRequestSchema.safeParse(body).success).toBe(true);
  });

  it('tells the author when someone else saved first, and lets them load the latest', async () => {
    vi.mocked(api.put).mockRejectedValue(
      new ApiError(
        409,
        'QUESTION_CHANGED',
        'Someone saved version 4 of this question while you were editing version 3. Reload it and apply your changes again.',
      ),
    );
    const onReloadLatest = vi.fn();
    renderEdit({ onReloadLatest });
    await userEvent.type(screen.getByRole('textbox', { name: /Question text/ }), '?');
    await userEvent.click(screen.getByRole('button', { name: 'Save as version 4' }));
    expect(await screen.findByText('Someone else saved this question')).toBeInTheDocument();
    expect(screen.getByText(/while you were editing version 3/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load the latest version' }));
    expect(onReloadLatest).toHaveBeenCalled();
  });

  it('says so when a save changes nothing', async () => {
    vi.mocked(api.put).mockResolvedValue(detail);
    renderEdit();
    await userEvent.type(screen.getByRole('textbox', { name: /What changed/ }), 'Only a note');
    await userEvent.click(screen.getByRole('button', { name: 'Save as version 4' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Save as version/ })).not.toBeInTheDocument(),
    );
  });

  it('is read-only for an archived question', () => {
    renderEdit({ readOnly: true, question: questionDetail({ status: 'archived' }) });
    expect(screen.getByText('This question is archived')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Question text/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Option 1 is the correct answer' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Save as version/ })).not.toBeInTheDocument();
  });

  it('notes when the form was started from an older version', () => {
    renderEdit({ seededFrom: 1 });
    expect(screen.getByText('Started from version 1')).toBeInTheDocument();
  });

  it('asks before leaving with unsaved changes', async () => {
    const { router } = renderEdit();
    await userEvent.type(screen.getByRole('textbox', { name: /Question text/ }), ' more');
    void router.navigate('/elsewhere');
    expect(await screen.findByText('Leave without saving?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(router.state.location.pathname).toBe('/');
    void router.navigate('/elsewhere');
    await userEvent.click(await screen.findByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere'));
  });
});
