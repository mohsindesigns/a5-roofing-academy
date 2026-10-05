import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import type { assessment } from '@a5/contracts';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { renderWithProviders } from '../test-render';
import { assessmentDetail, ids } from '../test-fixtures';
import { grant } from '../test-session';
import { AssessmentBuilderPage } from './assessment-builder-page';

vi.mock('@/lib/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/features/auth/session', () => import('../test-session'));

const valid: assessment.AssessmentValidation = {
  valid: true,
  questionCount: 4,
  issues: [],
  pools: [],
};

let detail = assessmentDetail();
let validation: assessment.AssessmentValidation = valid;

function mockApi() {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === `/assessments/${detail.id}`) return detail;
    if (path.endsWith('/validation')) return validation;
    if (path.endsWith('/stats'))
      return {
        assessmentId: detail.id,
        attempts: { total: 0, inProgress: 0, pendingReview: 0, graded: 0, autoSubmitted: 0 },
        learners: 0,
      };
    if (path === '/question-banks')
      return { items: [], page: 1, pageSize: 100, total: 0, pageCount: 1 };
    throw new Error(`Unmocked GET ${path}`);
  });
}

function renderPage(search = '') {
  return renderWithProviders(
    <Routes>
      <Route path="/content/assessments/:id" element={<AssessmentBuilderPage />} />
      <Route path="/content/assessments" element={<p>List page</p>} />
    </Routes>,
    { route: `/content/assessments/${detail.id}${search}` },
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) vi.mocked(fn).mockReset();
  detail = assessmentDetail();
  validation = valid;
  mockApi();
  grant('assessments.view', 'assessments.create', 'assessments.update', 'assessment_attempts.view');
});

