import type { RouteObject } from 'react-router';

/** Lazy route module: each screen ships as its own chunk. */
function page<T extends Record<string, unknown>>(
  loader: () => Promise<T>,
  name: keyof T,
): RouteObject['lazy'] {
  return async () => ({ Component: (await loader())[name] as React.ComponentType });
}

/**
 * Public certificate verification. It sits outside the authenticated layout (no sign-in, no
 * application shell) and is registered at the top level of the router.
 */
export const certificationPublicRoutes: RouteObject[] = [
  { path: '/verify/:token', lazy: page(() => import('./verify-page'), 'VerifyPage') },
];

/** Routes inside the signed-in application shell: trainee pages and the certification center. */
export const certificationRoutes: RouteObject[] = [
  {
    path: 'certifications',
    lazy: page(() => import('./my-certifications-page'), 'MyCertificationsPage'),
  },
  {
    path: 'certifications/:id',
    lazy: page(() => import('./my-certificate-page'), 'MyCertificatePage'),
  },
  {
    path: 'certification-center',
    lazy: page(() => import('./center/center-layout'), 'CertificationCenterLayout'),
    children: [
      { index: true, lazy: page(() => import('./center/overview-page'), 'CenterHomePage') },
      { path: 'team', lazy: page(() => import('./center/team-page'), 'TeamCertificationsPage') },
      {
        path: 'approvals',
        lazy: page(() => import('./center/approvals-page'), 'ApprovalsPage'),
      },
      { path: 'issued', lazy: page(() => import('./center/issued-page'), 'IssuedPage') },
      {
        path: 'issued/:id',
        lazy: page(() => import('./center/issued-detail-page'), 'IssuedDetailPage'),
      },
      { path: 'renewals', lazy: page(() => import('./center/renewals-page'), 'RenewalsPage') },
      {
        path: 'certifications',
        lazy: page(() => import('./center/certifications-page'), 'CertificationsPage'),
      },
      {
        path: 'certifications/:id',
        lazy: page(() => import('./center/certification-editor-page'), 'CertificationEditorPage'),
      },
      { path: 'templates', lazy: page(() => import('./center/templates-page'), 'TemplatesPage') },
      {
        path: 'templates/:id',
        lazy: page(() => import('./center/template-designer-page'), 'TemplateDesignerPage'),
      },
      {
        path: 'signatories',
        lazy: page(() => import('./center/signatories-page'), 'SignatoriesPage'),
      },
      { path: 'stamps', lazy: page(() => import('./center/stamps-page'), 'StampsPage') },
      { path: 'settings', lazy: page(() => import('./center/settings-page'), 'SettingsPage') },
    ],
  },
];
