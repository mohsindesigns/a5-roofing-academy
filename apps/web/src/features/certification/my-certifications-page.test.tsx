import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MyCertificationsPage } from './my-certifications-page';
import { json, mockApi, renderApp } from './test-utils';
import type { MyCertificationItem, MyCertifications } from './types';

const DEF = '0190aaaa-0000-7000-8000-0000000000d1';
const CERT = '0190aaaa-0000-7000-8000-0000000000c1';
const USER = '0190aaaa-0000-7000-8000-0000000000f2';
const URL = 'https://academy.a5roofing.example/verify/gTo4obsS6UGRp2jBKHdjnlIFe90yMVpiAgJAyugHNPI';

const definition = {
  id: DEF,
  name: 'A5 Roofing Certified Sales Representative',
  code: 'SALES',
  publicDescription: 'Awarded to representatives who finished the academy.',
  badge: { label: 'Certified Sales Rep', color: '#B4531F', assetId: null },
};

function certificate(over: Record<string, unknown> = {}) {
  return {
    id: CERT,
    certificateNumber: 'A5-SALES-2025-000002',
    status: 'issued',
    effectiveStatus: 'issued',
    definition: { id: DEF, name: definition.name, code: 'SALES' },
    recipient: { id: USER, displayName: 'Ashlyn Pierce' },
    issuedAt: '2025-04-04T16:00:00.000Z',
    expiresAt: '2030-04-04T16:00:00.000Z',
    mode: 'approval',
    pdfStatus: 'ready',
    revokedAt: null,
    supersededAt: null,
    ...over,
  };
}

const requirements = [
  {
    key: '0',
    type: 'program_completed',
    description: 'Complete A5 New Hire Sales Academy',
    satisfied: true,
    unknown: false,
    progress: { current: 100, target: 100, unit: 'percent' as const },
  },
  {
    key: '1',
    type: 'assessment_score',
    description: 'Score 85% or higher on the final',
    satisfied: false,
    unknown: false,
    progress: { current: 40, target: 85, unit: 'percent' as const },
  },
];

const progress = (over: Record<string, unknown> = {}) => ({
  definitionId: DEF,
  userId: USER,
  status: 'in_progress',
  purpose: 'initial',
  metCount: 1,
  totalCount: 2,
  requirements,
  evaluatedAt: null,
  eligibleAt: null,
  onHold: false,
  holdReason: null,
  ...over,
});

function respond(item: Partial<MyCertificationItem>) {
  const body = {
    items: [
      {
        definition,
        state: 'active',
        certificate: certificate(),
        progress: null,
        renewal: null,
        verificationUrl: URL,
        ...item,
      },
    ],
    certificates: [],
  } as MyCertifications;
  mockApi({ 'GET /api/v1/certificates/me': () => json(200, body) });
}

const permissions = { 'certificates.view_own': 'own' } as const;

