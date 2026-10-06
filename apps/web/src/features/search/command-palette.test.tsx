import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionKey } from '@a5/permissions';
import { useAuth } from '@/lib/auth-store';
import { sessionKeys } from '@/features/auth/session';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', () => ({ api: { get } }));

import { CommandPalette, SearchTrigger, usePalette } from './command-palette';

function Where() {
  const l = useLocation();
  return <p data-testid="where">{`${l.pathname}${l.search}`}</p>;
}

function renderPalette(permissions: PermissionKey[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionKeys.me, {
    user: { id: 'u1', displayName: 'Test User' },
    permissions: Object.fromEntries(permissions.map((p) => [p, 'organization'])),
    featureFlags: {},
    managedTeamIds: [],
  });
  useAuth.setState({ status: 'authenticated', accessToken: 't', expiresAt: Date.now() + 600_000 });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <SearchTrigger />
        <CommandPalette />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  usePalette.setState({ open: false });
  get.mockImplementation(async (path: string) => {
    if (path === '/users')
      return {
        items: [
          {
            id: 'person-1',
            displayName: 'Marcus Delgado',
            jobTitle: 'Sales Representative',
            teams: [{ id: 't', name: 'Dallas Residential A' }],
          },
        ],
      };
    if (path === '/learning/search')
      return {
        programs: [
          { id: 'prog-1', title: 'A5 New Hire Sales Academy', status: 'published', summary: null },
        ],
        lessons: [
          {
            id: 'les-1',
            title: 'Marketing your first knock',
            type: 'article',
            programId: 'prog-1',
            programTitle: 'A5 New Hire Sales Academy',
            phaseTitle: 'Week 1',
            status: 'published',
          },
        ],
      };
    return {};
  });
});
afterEach(cleanup);

describe('CommandPalette', () => {
  it('opens with Ctrl+K and lists the pages the viewer can use', async () => {
    const user = userEvent.setup();
    renderPalette(['users.view', 'enrollments.view', 'reports.view']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Search' })).toBeInTheDocument();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['Home', 'Team', 'People', 'Reports']));
    // Pages the role cannot reach are not offered.
    expect(options.join(' ')).not.toMatch(/Audit log|Roles/);
  });

  it('filters pages as you type and opens the highlighted one with Enter', async () => {
    const user = userEvent.setup();
    renderPalette(['users.view', 'enrollments.view']);
    usePalette.getState().setOpen(true);
    await user.type(await screen.findByRole('combobox'), 'tea');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent('/team');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('searches people and programs through the API and moves with the arrow keys', async () => {
    const user = userEvent.setup();
    renderPalette(['users.view', 'programs.view', 'programs.update']);
    usePalette.getState().setOpen(true);
    await user.type(await screen.findByRole('combobox'), 'mar');
    expect(await screen.findByRole('option', { name: /Marcus Delgado/ })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(
      '/users',
      expect.objectContaining({ q: 'mar' }),
      expect.anything(),
    );
    expect(
      await screen.findByRole('option', { name: /Marketing your first knock/ }),
    ).toBeInTheDocument();

    // Arrow down until the person is highlighted (the first match, a page, comes before them).
    const person = screen.getByRole('option', { name: /Marcus Delgado/ });
    for (let i = 0; i < 12 && person.getAttribute('aria-selected') !== 'true'; i++) {
      await user.keyboard('{ArrowDown}');
    }
    expect(person).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent('/people/person-1');
  });

  it('links lessons to the builder for editors and to training for learners', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPalette(['programs.view', 'programs.update']);
    usePalette.getState().setOpen(true);
    await user.type(await screen.findByRole('combobox'), 'mar');
    await user.click(await screen.findByRole('option', { name: /Marketing your first knock/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/content/programs/prog-1?lesson=les-1');
    unmount();
    cleanup();

    renderPalette(['training.participate']);
    usePalette.getState().setOpen(true);
    await user.type(await screen.findByRole('combobox'), 'mar');
    await user.click(await screen.findByRole('option', { name: /Marketing your first knock/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/training/prog-1/lessons/les-1');
  });

  it('does not request people the viewer may not see', async () => {
    const user = userEvent.setup();
    renderPalette(['training.participate']);
    usePalette.getState().setOpen(true);
    await user.type(await screen.findByRole('combobox'), 'mar');
    await screen.findByRole('option', { name: 'A5 New Hire Sales Academy' });
    expect(get).not.toHaveBeenCalledWith('/users', expect.anything(), expect.anything());
  });

  it('keeps pages usable when a search fails and says so', async () => {
    const user = userEvent.setup();
    get.mockRejectedValue(new Error('down'));
    renderPalette(['users.view', 'enrollments.view']);
    usePalette.getState().setOpen(true);
    await user.type(await screen.findByRole('combobox'), 'te');
    expect(await screen.findByText(/Search for people is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Team' })).toBeInTheDocument();
  });
});
