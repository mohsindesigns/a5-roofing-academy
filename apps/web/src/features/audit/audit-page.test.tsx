import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionKey } from '@a5/permissions';
import { Toaster } from '@/components/ui';
import { sessionKeys } from '@/features/auth/session';
import { useAuth } from '@/lib/auth-store';

const get = vi.hoisted(() => vi.fn());
const download = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ api: { get } }));
vi.mock('@/lib/api/download', () => ({ apiDownload: download, saveBlob: save }));

import { AuditPage } from './audit-page';

const entry = (id: string, action: string, extra: Record<string, unknown> = {}) => ({
  id,
  organizationId: 'org',
  occurredAt: '2026-10-05T15:45:00.000Z',
  actor: { type: 'user', id: 'u1', displayName: 'Shelby Hartman' },
  action,
  resourceType: 'program',
  resourceId: 'prog-1',
  reason: null,
  service: 'learning-service',
  ip: '203.0.113.9',
  hasChanges: true,
  ...extra,
});

const detail = {
  ...entry('e1', 'program.updated', { reason: 'Corrected the week 2 pass mark' }),
  before: { title: 'Roofing 101', settings: { navigationMode: 'sequential', dueDays: 56 } },
  after: { title: 'Roofing 101', settings: { navigationMode: 'free', dueDays: 56 } },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  requestId: 'req_1',
  correlationId: 'req_1',
  metadata: { programVersion: 3 },
  recordedAt: '2026-10-05T15:45:01.000Z',
};

function Where() {
  return <p data-testid="url">{useLocation().search}</p>;
}

function renderAudit(permissions: PermissionKey[] = ['audit_logs.view']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionKeys.me, {
    user: { id: 'me', displayName: 'Ruth Abernathy' },
    permissions: Object.fromEntries(permissions.map((p) => [p, 'organization'])),
    featureFlags: {},
    managedTeamIds: [],
  });
  useAuth.setState({ status: 'authenticated', accessToken: 't', expiresAt: Date.now() + 600_000 });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/admin/audit']}>
        <AuditPage />
        <Where />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  download.mockReset();
  save.mockReset();
  get.mockImplementation(async (path: string, query: Record<string, unknown> = {}) => {
    if (path === '/audit/logs') {
      if (query.cursor === 'page-2')
        return {
          items: [entry('e3', 'lesson.moved', { resourceType: 'lesson' })],
          nextCursor: null,
        };
      return {
        items: [
          entry('e1', 'program.updated', { reason: 'Corrected the week 2 pass mark' }),
          entry('e2', 'role.updated', { resourceType: 'role' }),
        ],
        nextCursor: 'page-2',
      };
    }
    if (path === '/audit/logs/e1') return detail;
    if (path.startsWith('/audit/resources/'))
      return { items: [entry('e0', 'program.created')], nextCursor: null };
    if (path === '/audit/facets')
      return {
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-10-06T00:00:00.000Z',
        actions: [{ value: 'program.updated', count: 4 }],
        resourceTypes: [{ value: 'program', count: 5 }],
        services: [{ value: 'learning-service', count: 5 }],
      };
    return {};
  });
});
afterEach(cleanup);

describe('Audit log page', () => {
  it('needs the audit permission', () => {
    renderAudit([]);
    expect(screen.getByText("You don't have access to this page")).toBeInTheDocument();
    expect(get).not.toHaveBeenCalledWith('/audit/logs', expect.anything(), expect.anything());
  });

  it('is read-only: there are no edit or delete actions anywhere', async () => {
    renderAudit();
    await screen.findByRole('table', { name: /Audit log entries/ });
    const buttons = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(buttons.join(' ')).not.toMatch(/Edit|Delete|Remove|Save/);
    expect(screen.getByText(/cannot be edited or deleted/)).toBeInTheDocument();
  });

  it('loads older entries with the keyset cursor', async () => {
    const user = userEvent.setup();
    renderAudit();
    await screen.findByText('role.updated');
    expect(screen.getByText(/2 entries loaded/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load older entries' }));
    expect(await screen.findByText('lesson.moved')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(
      '/audit/logs',
      expect.objectContaining({ cursor: 'page-2' }),
      expect.anything(),
    );
    expect(screen.getByText(/3 entries loaded \(all\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load older entries' })).not.toBeInTheDocument();
  });

  it('puts filters in the URL and sends them to the API', async () => {
    const user = userEvent.setup();
    renderAudit();
    await screen.findByRole('table', { name: /Audit log entries/ });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Resource type' }), 'program');
    await waitFor(() =>
      expect(screen.getByTestId('url')).toHaveTextContent('resourceType=program'),
    );
    expect(get).toHaveBeenCalledWith(
      '/audit/logs',
      expect.objectContaining({ resourceType: 'program', limit: 50 }),
      expect.anything(),
    );
  });

  it('shows the before and after of an entry and the rest of the resource history', async () => {
    const user = userEvent.setup();
    renderAudit();
    await user.click(await screen.findByRole('button', { name: /Open details: program.updated/ }));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('Corrected the week 2 pass mark')).toBeInTheDocument();
    const changes = within(drawer).getByRole('table', { name: 'Changes recorded by this entry' });
    // Only the changed field is listed, with before and after values.
    expect(within(changes).getByText('settings.navigationMode')).toBeInTheDocument();
    expect(within(changes).getByText('sequential')).toBeInTheDocument();
    expect(within(changes).getByText('free')).toBeInTheDocument();
    expect(within(changes).queryByText('title')).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole('switch', { name: /unchanged fields/ }));
    expect(within(changes).getByText('title')).toBeInTheDocument();
    expect(await within(drawer).findByText('program.created')).toBeInTheDocument();
    expect(within(drawer).getByText(/cannot be edited or deleted/)).toBeInTheDocument();
  });

  it('exports with the filters on screen and reports the outcome', async () => {
    const user = userEvent.setup();
    download.mockResolvedValue({ blob: new Blob(['id']), fileName: 'audit-log-2026-10-06.csv' });
    renderAudit();
    await screen.findByRole('table', { name: /Audit log entries/ });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Resource type' }), 'program');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(download).toHaveBeenCalledWith(
      '/audit/export',
      { resourceType: 'program' },
      'audit-log.csv',
    );
    expect(await screen.findByText('Export downloaded')).toBeInTheDocument();
  });

  it('shows the API reason when an export is too large', async () => {
    const user = userEvent.setup();
    download.mockRejectedValue(
      new Error('This export matches more than 50,000 entries. Narrow the date range.'),
    );
    renderAudit();
    await screen.findByRole('table', { name: /Audit log entries/ });
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText(/matches more than 50,000 entries/)).toBeInTheDocument();
  });

  it('refuses a reversed date range before calling the API', async () => {
    const user = userEvent.setup();
    renderAudit();
    await screen.findByRole('table', { name: /Audit log entries/ });
    get.mockClear();
    await user.type(screen.getByLabelText('From date'), '2026-10-05');
    await user.type(screen.getByLabelText('To date'), '2026-09-01');
    expect(
      await screen.findByText('The end date must be on or after the start date.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });
});
