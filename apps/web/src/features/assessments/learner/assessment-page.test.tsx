import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import type { learning } from '@a5/contracts';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { renderWithProviders } from '../test-render';
import { attemptResult, ids, intro, learnerAttempt } from '../test-fixtures';
import { AssessmentTakePage } from './assessment-page';

vi.mock('@/lib/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const PROGRAM = ids.id(10);
const LESSON = ids.id(20);
const ASSESSMENT = ids.id(800);
const BASE = `/training/${PROGRAM}/lessons/${LESSON}/assessment`;

function lessonDetail(over: Partial<learning.LessonDetail> = {}): learning.LessonDetail {
  return {
    enrollmentId: ids.id(30),
    program: { id: PROGRAM, title: 'A5 New Hire Sales Academy' },
    phase: { id: ids.id(11), label: 'Week', title: 'Foundations', position: 1 },
    module: { id: ids.id(12), title: 'Customer trust' },
    lesson: {
      id: LESSON,
      type: 'quiz',
      title: 'Week 1 Knowledge Check',
      summary: null,
      body: null,
      config: { assessmentId: ASSESSMENT },
      isRequired: true,
      estimatedMinutes: 20,
      resources: [],
    },
    state: 'available',
    requirements: [],
    completion: { mode: 'assessment', canCompleteManually: false, hint: '' },
    progress: { status: 'in_progress' },
    grant: {
      token: 'grant-token-grant-token-0001',
      expiresAt: '2026-10-05T16:00:00.000Z',
      resource: { type: 'assessment', id: ASSESSMENT },
      policy: {},
    },
    notes: [],
    approval: null,
    submission: null,
    acknowledgment: null,
    previousLessonId: null,
    nextLessonId: ids.id(21),
    ...over,
  } as unknown as learning.LessonDetail;
}

interface Mocks {
  lesson?: learning.LessonDetail;
  intro?: ReturnType<typeof intro>;
  attempt?: ReturnType<typeof learnerAttempt> | ApiError;
  result?: ReturnType<typeof attemptResult>;
}

function mockApi(m: Mocks = {}) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith('/learning/me/lessons/')) return m.lesson ?? lessonDetail();
    if (path.endsWith('/intro')) return m.intro ?? intro();
    if (/^\/attempts\/[^/]+\/result$/.test(path)) return m.result ?? attemptResult();
    if (/^\/attempts\/[^/]+$/.test(path)) {
      if (m.attempt instanceof ApiError) throw m.attempt;
      return m.attempt ?? learnerAttempt();
    }
    throw new Error(`Unmocked GET ${path}`);
  });
}

function renderPage(search = '') {
  return renderWithProviders(
    <Routes>
      <Route
        path="/training/:programId/lessons/:lessonId/assessment"
        element={<AssessmentTakePage />}
      />
    </Routes>,
    { route: `${BASE}${search}` },
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) vi.mocked(fn).mockReset();
});

describe('AssessmentTakePage', () => {
  it('opens the assessment from the lesson grant and shows the intro', async () => {
    mockApi();
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Week 1 Knowledge Check' }),
    ).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(
      `/assessments/${ASSESSMENT}/intro`,
      { grant: 'grant-token-grant-token-0001' },
      expect.anything(),
    );
    expect(screen.getByRole('link', { name: 'A5 New Hire Sales Academy' })).toHaveAttribute(
      'href',
      `/training/${PROGRAM}`,
    );
  });

  it('starts an attempt with the grant and shows the first question', async () => {
    mockApi();
    vi.mocked(api.post).mockResolvedValue(learnerAttempt());
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Start attempt' }));
    expect(api.post).toHaveBeenCalledWith('/attempts', { grant: 'grant-token-grant-token-0001' });
    expect(await screen.findByRole('heading', { name: 'Question 1 of 8' })).toBeInTheDocument();
  });

  it('shows the server message when an attempt cannot be started', async () => {
    mockApi();
    vi.mocked(api.post).mockRejectedValue(
      new ApiError(422, 'COOLDOWN_ACTIVE', 'You can start another attempt in 6 minutes.'),
    );
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Start attempt' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You can start another attempt in 6 minutes.',
    );
  });

  it('resumes an attempt that is still open when its link is opened', async () => {
    mockApi({ attempt: learnerAttempt({ resumed: true }) });
    renderPage(`?attempt=${ids.id(900)}`);
    expect(await screen.findByRole('heading', { name: 'Question 1 of 8' })).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('shows the result of a finished attempt', async () => {
    mockApi({ attempt: learnerAttempt({ status: 'graded' }), result: attemptResult() });
    renderPage(`?attempt=${ids.id(900)}`);
    expect(await screen.findByRole('heading', { name: 'Your result' })).toBeInTheDocument();
    expect(screen.getByText('62.5%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('starts a new attempt from the result page using a fresh grant', async () => {
    mockApi({
      attempt: learnerAttempt({ status: 'graded' }),
      result: attemptResult({ retakeAvailableAt: new Date(Date.now() - 1000).toISOString() }),
    });
    vi.mocked(api.post).mockResolvedValue(learnerAttempt({ id: ids.id(901), attemptNumber: 2 }));
    renderPage(`?attempt=${ids.id(900)}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/attempts', { grant: 'grant-token-grant-token-0001' }),
    );
  });

  it('says so when the attempt belongs to someone else', async () => {
    mockApi({ attempt: new ApiError(404, 'NOT_FOUND', 'Attempt not found.') });
    renderPage(`?attempt=${ids.id(999)}`);
    expect(await screen.findByText('This attempt is not available')).toBeInTheDocument();
  });

  it('explains a locked assessment with what is needed to unlock it', async () => {
    mockApi({
      lesson: lessonDetail({
        state: 'locked',
        grant: null,
        requirements: [
          { description: 'Complete Week 1 lessons', satisfied: false, progress: null },
        ] as unknown as learning.Requirement[],
      }),
    });
    renderPage();
    expect(await screen.findByText('This assessment is locked')).toBeInTheDocument();
    expect(screen.getByText('Complete Week 1 lessons')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start/ })).not.toBeInTheDocument();
  });

  it('does not offer an attempt for lessons that are not assessments', async () => {
    mockApi({ lesson: lessonDetail({ lesson: { ...lessonDetail().lesson, type: 'article' } }) });
    renderPage();
    expect(await screen.findByText('This lesson does not have an assessment')).toBeInTheDocument();
  });

  it('explains when the lesson has no usable grant', async () => {
    mockApi({ lesson: lessonDetail({ grant: null }) });
    renderPage();
    expect(await screen.findByText('This assessment is not available yet')).toBeInTheDocument();
  });

  it('offers to refresh an expired lesson link', async () => {
    mockApi();
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.startsWith('/learning/me/lessons/')) return lessonDetail();
      if (path.endsWith('/intro'))
        throw new ApiError(
          403,
          'GRANT_EXPIRED',
          'This lesson link has expired. Reopen the lesson from your training plan and try again.',
        );
      throw new Error(`Unmocked GET ${path}`);
    });
    renderPage();
    expect(await screen.findByText('This lesson link needs refreshing')).toBeInTheDocument();
    expect(screen.getByText(/has expired/)).toBeInTheDocument();
  });
});
