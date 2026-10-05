import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { learning } from '@a5/contracts';
import { json, mockApi, renderRoute } from '@/test/render';
import { AiSimulationLesson } from './lesson-practice';
import { session } from './test-fixtures';

afterEach(() => vi.restoreAllMocks());

const SCENARIO = '00000000-0000-4000-8000-0000000000a1';

function lesson(
  over: { bestScore?: number | null; grant?: boolean; scenarioId?: string | null } = {},
) {
  return {
    lesson: {
      config: {
        scenarioId: over.scenarioId === null ? undefined : (over.scenarioId ?? SCENARIO),
        minScore: 75,
      },
    },
    grant: over.grant === false ? null : { token: 'signed-grant-token-for-this-lesson' },
    progress: { bestScore: over.bestScore ?? null },
  } as unknown as learning.LessonDetail;
}

const brief = {
  id: SCENARIO,
  title: 'Three Estimates',
  category: 'Comparison',
  difficulty: 'intermediate',
  objection: 'x',
  persona: { name: 'Comparison shopper', description: 'Gets three quotes.' },
  passingScore: 75,
  maxTurns: 10,
  myStats: { attempts: 0, bestScore: null, passed: false, lastPracticedAt: null },
  repBrief: 'Early evening in Plano.',
  scoredOn: [],
};

function setup(detail: learning.LessonDetail, extra: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({ [`GET /ai/practice/scenarios/${SCENARIO}`]: () => brief, ...extra });
  renderRoute(<AiSimulationLesson detail={detail} />, { route: '/lesson', path: '/lesson' });
  return api;
}

describe('AI practice lesson', () => {
  it('shows the scenario and the score needed', async () => {
    setup(lesson());
    await screen.findByText('Early evening in Plano.');
    expect(screen.getByText('Three Estimates')).toBeInTheDocument();
    expect(screen.getByText(/or more to complete this lesson/)).toHaveTextContent(
      'Score 75 or more',
    );
    expect(screen.getByRole('button', { name: 'Start practice' })).toBeEnabled();
  });

  it('starts an assigned attempt with the lesson grant', async () => {
    const user = userEvent.setup();
    const started = session({ mode: 'assigned' });
    const api = setup(lesson(), { 'POST /ai/sessions': () => started });
    await user.click(await screen.findByRole('button', { name: 'Start practice' }));
    await screen.findByText(`Elsewhere: /ai-coach/sessions/${started.id}`);
    expect(api.callsTo('POST /ai/sessions')[0]!.body).toEqual({
      scenarioId: SCENARIO,
      lessonGrant: 'signed-grant-token-for-this-lesson',
      modality: 'text',
    });
  });

  it('shows the best score so far and offers another attempt', async () => {
    setup(lesson({ bestScore: 71 }));
    await screen.findByRole('button', { name: 'Practice again' });
    expect(screen.getByText(/Your best so far is/)).toHaveTextContent('71');
  });

  it('cannot start without a grant, and says when no scenario is set', async () => {
    setup(lesson({ grant: false }));
    expect(await screen.findByRole('button', { name: 'Start practice' })).toBeDisabled();
  });

  it('reports why a grant was refused', async () => {
    const user = userEvent.setup();
    setup(lesson(), {
      'POST /ai/sessions': () =>
        json(403, {
          error: {
            code: 'GRANT_INVALID',
            message:
              'This lesson link has expired. Reopen the lesson to start the practice session.',
          },
        }),
    });
    await user.click(await screen.findByRole('button', { name: 'Start practice' }));
    await screen.findByText(/lesson link has expired/);
  });

  it('explains a lesson without a scenario', async () => {
    setup(lesson({ scenarioId: null }));
    await screen.findByText(/No practice scenario has been chosen/);
  });
});
