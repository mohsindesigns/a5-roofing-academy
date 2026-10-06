import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { LoginPage } from '@/features/auth/login-page';
import { ForgotPasswordPage } from '@/features/auth/forgot-password-page';
import { SetPasswordPage } from '@/features/auth/set-password-page';
import { certificationPublicRoutes, certificationRoutes } from '@/features/certification/routes';
import { RedirectIfAuthenticated, RequireAuth } from './guards';
import { NotFoundPage, RouteError } from './route-error';
import { AppLayout } from './shell/app-layout';

/** Lazy route module helper: each feature ships as its own chunk. */
function page<T extends Record<string, unknown>>(
  loader: () => Promise<T>,
  name: keyof T,
): RouteObject['lazy'] {
  return async () => ({ Component: (await loader())[name] as React.ComponentType });
}

export const routes: RouteObject[] = [
  {
    errorElement: <RouteError />,
    children: [
      {
        path: '/login',
        element: (
          <RedirectIfAuthenticated>
            <LoginPage />
          </RedirectIfAuthenticated>
        ),
      },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
      { path: '/reset-password', element: <SetPasswordPage mode="reset" /> },
      ...certificationPublicRoutes,
      {
        path: '/activate',
        element: (
          <RedirectIfAuthenticated>
            <SetPasswordPage mode="activate" />
          </RedirectIfAuthenticated>
        ),
      },
      {
        element: <RequireAuth />,
        children: [
          {
            element: <AppLayout />,
            errorElement: <RouteError />,
            children: [
              { index: true, lazy: page(() => import('@/features/home/home-page'), 'HomePage') },
              ...certificationRoutes,
              {
                path: 'account',
                lazy: page(() => import('@/features/account/account-page'), 'AccountPage'),
              },
              {
                path: 'people',
                lazy: page(() => import('@/features/people/people-list-page'), 'PeopleListPage'),
              },
              {
                path: 'people/new',
                lazy: page(
                  () => import('@/features/people/person-create-page'),
                  'PersonCreatePage',
                ),
              },
              {
                path: 'people/:id',
                lazy: page(
                  () => import('@/features/people/person-detail-page'),
                  'PersonDetailPage',
                ),
              },
              {
                path: 'admin/roles',
                lazy: page(() => import('@/features/access/roles-page'), 'RolesPage'),
              },
              {
                path: 'admin/roles/:id',
                lazy: page(() => import('@/features/access/role-detail-page'), 'RoleDetailPage'),
              },
              {
                path: 'admin/permissions',
                lazy: page(
                  () => import('@/features/access/permission-matrix-page'),
                  'PermissionMatrixPage',
                ),
              },
              {
                path: 'admin/organization',
                lazy: page(
                  () => import('@/features/organization/organization-page'),
                  'OrganizationPage',
                ),
              },
              {
                path: 'admin/organization/teams/:id',
                lazy: page(() => import('@/features/organization/team-page'), 'TeamPage'),
              },
              {
                path: 'admin/settings',
                lazy: page(() => import('@/features/settings/settings-page'), 'SettingsPage'),
              },
              {
                path: 'team/approvals',
                element: <Navigate to="/certification-center/approvals" replace />,
              },
              {
                path: 'team',
                lazy: page(() => import('@/features/team/team-page'), 'TeamPage'),
              },
              {
                path: 'reports',
                lazy: page(() => import('@/features/reports/reports-page'), 'ReportsPage'),
              },
              {
                path: 'content/programs',
                lazy: page(
                  () => import('@/features/content/programs/programs-page'),
                  'ProgramsPage',
                ),
              },
              {
                path: 'content/programs/:id',
                lazy: page(
                  () => import('@/features/content/programs/program-builder-page'),
                  'ProgramBuilderPage',
                ),
              },
              {
                path: 'content/media',
                lazy: page(
                  () => import('@/features/content/media/media-library-page'),
                  'MediaLibraryPage',
                ),
              },
              {
                path: 'admin/audit',
                lazy: page(() => import('@/features/audit/audit-page'), 'AuditPage'),
              },
              {
                path: 'admin/notifications',
                lazy: page(
                  () => import('@/features/notification-admin/notifications-admin-page'),
                  'NotificationsAdminPage',
                ),
              },
              {
                path: 'admin/feature-flags',
                element: <Navigate to="/admin/settings?tab=features" replace />,
              },
              {
                path: 'training',
                lazy: page(() => import('@/features/learning/training-page'), 'TrainingPage'),
              },
              {
                path: 'training/:programId',
                lazy: page(() => import('@/features/learning/program-page'), 'ProgramPage'),
              },
              {
                path: 'training/:programId/lessons/:lessonId',
                lazy: page(() => import('@/features/learning/lesson-page'), 'LessonPage'),
              },
              {
                path: 'training/:programId/lessons/:lessonId/assessment',
                lazy: page(
                  () => import('@/features/assessments/learner/assessment-page'),
                  'AssessmentTakePage',
                ),
              },
              {
                path: 'content/assessments',
                lazy: page(
                  () => import('@/features/assessments/content/assessments-list-page'),
                  'AssessmentsListPage',
                ),
              },
              {
                path: 'content/assessments/attempts',
                lazy: page(
                  () => import('@/features/assessments/content/attempts-review-page'),
                  'AttemptsReviewPage',
                ),
              },
              {
                path: 'content/assessments/:id',
                lazy: page(
                  () => import('@/features/assessments/content/assessment-builder-page'),
                  'AssessmentBuilderPage',
                ),
              },
              {
                path: 'content/questions',
                lazy: page(
                  () => import('@/features/assessments/content/question-bank-page'),
                  'QuestionBankPage',
                ),
              },
              {
                path: 'content/questions/:id',
                lazy: page(
                  () => import('@/features/assessments/content/question-editor-page'),
                  'QuestionEditorPage',
                ),
              },
              {
                path: 'notifications',
                lazy: page(
                  () => import('@/features/notifications/notifications-page'),
                  'NotificationsPage',
                ),
              },
              {
                path: 'ai-coach',
                lazy: page(() => import('@/features/ai-coach/coach-page'), 'CoachPage'),
              },
              {
                path: 'ai-coach/sessions/:id',
                lazy: page(() => import('@/features/ai-coach/session-page'), 'SessionPage'),
              },
              {
                path: 'ai-coach/sessions/:id/scorecard',
                lazy: page(() => import('@/features/ai-coach/scorecard-page'), 'ScorecardPage'),
              },
              {
                path: 'content/ai-scenarios',
                lazy: page(
                  () => import('@/features/ai-scenarios/scenarios-page'),
                  'AiScenariosPage',
                ),
              },
              {
                path: 'content/ai-scenarios/new',
                lazy: page(
                  () => import('@/features/ai-scenarios/scenario-detail-page'),
                  'ScenarioCreatePage',
                ),
              },
              {
                path: 'content/ai-scenarios/rubrics/:id',
                lazy: page(() => import('@/features/ai-scenarios/rubric-page'), 'RubricPage'),
              },
              {
                path: 'content/ai-scenarios/:id',
                lazy: page(
                  () => import('@/features/ai-scenarios/scenario-detail-page'),
                  'ScenarioDetailPage',
                ),
              },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
