import { type ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, vi } from 'vitest';
import type { identity } from '@a5/contracts';
import type { PermissionKey } from '@a5/permissions';
import { sessionKeys } from '@/features/auth/session';
import { useAuth } from '@/lib/auth-store';

// Testing Library only cleans up after itself when test globals are on; this project keeps them off.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom lacks a few browser APIs that Radix primitives use.
if (typeof window !== 'undefined') {
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  window.HTMLElement.prototype.setPointerCapture ??= () => undefined;
  window.HTMLElement.prototype.releasePointerCapture ??= () => undefined;
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

export const ME_ID = '0190aaaa-0000-7000-8000-000000000001';

export function me(
  permissions: Partial<Record<PermissionKey, 'own' | 'managed' | 'organization' | 'platform'>>,
  id = ME_ID,
): identity.MeResponse {
  return {
    user: {
      id,
      organizationId: '0190aaaa-0000-7000-8000-0000000000aa',
      organizationName: 'A5 Roofing',
      email: 'tester@a5roofing.example',
      firstName: 'Taylor',
      lastName: 'Tester',
      displayName: 'Taylor Tester',
      jobTitle: null,
      roles: [],
    },
    permissions,
    featureFlags: {} as identity.MeResponse['featureFlags'],
    managedTeamIds: [],
  };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/** Route table for `fetch`: keys look like `GET /api/v1/certificates/me`. Unmatched requests fail the test. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = `${method} ${url.pathname}`;
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, path: url.pathname + url.search, body });
    const handler = routes[key];
    if (!handler) throw new Error(`Unexpected request: ${key}`);
    return handler(url, init);
  });
  return calls;
}

export function renderApp(
  ui: ReactElement,
  options: {
    route?: string;
    permissions?: Partial<Record<PermissionKey, 'own' | 'managed' | 'organization' | 'platform'>>;
    userId?: string;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  client.setQueryData(sessionKeys.me, me(options.permissions ?? {}, options.userId));
  useAuth.setState({ status: 'authenticated', accessToken: null, expiresAt: null });
  // A data router, like the real app, so hooks such as useBlocker work. The page sits under a splat
  // route and may declare its own <Routes>.
  const router = createMemoryRouter([{ path: '*', element: ui }], {
    initialEntries: [options.route ?? '/'],
  });
  return {
    client,
    router,
    ...render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}
