import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { CertificationEditorPage } from './certification-editor-page';
import { CertificationCenterLayout } from './center-layout';
import { IssuedPage } from './issued-page';
import { TeamCertificationsPage } from './team-page';
import { json, mockApi, renderApp } from '../test-utils';

const DEF = '0190aaaa-0000-7000-8000-0000000000d1';
const USER = '0190aaaa-0000-7000-8000-0000000000f2';
const CERT = '0190aaaa-0000-7000-8000-0000000000c1';

const page = (items: unknown[], total = items.length) =>
  json(200, { items, page: 1, pageSize: 25, total, pageCount: 1 });

const definitions = () =>
  page([
    { id: DEF, name: 'A5 Roofing Certified Sales Representative', code: 'SALES', status: 'active' },
  ]);

const dashboard = {
  issued: 4,
  active: 3,
  expiring: { within30: 1, within60: 2, within90: 3 },
  pendingApprovals: 2,
  eligible: 0,
  revokedThisMonth: 0,
  renewalsOpen: 1,
  pdfFailed: 0,
};

describe('TeamCertificationsPage', () => {
  const row = (name: string, state: string, extra: Record<string, unknown> = {}) => ({
    user: { id: USER, displayName: name, employeeId: 'A5-1', jobTitle: 'Sales Representative' },
    definition: { id: DEF, name: 'A5 Roofing Certified Sales Representative', code: 'SALES' },
    state,
    candidateStatus: null,
    metCount: 2,
    totalCount: 6,
    certificate: null,
    ...extra,
  });

  it('keeps filters in the URL and asks the API for exactly those', async () => {
    const calls = mockApi({
      'GET /api/v1/certificates/team': () =>
        page([
          row('Ashlyn Pierce', 'expiring', {
            certificate: {
              id: CERT,
              certificateNumber: 'A5-SALES-2025-000002',
              status: 'issued',
              issuedAt: '2025-04-04T16:00:00.000Z',
              expiresAt: '2026-10-20T16:00:00.000Z',
            },
          }),
          row('Marcus Delgado', 'in_progress'),
        ]),
      'GET /api/v1/certificates/dashboard': () => json(200, dashboard),
      'GET /api/v1/certifications': definitions,
      'GET /api/v1/teams': () => json(200, { items: [{ id: DEF, name: 'Dallas Residential A' }] }),
    });
    renderApp(<TeamCertificationsPage />, {
      route: '/?filter=expiring&within=30',
      permissions: { 'certificates.view': 'managed', 'certificate_approvals.decide': 'managed' },
    });
    expect(await screen.findByText('Ashlyn Pierce')).toBeInTheDocument();
    const team = calls.find((c) => c.path.startsWith('/api/v1/certificates/team'))!;
    expect(new URLSearchParams(team.path.split('?')[1])).toMatchObject({});
    const params = new URLSearchParams(team.path.split('?')[1]);
    expect(params.get('filter')).toBe('expiring');
    expect(params.get('expiringWithinDays')).toBe('30');

    // The status appears in the table column and, on phones, under the person's name.
    expect(
      screen.getAllByText('Expiring soon', { selector: 'span' }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('In progress', { selector: 'span' }).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      screen.getByRole('progressbar', { name: 'Marcus Delgado: 2 of 6 requirements' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Review 2 approvals/ })).toHaveAttribute(
      'href',
      '/certification-center/approvals',
    );
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('expiring');
    expect(screen.getByRole('combobox', { name: 'Expiring within' })).toHaveValue('30');
  });

  it('says so when nobody matches the filters', async () => {
    mockApi({
      'GET /api/v1/certificates/team': () => page([]),
      'GET /api/v1/certificates/dashboard': () => json(200, dashboard),
      'GET /api/v1/certifications': definitions,
      'GET /api/v1/teams': () => json(200, { items: [] }),
    });
    renderApp(<TeamCertificationsPage />, {
      route: '/?filter=revoked',
      permissions: { 'certificates.view': 'managed' },
    });
    expect(await screen.findByText('No one matches these filters')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });
});

describe('IssuedPage', () => {
  const summary = {
    id: CERT,
    certificateNumber: 'A5-SALES-2026-000005',
    status: 'revoked',
    effectiveStatus: 'revoked',
    definition: { id: DEF, name: 'A5 Roofing Certified Sales Representative', code: 'SALES' },
    recipient: { id: USER, displayName: 'Wesley Tran' },
    issuedAt: '2026-10-05T16:58:00.000Z',
    expiresAt: null,
    mode: 'manual',
    pdfStatus: 'ready',
    revokedAt: '2026-10-05T17:00:00.000Z',
    supersededAt: null,
  };
  const routes = () => ({
    'GET /api/v1/certificates': () => page([summary]),
    'GET /api/v1/certifications': definitions,
    'GET /api/v1/teams': () => json(200, { items: [] }),
  });

  it('searches and filters through the URL, so a link reproduces the list', async () => {
    const calls = mockApi(routes());
    renderApp(<IssuedPage />, {
      route: '/?q=Tran&status=revoked&definitionId=' + DEF + '&sort=issuedAt&issuedFrom=2026-10-01',
      permissions: { 'certificates.view': 'organization', 'certificates.issue': 'organization' },
    });
    expect(await screen.findByRole('link', { name: 'A5-SALES-2026-000005' })).toHaveAttribute(
      'href',
      `/certification-center/issued/${CERT}`,
    );
    const params = new URLSearchParams(
      calls.find((c) => c.path.startsWith('/api/v1/certificates?'))!.path.split('?')[1],
    );
    expect(Object.fromEntries(params)).toMatchObject({
      q: 'Tran',
      status: 'revoked',
      definitionId: DEF,
      sort: 'issuedAt',
      issuedFrom: '2026-10-01',
      page: '1',
      pageSize: '25',
    });
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('revoked');
    expect(screen.getByLabelText('Issued from')).toHaveValue('2026-10-01');
    expect(screen.getByRole('button', { name: 'Issue certificate' })).toBeInTheDocument();
  });

  it('hides issuing from people who may only look', async () => {
    mockApi(routes());
    renderApp(<IssuedPage />, { permissions: { 'certificates.view': 'organization' } });
    await screen.findByRole('link', { name: 'A5-SALES-2026-000005' });
    expect(screen.queryByRole('button', { name: 'Issue certificate' })).toBeNull();
  });

  it('shows the status in words next to the number, with PDF state', async () => {
    mockApi(routes());
    renderApp(<IssuedPage />, { permissions: { 'certificates.view': 'organization' } });
    const row = (await screen.findByRole('link', { name: 'A5-SALES-2026-000005' })).closest('tr')!;
    expect(within(row).getAllByText('Revoked').length).toBeGreaterThanOrEqual(1);
    expect(within(row).getByText('Ready')).toBeInTheDocument();
    expect(within(row).getAllByText('Wesley Tran').length).toBeGreaterThanOrEqual(1);
  });
});

describe('CertificationEditorPage (new)', () => {
  function renderNew() {
    return renderApp(
      <Routes>
        <Route
          path="/certification-center/certifications/:id"
          element={<CertificationEditorPage />}
        />
      </Routes>,
      {
        route: '/certification-center/certifications/new',
        permissions: {
          'certifications.create': 'organization',
          'certifications.view': 'organization',
        },
      },
    );
  }
  const lookupRoutes = () => ({
    'GET /api/v1/programs': () => page([]),
    'GET /api/v1/assessments': () => page([]),
    'GET /api/v1/ai/scenarios': () => page([]),
    'GET /api/v1/certifications': () => page([]),
    'GET /api/v1/certificate-templates': () => page([]),
    'GET /api/v1/signatories': () => page([]),
    'GET /api/v1/stamps': () => page([]),
    'GET /api/v1/certification-settings': () => json(200, { organizationCode: null }),
  });

  it('starts blank except for the issuing organization and the contract defaults', async () => {
    mockApi(lookupRoutes());
    renderNew();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'New certification' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Issuing organization/)).toHaveValue('A5 Roofing');
    expect(screen.getByLabelText(/^Name/)).toHaveValue('');
    expect(screen.getByLabelText(/^Number pattern/)).toHaveValue('{ORG}-{CODE}-{YYYY}-{SEQ:6}');
    expect(screen.getByLabelText('Reminders')).toHaveValue('90, 60, 30, 7');
  });

  it('marks what is missing instead of sending an incomplete certification', async () => {
    const calls = mockApi(lookupRoutes());
    renderNew();
    await userEvent.click(await screen.findByRole('button', { name: 'Create certification' }));
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
    expect(screen.getByLabelText(/^Name/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/^Code/)).toHaveAttribute('aria-invalid', 'true');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('shows a taken code beside the code field', async () => {
    mockApi({
      ...lookupRoutes(),
      'POST /api/v1/certifications': () =>
        json(409, {
          error: {
            code: 'CODE_TAKEN',
            message: 'Another certification already uses this code. Choose a different code.',
          },
        }),
    });
    renderNew();
    await userEvent.type(await screen.findByLabelText(/^Name/), 'Storm Response');
    await userEvent.type(screen.getByLabelText(/^Code/), 'sales');
    await userEvent.click(screen.getByRole('button', { name: 'Create certification' }));
    const code = await screen.findByLabelText(/^Code/);
    await waitFor(() => expect(code).toHaveAttribute('aria-invalid', 'true'));
    expect(
      screen.getByText('Another certification already uses this code. Choose a different code.'),
    ).toBeInTheDocument();
  });

  it('sends the contract-validated request with the code in capitals', async () => {
    const calls = mockApi({
      ...lookupRoutes(),
      'POST /api/v1/certifications': () =>
        json(409, { error: { code: 'CODE_TAKEN', message: 'taken' } }),
    });
    renderNew();
    await userEvent.type(await screen.findByLabelText(/^Name/), 'Storm Response');
    await userEvent.type(screen.getByLabelText(/^Code/), 'storm');
    await userEvent.click(screen.getByRole('button', { name: 'Create certification' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({
      name: 'Storm Response',
      code: 'STORM',
      issuingOrganizationName: 'A5 Roofing',
      approvalPolicy: 'none',
      automaticIssuance: true,
      validity: { kind: 'none' },
      templateId: null,
    });
  });
});

describe('CertificationCenterLayout', () => {
  function renderLayout(
    permissions: Parameters<typeof renderApp>[1] extends infer O
      ? O extends { permissions?: infer P }
        ? P
        : never
      : never,
  ) {
    mockApi({ 'GET /api/v1/certificates/dashboard': () => json(200, dashboard) });
    return renderApp(
      <Routes>
        <Route path="/certification-center" element={<CertificationCenterLayout />}>
          <Route index element={<p>overview</p>} />
        </Route>
      </Routes>,
      { route: '/certification-center', permissions },
    );
  }

  it('shows each person only the sections their permissions allow', async () => {
    renderLayout({
      'certificates.view': 'managed',
      'certificate_approvals.decide': 'managed',
      'certifications.view': 'organization',
    });
    const nav = await screen.findByRole('navigation', { name: 'Certification center' });
    const names = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent?.replace(/\s*\d+ waiting/, ''));
    expect(names).toEqual([
      'Overview',
      'Team',
      'Approvals',
      'Issued',
      'Expiry and renewals',
      'Certifications',
      'Numbering and settings',
    ]);
    expect(within(nav).queryByRole('link', { name: 'Templates' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Signatories' })).toBeNull();
  });

  it('adds the number of waiting approvals to the approvals tab', async () => {
    renderLayout({ 'certificates.view': 'managed', 'certificate_approvals.decide': 'managed' });
    const link = await screen.findByRole('link', { name: /Approvals/ });
    await waitFor(() => expect(link).toHaveTextContent('2 waiting'));
  });

  it('explains when a role has no certification tools', () => {
    renderLayout({ 'training.participate': 'own' });
    expect(
      screen.getByText("You don't have access to the certification center"),
    ).toBeInTheDocument();
  });
});
