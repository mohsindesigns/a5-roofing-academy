import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useAuth } from '@/lib/auth-store';
import { VerifyPage } from './verify-page';
import { json, mockApi } from './test-utils';
import type { PublicVerification } from './types';

const TOKEN = 'gTo4obsS6UGRp2jBKHdjnlIFe90yMVpiAgJAyugHNPI';
const PATH = `/api/v1/public/certificates/verify/${TOKEN}`;

function result(overrides: Partial<PublicVerification> = {}): PublicVerification {
  return {
    status: 'valid',
    recipientName: 'Ashlyn Pierce',
    certificationName: 'A5 Roofing Certified Sales Representative',
    issuer: 'A5 Roofing LLC',
    issuedAt: '2025-04-04',
    expiresAt: '2027-04-04',
    certificateNumber: 'A5-SALES-2025-000002',
    revokedAt: null,
    revocationNote: null,
    checkedAt: '2026-10-05T16:53:00.000Z',
    ...overrides,
  };
}

function renderVerify(token = TOKEN) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/verify/${token}`]}>
        <Routes>
          <Route path="/verify/:token" element={<VerifyPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VerifyPage', () => {
  it('shows a valid certificate with only the public details', async () => {
    useAuth.setState({ status: 'anonymous', accessToken: null });
    mockApi({ [`GET ${PATH}`]: () => json(200, result()) });
    renderVerify();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Valid certificate' }),
    ).toBeInTheDocument();
    for (const text of [
      'Ashlyn Pierce',
      'A5 Roofing Certified Sales Representative',
      'A5 Roofing LLC',
      'A5-SALES-2025-000002',
      'Apr 4, 2025',
      'Apr 4, 2027',
    ]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    // Nothing beyond the allow-listed public fields is rendered.
    expect(screen.queryByText(/employee/i)).toBeNull();
    expect(screen.queryByText(/score/i, { selector: 'dt, dd' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Print this result' })).toBeInTheDocument();
  });

  it('calls the public endpoint without credentials or a bearer token', async () => {
    useAuth.setState({
      status: 'authenticated',
      accessToken: 'secret-token',
      expiresAt: Date.now() + 600_000,
    });
    const calls = mockApi({ [`GET ${PATH}`]: () => json(200, result()) });
    renderVerify();
    await screen.findByRole('heading', { name: 'Valid certificate' });
    expect(calls).toHaveLength(1);
    const init = (globalThis.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } })
      .mock.calls[0]![1];
    expect(init.credentials).toBe('omit');
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|secret-token/i);
  });

  it('says an expired certificate is expired rather than valid', async () => {
    mockApi({
      [`GET ${PATH}`]: () => json(200, result({ status: 'expired', expiresAt: '2026-04-04' })),
    });
    renderVerify();
    expect(await screen.findByRole('heading', { name: 'Expired certificate' })).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.queryByText('Valid until')).toBeNull();
  });

  it('shows revocation with the date and the issuer’s public note', async () => {
    mockApi({
      [`GET ${PATH}`]: () =>
        json(
          200,
          result({
            status: 'revoked',
            revokedAt: '2026-10-05',
            revocationNote: 'Withdrawn by the issuer.',
          }),
        ),
    });
    renderVerify();
    expect(await screen.findByRole('heading', { name: 'Revoked certificate' })).toBeInTheDocument();
    expect(screen.getByText('Withdrawn by the issuer.')).toBeInTheDocument();
    expect(screen.getByText('Oct 5, 2026')).toBeInTheDocument();
  });

  it('points to the newer certificate when this one was replaced', async () => {
    mockApi({ [`GET ${PATH}`]: () => json(200, result({ status: 'superseded' })) });
    renderVerify();
    expect(
      await screen.findByRole('heading', { name: 'Replaced by a newer certificate' }),
    ).toBeInTheDocument();
  });

  it('omits the number and expiry when the issuer hides them', async () => {
    mockApi({
      [`GET ${PATH}`]: () => json(200, result({ certificateNumber: null, expiresAt: null })),
    });
    renderVerify();
    await screen.findByRole('heading', { name: 'Valid certificate' });
    expect(screen.queryByText('Certificate number')).toBeNull();
    expect(screen.getByText('No expiration date')).toBeInTheDocument();
  });

  it('explains an unknown link without saying why it failed', async () => {
    mockApi({
      [`GET ${PATH}`]: () =>
        json(404, {
          error: {
            code: 'NOT_AVAILABLE',
            message:
              'This certificate could not be found or is not available for public verification.',
          },
        }),
    });
    renderVerify();
    expect(
      await screen.findByRole('heading', { name: 'We could not verify this certificate' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/No certificate matches this link/);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('does not call the API for a link that cannot be a token', () => {
    const calls = mockApi({});
    renderVerify('short');
    expect(
      screen.getByRole('heading', { name: 'We could not verify this certificate' }),
    ).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('offers a retry when the service is unavailable', async () => {
    mockApi({
      [`GET ${PATH}`]: () =>
        json(503, {
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'The server could not complete the request. Try again in a moment.',
          },
        }),
    });
    renderVerify();
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Try again in a moment'),
    );
  });

  it('keeps the page out of search results', async () => {
    mockApi({ [`GET ${PATH}`]: () => json(200, result()) });
    renderVerify();
    await screen.findByRole('heading', { name: 'Valid certificate' });
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    );
    expect(document.title).toBe('Certificate verification · A5 Sales Academy');
  });
});
