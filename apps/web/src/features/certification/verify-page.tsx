import { useEffect, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, CircleX, History, Printer, RotateCw } from 'lucide-react';
import { certification } from '@a5/contracts';
import { BrandMark } from '@/app/shell/brand';
import { Button, Skeleton } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { formatDate, formatDateTime } from '@/lib/format';
import { fetchPublicVerification } from './api';
import { FactList } from './fact-list';
import type { PublicVerification } from './types';

type Result = PublicVerification['status'];

const RESULT: Record<
  Result,
  { headline: string; summary: string; icon: typeof CircleCheck; frame: string; text: string }
> = {
  valid: {
    headline: 'Valid certificate',
    summary: 'The issuer confirms this certificate is current.',
    icon: CircleCheck,
    frame: 'border-success/40 bg-success-soft',
    text: 'text-success',
  },
  expired: {
    headline: 'Expired certificate',
    summary: 'This certificate was genuine, but its validity period has ended.',
    icon: CircleAlert,
    frame: 'border-warning/40 bg-warning-soft',
    text: 'text-warning',
  },
  revoked: {
    headline: 'Revoked certificate',
    summary: 'The issuer withdrew this certificate. It is no longer valid.',
    icon: CircleX,
    frame: 'border-danger/40 bg-danger-soft',
    text: 'text-danger',
  },
  superseded: {
    headline: 'Replaced by a newer certificate',
    summary:
      'The issuer replaced this certificate with a newer one. Ask the holder for their current certificate.',
    icon: History,
    frame: 'border-border-strong bg-surface-sunken',
    text: 'text-text-primary',
  },
};

/** Facts shown on the result. Only what the public DTO contains is ever rendered. */
export function verificationFacts(v: PublicVerification) {
  const items: Array<{ label: string; value: ReactNode }> = [
    { label: 'Awarded to', value: v.recipientName },
    { label: 'Certification', value: v.certificationName },
    { label: 'Issued by', value: v.issuer },
    { label: 'Issued', value: formatDate(v.issuedAt) },
  ];
  if (v.status === 'revoked' && v.revokedAt) {
    items.push({ label: 'Revoked', value: formatDate(v.revokedAt) });
  } else {
    items.push({
      label: v.status === 'expired' ? 'Expired' : 'Valid until',
      value: v.expiresAt ? formatDate(v.expiresAt) : 'No expiration date',
    });
  }
  if (v.certificateNumber) {
    items.push({
      label: 'Certificate number',
      value: <span className="font-mono text-sm">{v.certificateNumber}</span>,
    });
  }
  return items;
}

export function VerificationResult({ result }: { result: PublicVerification }) {
  const view = RESULT[result.status];
  const Icon = view.icon;
  return (
    <article aria-labelledby="verification-headline">
      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border-2 px-4 py-4 print:bg-white',
          view.frame,
        )}
      >
        <Icon aria-hidden className={cn('mt-0.5 size-6 shrink-0', view.text)} />
        <div className="min-w-0">
          <h1
            id="verification-headline"
            className={cn('text-xl font-semibold tracking-[-0.01em]', view.text)}
          >
            {view.headline}
          </h1>
          <p className="mt-0.5 text-base text-text-primary/80">{view.summary}</p>
        </div>
      </div>

      <div className="mt-6">
        <FactList items={verificationFacts(result)} />
      </div>

      {result.status === 'revoked' && result.revocationNote && (
        <div className="mt-6 rounded-lg border border-border bg-surface px-4 py-3">
          <p className="text-xs font-medium text-text-secondary">Note from the issuer</p>
          <p className="mt-0.5 text-base">{result.revocationNote}</p>
        </div>
      )}

      <p className="mt-8 text-sm text-text-secondary">
        Checked <time dateTime={result.checkedAt}>{formatDateTime(result.checkedAt)}</time>. This
        result reflects the certificate&rsquo;s status at that moment.
      </p>
    </article>
  );
}

function NotAvailable({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert">
      <div className="flex items-start gap-3 rounded-lg border-2 border-border-strong bg-surface-sunken px-4 py-4">
        <CircleAlert aria-hidden className="mt-0.5 size-6 shrink-0 text-text-secondary" />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.01em]">
            We could not verify this certificate
          </h1>
          <p className="mt-0.5 text-base text-text-primary/80">{message}</p>
        </div>
      </div>
      <ul className="mt-5 list-disc space-y-1 pl-5 text-sm text-text-secondary">
        <li>Check that the link or QR code was copied completely.</li>
        <li>Ask the certificate holder to send the verification link again.</li>
        <li>Contact the issuing organization if the problem continues.</li>
      </ul>
      {onRetry && (
        <Button
          className="mt-5 print:hidden"
          onClick={onRetry}
          leading={<RotateCw className="size-4" />}
        >
          Try again
        </Button>
      )}
    </div>
  );
}

function usePageMeta() {
  useEffect(() => {
    const previous = document.title;
    document.title = 'Certificate verification · A5 Sales Academy';
    // Verification links are shared privately: keep them out of search results.
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.title = previous;
      meta.remove();
    };
  }, []);
}

/**
 * Public certificate verification. It lives outside the authenticated layout, calls an
 * unauthenticated endpoint and renders only the allow-listed public DTO.
 */
export function VerifyPage() {
  const { token = '' } = useParams();
  usePageMeta();
  const wellFormed = certification.verificationTokenSchema.safeParse(token).success;
  const query = useQuery({
    queryKey: ['certification', 'public-verification', token],
    queryFn: ({ signal }) => fetchPublicVerification(token, signal),
    enabled: wellFormed,
    // A verification result is a point-in-time check: never serve a cached answer.
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  let body;
  if (!wellFormed) {
    body = (
      <NotAvailable message="This verification link is not valid. It may have been copied incompletely." />
    );
  } else if (query.isPending) {
    body = (
      <div role="status" aria-label="Checking the certificate" className="grid gap-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  } else if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    body = (
      <NotAvailable
        message={
          notFound
            ? 'No certificate matches this link, or the issuer has not made it available for public verification.'
            : errorMessage(query.error)
        }
        onRetry={notFound ? undefined : () => query.refetch()}
      />
    );
  } else {
    body = <VerificationResult result={query.data} />;
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background print:bg-white">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to result
      </a>
      <header className="flex h-16 items-center justify-between gap-2.5 px-5 sm:px-8 print:h-12">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <span className="text-sm font-semibold">
            A5 Roofing <span className="font-normal text-text-secondary">Sales Academy</span>
          </span>
        </div>
        <span className="text-sm text-text-secondary">Certificate verification</span>
      </header>
      <main id="main" className="mx-auto w-full max-w-[640px] flex-1 px-4 pt-6 pb-16 sm:pt-12">
        <div aria-live="polite">{body}</div>
        {query.isSuccess && (
          <div className="mt-6 print:hidden">
            <Button onClick={() => window.print()} leading={<Printer className="size-4" />}>
              Print this result
            </Button>
          </div>
        )}
        <p className="mt-8 hidden text-xs break-all text-text-secondary print:block">
          Verification link: {typeof window === 'undefined' ? '' : window.location.href}
        </p>
      </main>
      <footer className="px-5 pb-8 text-xs text-text-secondary sm:px-8 print:hidden">
        This page shows only the details the issuer chooses to publish. It never shows contact
        information, scores or training records.
      </footer>
    </div>
  );
}
