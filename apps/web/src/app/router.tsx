import { createBrowserRouter, type RouteObject } from 'react-router';
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
                path: 'notifications',
                lazy: page(
                  () => import('@/features/notifications/notifications-page'),
                  'NotificationsPage',
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
