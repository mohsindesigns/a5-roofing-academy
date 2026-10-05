import type { identity } from '@a5/contracts';
import { useAuth } from '../auth-store';
import { ApiError, NETWORK_ERROR_MESSAGE } from './errors';

export const API_BASE = '/api/v1';

type Query = Record<string, string | number | boolean | null | undefined | string[]>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Internal: prevents refresh loops. */
  skipRefresh?: boolean;
}

function readCookie(name: string): string | null {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export function buildUrl(path: string, query?: Query): string {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) url.searchParams.set(k, v.join(','));
    } else url.searchParams.set(k, String(v));
  }
  return `${url.pathname}${url.search}`;
}

const REFRESHABLE = new Set(['SESSION_EXPIRED', 'UNAUTHENTICATED', 'TOKEN_INVALID']);
let refreshing: Promise<boolean> | null = null;

/**
 * Exchange the refresh cookie for a new access token. Single-flight within the tab and
 * serialised across tabs with the Web Locks API so rotations never race.
 */
export function refreshSession(): Promise<boolean> {
  // No CSRF cookie means there is no session cookie either: skip the round trip.
  if (!readCookie('a5_csrf')) {
    if (useAuth.getState().status !== 'authenticated') useAuth.getState().clear(null);
    return Promise.resolve(false);
  }
  refreshing ??= (async () => {
    const run = async (): Promise<boolean> => {
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'x-csrf-token': readCookie('a5_csrf') ?? '', accept: 'application/json' },
        });
        if (!res.ok) {
          const err = await ApiError.fromResponse(res);
          useAuth.getState().clear(err.code === 'UNAUTHENTICATED' ? null : err.message);
          return false;
        }
        useAuth.getState().setSession((await res.json()) as identity.LoginResponse);
        return true;
      } catch {
        // Network failure: keep the current state so the user can retry when back online.
        return useAuth.getState().status === 'authenticated';
      }
    };
    return typeof navigator !== 'undefined' && 'locks' in navigator
      ? navigator.locks.request('a5-session-refresh', run)
      : run();
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal, headers, skipRefresh } = options;
  const auth = useAuth.getState();
  // Refresh proactively when the token is about to expire.
  if (!skipRefresh && auth.accessToken && auth.expiresAt && auth.expiresAt - Date.now() < 15_000) {
    await refreshSession();
  }
  const token = useAuth.getState().accessToken;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      signal,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body !== undefined && !isForm && { 'content-type': 'application/json' }),
        ...(token && { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE);
  }

  if (res.status === 401 && !skipRefresh) {
    const err = await ApiError.fromResponse(res.clone());
    if (REFRESHABLE.has(err.code) && (await refreshSession())) {
      return apiRequest<T>(path, { ...options, skipRefresh: true });
    }
    if (useAuth.getState().status === 'authenticated') useAuth.getState().clear(err.message);
    throw err;
  }
  if (!res.ok) throw await ApiError.fromResponse(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) =>
    apiRequest<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'POST', body: body ?? {} }),
  put: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'PUT', body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'PATCH', body: body ?? {} }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
};

/** Sign in with credentials; establishes the session in the auth store. */
export async function signIn(email: string, password: string): Promise<identity.LoginResponse> {
  const session = await apiRequest<identity.LoginResponse>('/auth/login', {
    method: 'POST',
    body: { email, password },
    skipRefresh: true,
  });
  useAuth.getState().setSession(session);
  return session;
}

export async function signOut(): Promise<void> {
  try {
    await apiRequest('/auth/logout', {
      method: 'POST',
      body: {},
      skipRefresh: true,
      headers: { 'x-csrf-token': readCookie('a5_csrf') ?? '' },
    });
  } finally {
    useAuth.getState().clear(null);
  }
}