describe('MyCertificationsPage', () => {
  it('shows an active certificate with its number, dates and actions', async () => {
    respond({});
    renderApp(<MyCertificationsPage />, { permissions });
    expect(
      await screen.findByRole('heading', { level: 2, name: definition.name }),
    ).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('A5-SALES-2025-000002')).toBeInTheDocument();
    expect(screen.getByText('Apr 4, 2025')).toBeInTheDocument();
    expect(screen.getByText('Expires Apr 4, 2030')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Details' })).toHaveAttribute(
      'href',
      `/certifications/${CERT}`,
    );
    expect(screen.queryByText('Requirements')).toBeNull();
  });

  it('shares the verification link and a QR code that encodes it', async () => {
    respond({});
    renderApp(<MyCertificationsPage />, { permissions });
    await userEvent.click(await screen.findByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Verification link' })).toHaveValue(URL);
    expect(
      within(dialog).getByRole('img', {
        name: /QR code that opens the verification page for certificate A5-SALES-2025-000002/,
      }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Open verification page/ })).toHaveAttribute(
      'href',
      URL,
    );
  });

  it('waits for the PDF instead of offering a download that would fail', async () => {
    respond({
      certificate: certificate({ pdfStatus: 'pending' }) as MyCertificationItem['certificate'],
    });
    renderApp(<MyCertificationsPage />, { permissions });
    expect(await screen.findByRole('button', { name: 'PDF is being prepared' })).toBeDisabled();
  });

  it('shows what is left for someone still working toward the certification', async () => {
    respond({
      state: 'in_progress',
      certificate: null,
      verificationUrl: null,
      progress: progress() as MyCertificationItem['progress'],
    });
    renderApp(<MyCertificationsPage />, { permissions });
    expect(await screen.findByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 complete')).toBeInTheDocument();
    expect(screen.getByText('40% of 85% needed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download PDF' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
  });

  it('tells someone waiting for approval that an approver is reviewing', async () => {
    respond({
      state: 'pending_approval',
      certificate: null,
      verificationUrl: null,
      progress: progress({ status: 'pending_approval' }) as MyCertificationItem['progress'],
    });
    renderApp(<MyCertificationsPage />, { permissions });
    expect(await screen.findByText('Pending approval')).toBeInTheDocument();
    expect(screen.getByText(/An approver is reviewing your results/)).toBeInTheDocument();
  });

  it('offers renewal only while a renewal is open', async () => {
    const renewal = {
      id: CERT,
      certificateId: CERT,
      status: 'open' as const,
      windowOpenedAt: '2026-09-01T00:00:00.000Z',
      dueAt: '2026-12-01T00:00:00.000Z',
      completedAt: null,
      newCertificateId: null,
    };
    respond({
      state: 'renewal_required',
      renewal,
      progress: progress({ purpose: 'renewal' }) as MyCertificationItem['progress'],
    });
    renderApp(<MyCertificationsPage />, { permissions });
    expect(await screen.findByText('Renew before this expires')).toBeInTheDocument();
    expect(screen.getByText('1 renewal requirement is still open.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to training' })).toHaveAttribute(
      'href',
      '/training',
    );
    expect(screen.getByText('Renewal requirements')).toBeInTheDocument();
  });

  it('does not offer renewal, download or sharing for a revoked certificate', async () => {
    respond({
      state: 'revoked',
      certificate: certificate({
        status: 'revoked',
        effectiveStatus: 'revoked',
        revokedAt: '2026-10-01T00:00:00.000Z',
      }) as MyCertificationItem['certificate'],
      verificationUrl: null,
    });
    renderApp(<MyCertificationsPage />, { permissions });
    expect((await screen.findAllByText('Revoked')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Oct 1, 2026')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download|PDF/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    expect(screen.queryByText(/Renew/)).toBeNull();
  });

  it('puts the most pressing certification first', async () => {
    const other = {
      ...definition,
      id: '0190aaaa-0000-7000-8000-0000000000d2',
      name: 'Storm Response Specialist',
    };
    mockApi({
      'GET /api/v1/certificates/me': () =>
        json(200, {
          items: [
            {
              definition: other,
              state: 'in_progress',
              certificate: null,
              progress: progress(),
              renewal: null,
              verificationUrl: null,
            },
            {
              definition,
              state: 'expiring',
              certificate: certificate(),
              progress: null,
              renewal: null,
              verificationUrl: URL,
            },
          ],
          certificates: [],
        }),
    });
    renderApp(<MyCertificationsPage />, { permissions });
    const headings = await screen.findAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([
      definition.name,
      'Storm Response Specialist',
    ]);
  });

  it('explains an empty list and offers a way forward', async () => {
    mockApi({ 'GET /api/v1/certificates/me': () => json(200, { items: [], certificates: [] }) });
    renderApp(<MyCertificationsPage />, { permissions });
    expect(await screen.findByText('No certifications yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to training' })).toBeInTheDocument();
  });

  it('shows the API’s message and a retry when loading fails', async () => {
    mockApi({
      'GET /api/v1/certificates/me': () =>
        json(403, {
          error: { code: 'FORBIDDEN', message: 'You do not have permission to do this.' },
        }),
    });
    renderApp(<MyCertificationsPage />, { permissions });
    expect(await screen.findByText('Your certifications could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('You do not have permission to do this.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('is closed to people without permission to view their own certificates', () => {
    const calls = mockApi({});
    renderApp(<MyCertificationsPage />, { permissions: {} });
    expect(screen.getByText("You don't have access to this page")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
