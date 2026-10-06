import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui';

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ api: { get, post } }));

import { ExportsPanel } from './exports-panel';

const job = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  report: 'training-completion',
  reportTitle: 'Training completion',
  format: 'xlsx',
  status,
  filters: { from: '2026-09-01', to: '2026-09-30' },
  sort: null,
  rowCount: null,
  fileName: null,
  fileSize: null,
  error: null,
  createdAt: '2026-10-05T14:00:00.000Z',
  startedAt: null,
  completedAt: null,
  expiresAt: null,
  ...extra,
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ExportsPanel />
      <Toaster />
    </QueryClientProvider>,
  );
}

const page = (items: unknown[]) => ({
  items,
  page: 1,
  pageSize: 10,
  total: items.length,
  pageCount: 1,
});

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});
afterEach(cleanup);

describe('Exports panel', () => {
  it('shows the state of each job in words', async () => {
    get.mockResolvedValue(
      page([
        job('j1', 'completed', {
          rowCount: 120,
          fileSize: 20480,
          expiresAt: '2026-10-12T14:00:00.000Z',
        }),
        job('j2', 'running'),
        job('j3', 'failed', { error: 'The export could not be created. Run it again.' }),
        job('j4', 'expired'),
      ]),
    );
    renderPanel();
    const table = await screen.findByRole('table', { name: 'Your report exports' });
    expect(within(table).getByText('Ready')).toBeInTheDocument();
    expect(within(table).getByText('Preparing')).toBeInTheDocument();
    expect(within(table).getByText('Failed')).toBeInTheDocument();
    expect(
      within(table).getByText('The export could not be created. Run it again.'),
    ).toBeInTheDocument();
    expect(within(table).getByText('Expired')).toBeInTheDocument();
    expect(within(table).getByText(/120 rows/)).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: /Download/ })).toBeInTheDocument();
    expect(within(table).getAllByRole('button', { name: /Run again/ })).toHaveLength(2);
  });

  it('fetches a fresh signed link when downloading', async () => {
    const user = userEvent.setup();
    get.mockImplementation(async (path: string) =>
      path === '/reports/exports/j1/download'
        ? {
            url: 'https://files.example/training.xlsx?sig=abc',
            fileName: 'training-completion-2026-10-05.xlsx',
            expiresAt: '2026-10-05T14:05:00.000Z',
          }
        : page([job('j1', 'completed', { fileSize: 2048, rowCount: 3 })]),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /Download/ }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(get).toHaveBeenCalledWith('/reports/exports/j1/download');
    click.mockRestore();
  });

  it('says why a download is not possible', async () => {
    const user = userEvent.setup();
    get.mockImplementation(async (path: string) => {
      if (path.endsWith('/download'))
        throw new Error('This export has expired. Run the export again.');
      return page([job('j1', 'completed')]);
    });
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /Download/ }));
    expect(
      await screen.findByText('This export has expired. Run the export again.'),
    ).toBeInTheDocument();
  });

  it('starts the same export again with its stored filters', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue(page([job('j4', 'expired', { sort: '-dueAt' })]));
    post.mockResolvedValue(job('j5', 'queued'));
    renderPanel();
    await user.click(await screen.findByRole('button', { name: /Run again/ }));
    expect(post).toHaveBeenCalledWith('/reports/exports', {
      report: 'training-completion',
      format: 'xlsx',
      filters: { from: '2026-09-01', to: '2026-09-30' },
      sort: '-dueAt',
    });
  });

  it('has an explanatory empty state', async () => {
    get.mockResolvedValue(page([]));
    renderPanel();
    expect(await screen.findByText('No exports yet')).toBeInTheDocument();
  });
});