describe('AssessmentBuilderPage', () => {
  it('shows the assessment, its status and its items in order', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Week 1 Knowledge Check' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    const items = within(screen.getByRole('list', { name: 'Assessment items' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Who must give permission before a photo report is shared?');
    expect(items[0]).toHaveTextContent('Multiple choice · Medium · Storm damage');
    expect(items[1]).toHaveTextContent('Draw 3 at random from A5 Sales Core');
    expect(items[1]).toHaveTextContent('4 active questions match.');
  });

  it('warns when a random draw cannot be filled', async () => {
    detail = assessmentDetail({
      items: [
        {
          ...(assessmentDetail().items[1] as Extract<assessment.AssessmentItem, { kind: 'pool' }>),
          count: 6,
          available: 4,
        },
      ],
      itemCount: 1,
    });
    renderPage();
    expect(
      await screen.findByText(/Only 4 active questions match, so this rule cannot fill 6/),
    ).toBeInTheDocument();
  });

  it('moves an item and saves the new order for every item', async () => {
    vi.mocked(api.put).mockResolvedValue(detail);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Move this random draw up' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [path, body] = vi.mocked(api.put).mock.calls[0]! as [
      string,
      { items: Array<{ id: string; position: number }> },
    ];
    expect(path).toBe(`/assessments/${detail.id}/items`);
    expect(body.items.map((i) => [i.id, i.position])).toEqual([
      [ids.id(902), 1],
      [ids.id(901), 2],
    ]);
  });

  it('removes an item after confirmation', async () => {
    vi.mocked(api.delete).mockResolvedValue(detail);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove this question' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('The question stays in the bank.');
    expect(api.delete).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith(`/assessments/${detail.id}/items/${ids.id(901)}`),
    );
  });

  describe('publishing', () => {
    it('publishes a draft after confirmation', async () => {
      vi.mocked(api.post).mockResolvedValue(assessmentDetail({ status: 'published' }));
      renderPage();
      await userEvent.click(await screen.findByRole('button', { name: 'Publish' }));
      const dialog = await screen.findByRole('alertdialog');
      expect(dialog).toHaveTextContent(
        'Learners whose lesson links to Week 1 Knowledge Check can start attempts right away',
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith(`/assessments/${detail.id}/publish`),
      );
    });

    it('blocks publishing and lists what is wrong while the assessment is incomplete', async () => {
      validation = {
        valid: false,
        questionCount: 2,
        issues: [
          {
            code: 'POOL_SHORT',
            message: 'The random draw at position 2 needs 6 questions but only 4 match.',
            itemId: ids.id(902),
            position: 2,
          },
        ],
        pools: [],
      };
      renderPage();
      expect(await screen.findByText('Fix these before you can publish')).toBeInTheDocument();
      expect(screen.getByText(/needs 6 questions but only 4 match/)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled());
    });

    it('shows the server reason when publishing is refused', async () => {
      vi.mocked(api.post).mockRejectedValue(
        new ApiError(
          422,
          'ASSESSMENT_INCOMPLETE',
          'This assessment cannot be published yet. Add at least one question.',
        ),
      );
      renderPage();
      await userEvent.click(await screen.findByRole('button', { name: 'Publish' }));
      await userEvent.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Publish' }),
      );
      expect(
        await screen.findByText(
          'This assessment cannot be published yet. Add at least one question.',
        ),
      ).toBeInTheDocument();
    });

    it('offers archive instead of publish for a published assessment', async () => {
      detail = assessmentDetail({ status: 'published', attemptCount: 3 });
      renderPage();
      await screen.findByRole('heading', { name: 'Week 1 Knowledge Check' });
      expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
      expect(
        screen.getByText(
          /This assessment is published\. Changes apply to attempts that start after you save/,
        ),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
      expect(await screen.findByRole('menuitem', { name: 'Archive' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Delete draft' })).not.toBeInTheDocument();
    });

    it('only lets a draft with no attempts be deleted', async () => {
      renderPage();
      await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
      expect(await screen.findByRole('menuitem', { name: 'Delete draft' })).toBeInTheDocument();
    });
  });

  it('lets an archived assessment be published again but not edited', async () => {
    detail = assessmentDetail({ status: 'archived' });
    renderPage();
    expect(await screen.findByRole('button', { name: 'Publish again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add questions' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Move this random draw up' }),
    ).not.toBeInTheDocument();
  });

  describe('without edit rights', () => {
    beforeEach(() => grant('assessments.view'));

    it('shows the assessment read-only', async () => {
      renderPage();
      await screen.findByRole('heading', { name: 'Week 1 Knowledge Check' });
      expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add questions' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
    });

    it('disables every setting', async () => {
      renderPage('?tab=settings');
      expect(await screen.findByRole('textbox', { name: /Title/ })).toBeDisabled();
      expect(screen.getByRole('spinbutton', { name: /Pass mark/ })).toBeDisabled();
    });
  });

  describe('settings', () => {
    it('shows the configuration and saves a changed pass mark', async () => {
      vi.mocked(api.patch).mockResolvedValue(
        assessmentDetail({ config: { ...detail.config, passingPercent: 75 }, passingPercent: 75 }),
      );
      renderPage('?tab=settings');
      const passMark = await screen.findByRole('spinbutton', { name: /Pass mark/ });
      expect(passMark).toHaveValue(80);
      expect(screen.getByRole('spinbutton', { name: /Minutes allowed/ })).toHaveValue(20);
      expect(screen.getByRole('spinbutton', { name: /Attempts allowed/ })).toHaveValue(3);
      await userEvent.clear(passMark);
      await userEvent.type(passMark, '75');
      await userEvent.click(await screen.findByRole('button', { name: 'Save settings' }));
      await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
      const [path, body] = vi.mocked(api.patch).mock.calls[0]! as [
        string,
        { config: Record<string, unknown> },
      ];
      expect(path).toBe(`/assessments/${detail.id}`);
      expect(body.config).toMatchObject({
        passingPercent: 75,
        maxAttempts: 3,
        timeLimitSeconds: 1200,
        retryCooldownMinutes: 10,
      });
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument(),
      );
    });

    it('rejects a pass mark above 100 next to the field', async () => {
      renderPage('?tab=settings');
      const passMark = await screen.findByRole('spinbutton', { name: /Pass mark/ });
      await userEvent.clear(passMark);
      await userEvent.type(passMark, '120');
      await userEvent.click(await screen.findByRole('button', { name: 'Save settings' }));
      expect(await screen.findByText('Enter a pass mark between 0 and 100')).toBeInTheDocument();
      expect(api.patch).not.toHaveBeenCalled();
    });

    it('hides the attempt count and time field when those limits are off', async () => {
      detail = assessmentDetail({
        config: { ...assessmentDetail().config, maxAttempts: null, timeLimitSeconds: null },
      });
      renderPage('?tab=settings');
      await screen.findByRole('spinbutton', { name: /Pass mark/ });
      expect(
        screen.queryByRole('spinbutton', { name: /Attempts allowed/ }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('spinbutton', { name: /Minutes allowed/ })).not.toBeInTheDocument();
    });

    it('warns that answers will never be revealed when the policy needs a last attempt but attempts are unlimited', async () => {
      detail = assessmentDetail({
        config: {
          ...assessmentDetail().config,
          maxAttempts: null,
          revealCorrectAnswers: 'after_final_attempt',
        },
      });
      renderPage('?tab=settings');
      expect(
        await screen.findByText(
          /Attempts are unlimited, so learners will never reach their last attempt/,
        ),
      ).toBeInTheDocument();
    });
  });
});
