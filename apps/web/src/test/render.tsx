import { type ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { vi } from 'vitest';
import { defaultFeatureFlags } from '@a5/contracts';
import type { PermissionKey } from '@a5/permissions';
import { useAuth } from '@/lib/auth-store';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Reply = Response | object | null;
export type Handler = (req: RecordedRequest) => Reply | Promise<Reply>;

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Server-sent events body made of raw chunks, delivered in order. */
export function sseResponse(chunks: string[], options: { fail?: Error } = {}): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]!));
      else if (options.fail) controller.error(options.fail);
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** An event stream the test feeds by hand, to look at the page between chunks. */
export function controlledSse() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (chunk: string) => controller.enqueue(encoder.encode(chunk)),
    close: () => controller.close(),
    fail: (error: Error) => controller.error(error),
  };
}

export const event = (name: string, data: unknown) =>
  `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Replaces `fetch` with route handlers keyed `"METHOD /path"` (path without /api/v1). Handlers
 * return a Response or a JSON-able object; unknown routes fail the test loudly.
 */
export function mockApi(handlers: Record<string, Handler>) {
  const calls: RecordedRequest[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : (input as Request).url,
      'http://app.test',
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const req: RecordedRequest = {
      method,
      path,
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    const handler = handlers[`${method} ${path}`];
    if (!handler) throw new Error(`Unmocked request: ${method} ${path}`);
    const reply = await handler(req);
    if (reply instanceof Response) return reply;
    return reply === null ? new Response(null, { status: 204 }) : json(200, reply);
  });
  return {
    calls,
    spy,
    callsTo: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key),
  };
}

export function meHandler(
  permissions: PermissionKey[],
  flags: Partial<Record<string, boolean>> = {},
) {
  return () => ({
    user: {
      id: '00000000-0000-4000-8000-0000000000aa',
      organizationId: '00000000-0000-4000-8000-0000000000bb',
      organizationName: 'A5 Roofing',
      email: 'marcus.delgado@a5roofing.example',
      firstName: 'Marcus',
      lastName: 'Delgado',
      displayName: 'Marcus Delgado',
      jobTitle: 'Sales Representative',
      roles: [],
    },
    permissions: Object.fromEntries(permissions.map((p) => [p, 'own'])),
    featureFlags: { ...defaultFeatureFlags(), ...flags },
    managedTeamIds: [],
  });
}

function Elsewhere() {
  const { pathname } = useLocation();
  return <p>Elsewhere: {pathname}</p>;
}

/** Renders `element` at `path` of a router with query and auth state, like the real shell. */
export function renderRoute(element: ReactElement, options: { route: string; path: string }) {
  useAuth.setState({
    status: 'authenticated',
    accessToken: 'test-token',
    expiresAt: Date.now() + 600_000,
    sessionId: 's1',
    user: null,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[options.route]}>
          <Routes>
            <Route path={options.path} element={element} />
            <Route path="*" element={<Elsewhere />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}
