import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../auth-store';
import { apiRequest, refreshSession } from './client';
import { ApiError } from './errors';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const session = (token: string) => ({
  accessToken: token,
  expiresIn: 600,
  sessionId: 's1',
  user: {
    id: 'u',
    organizationId: 'o',
    organizationName: 'A5 Roofing',
    email: 'a@b.c',
    firstName: 'A',
    lastName: 'B',
    displayName: 'A B',
    jobTitle: null,
    roles: [],
  },
});

beforeEach(() => {
  document.cookie = 'a5_csrf=csrf-token-value-1234';
  useAuth.setState({
    status: 'authenticated',
    accessToken: 'old',
    expiresAt: Date.now() + 600_000,
    sessionId: 's1',
    user: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.cookie = 'a5_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

describe('apiRequest', () => {
  it('normalises API errors with code, message and fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      json(400, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some fields need attention.',
          fields: [{ path: 'email', message: 'Taken' }],
          requestId: 'r1',
        },
      }),
    );
    const err = await apiRequest('/users', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      fields: [{ path: 'email', message: 'Taken' }],
      requestId: 'r1',
    });
  });

  it('reports network failures with an actionable message', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(apiRequest('/users')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: expect.stringMatching(/connection/),
    });
  });

  it('refreshes once on an expired token and retries the request', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        json(401, { error: { code: 'SESSION_EXPIRED', message: 'Your session expired.' } }),
      )
      .mockResolvedValueOnce(json(200, session('new')))
      .mockResolvedValueOnce(json(200, { ok: true }));
    await expect(apiRequest('/users')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retried = fetchMock.mock.calls[2]![1] as RequestInit;
    expect((retried.headers as Record<string, string>).authorization).toBe('Bearer new');
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({
      'x-csrf-token': 'csrf-token-value-1234',
    });
  });

  it('signs the user out when refresh fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        json(401, { error: { code: 'SESSION_EXPIRED', message: 'Your session expired.' } }),
      )
      .mockResolvedValueOnce(
        json(401, {
          error: { code: 'SESSION_REVOKED', message: 'You were signed out. Sign in again.' },
        }),
      );
    await expect(apiRequest('/users')).rejects.toBeInstanceOf(ApiError);
    expect(useAuth.getState().status).toBe('anonymous');
    expect(useAuth.getState().signedOutReason).toBe('You were signed out. Sign in again.');
  });
});

describe('refreshSession', () => {
  it('is single-flight within a tab', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json(200, session('fresh')));
    const results = await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    expect(results).toEqual([true, true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the network when there is no session cookie', async () => {
    document.cookie = 'a5_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    useAuth.setState({ status: 'loading' });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(refreshSession()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAuth.getState().status).toBe('anonymous');
  });
});
