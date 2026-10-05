import './test-cleanup';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import { TooltipProvider } from '@/components/ui';

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
  });
}

/** Render a component with a fresh query cache and an in-memory router. */
export function renderWithProviders(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const client = newClient();
  const view = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

/** Same, with a data router, for components that use loaders' companions such as `useBlocker`. */
export function renderWithDataRouter(
  ui: ReactElement,
  { route = '/', path = '*' }: { route?: string; path?: string } = {},
) {
  const client = newClient();
  const router = createMemoryRouter(
    [
      { path, element: ui },
      { path: '*', element: <p>Elsewhere</p> },
    ],
    { initialEntries: [route] },
  );
  const view = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...view, client, router };
}
