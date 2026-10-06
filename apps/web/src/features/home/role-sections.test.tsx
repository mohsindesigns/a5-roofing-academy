import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataScope, PermissionKey } from '@a5/permissions';
import { sessionKeys } from '@/features/auth/session';
import { useAuth } from '@/lib/auth-store';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ api: { get } }));

import { RoleDashboards } from './role-sections';

const ratio = (n: number, d: number) => ({
  numerator: n,
  denominator: d,
  percent: d ? Math.round((n / d) * 1000) / 10 : null,
});
const kpis = {
  headcount: 16,
  activeTrainees: 13,
  enrollments: 16,
  programCompletion: ratio(3, 16),
  averageProgressPercent: 40,
  averageAssessmentScore: 85,
  assessmentAttempts: 7,
  aiRolePlayAverage: 82,
  aiSessions: 6,
  fieldReadyCount: 3,
  certifiedCount: 3,
};
const trend = {
  interval: 'week',
  from: '2026-07-13',
  to: '2026-10-05',
  points: [{ date: '2026-09-28', value: 4, count: 4 }],
};
const meta = {
  generatedAt: '2026-10-05T16:00:00.000Z',
  scope: 'managed',
  filters: {},
  timezone: 'America/Chicago',
};

const team = {
  meta,
  kpis,
  fallingBehind: {
    total: 1,
    items: [
      {
        person: { id: 'u1', displayName: 'Tyler Brennan', teamNames: [] },
        enrollmentId: 'e1',
        programId: 'p1',
        programTitle: 'A5 New Hire Sales Academy',
        progressPercent: 32,
        expectedPercent: 100,
        enrolledAt: '2026-09-01T00:00:00.000Z',
        dueAt: '2026-09-28T00:00:00.000Z',
        lastActivityAt: '2026-09-24T00:00:00.000Z',
        daysInactive: 11,
        reasons: ['overdue', 'inactive'],
      },
    ],
  },
  requiringAttention: { total: 0, items: [] },
  expiringCertifications: { within30Days: 0, within60Days: 0, within90Days: 0, items: [] },
  recentActivity: [],
  weakestAreas: { aiCategories: [], questionCategories: [] },
  activityTrend: { lessonsCompleted: trend, aiAverageScore: trend },
};
const company = {
  meta: { ...meta, scope: 'organization' },
  kpis: {
    ...kpis,
    trainingCompletionRate: ratio(3, 9),
    averageCompletionDays: 31.6,
    overdueEnrollments: 6,
    quizFailureRate: ratio(1, 7),
    certificationConversion: ratio(3, 16),
    averageDaysToCertification: 30,
    medianDaysToCertification: 29,
  },
  breakdowns: { byLocation: [], byTeam: [] },
  dropOffLessons: [],
  hardestQuestions: [],
  mostFailedObjections: [],
  weakestAreas: { aiCategories: [], questionCategories: [] },
  aiScoreTrend: trend,
  aiCompetencyTrend: { interval: 'week', from: '2026-07-13', to: '2026-10-05', series: [] },
  completionTrend: { lessonsCompleted: trend, programsCompleted: trend },
  assessmentTrend: { averageScore: trend, failureRate: trend },
};

function renderHome(scope: DataScope | null, permissions: PermissionKey[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const map: Record<string, string> = {};
  if (scope) map['analytics.view'] = scope;
  for (const p of permissions) map[p] = scope ?? 'own';
  client.setQueryData(sessionKeys.me, {
    user: { id: 'me' },
    permissions: map,
    featureFlags: {},
    managedTeamIds: [],
  });
  useAuth.setState({ status: 'authenticated', accessToken: 't', expiresAt: Date.now() + 600_000 });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RoleDashboards />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // jsdom has no layout engine; the line chart measures itself with a ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  get.mockReset();
  get.mockImplementation(async (path: string) => {
    if (path === '/analytics/dashboards/team') return team;
    if (path === '/analytics/dashboards/company') return company;
    return { items: [], page: 1, pageSize: 100, total: 0, pageCount: 1 };
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Home role dashboards', () => {
  it('shows nothing to people without analytics access (the trainee view is untouched)', () => {
    const { container } = renderHome(null, ['training.participate']);
    expect(container).toBeEmptyDOMElement();
    expect(get).not.toHaveBeenCalled();
  });

  it('gives managers the team view from the team dashboard only', async () => {
    renderHome('managed', ['analytics.view', 'enrollments.view']);
    expect(await screen.findByRole('heading', { name: 'Your team' })).toBeInTheDocument();
    expect(await screen.findByText('Tyler Brennan')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Inactive 11 days')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(
      '/analytics/dashboards/team',
      expect.anything(),
      expect.anything(),
    );
    expect(get).not.toHaveBeenCalledWith(
      '/analytics/dashboards/company',
      expect.anything(),
      expect.anything(),
    );
  });

  it('gives organization-wide roles the company dashboard', async () => {
    renderHome('organization', ['analytics.view']);
    expect(await screen.findByRole('heading', { name: 'Organization' })).toBeInTheDocument();
    expect(await screen.findByText('Training completion')).toBeInTheDocument();
    expect(screen.getByText('33.3%')).toBeInTheDocument();
    expect(screen.getByText('31.6 days')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(
      '/analytics/dashboards/company',
      expect.anything(),
      expect.anything(),
    );
  });

  it('keeps a failing section local and offers a retry', async () => {
    get.mockRejectedValue(new Error('The server could not complete the request.'));
    renderHome('managed', ['analytics.view']);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The server could not complete the request.');
    expect(screen.getByRole('heading', { name: 'Your team' })).toBeInTheDocument();
  });
});
