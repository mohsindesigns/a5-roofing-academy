import { type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { ErrorState, Notice, PageHeader, Section, Skeleton } from '@/components/ui';
import { StatCell, StatRow, StatTile } from '@/components/charts';
import { RequirePermission } from '@/app/guards';
import { usePermissions } from '@/features/auth/session';
import { errorMessage } from '@/lib/api/errors';
import { formatDate, formatRelative } from '@/lib/format';
import { useApprovals, useCandidates, useCertificates, useDashboard } from '../api';
import { expiryText } from '../labels';
import { PersonCell } from '../person-cell';
import { CenterIndexRedirect } from './center-layout';
import { CENTER_ROOT } from './nav';

function AttentionList({
  title,
  description,
  to,
  linkLabel,
  loading,
  error,
  onRetry,
  empty,
  children,
}: {
  title: string;
  description?: string;
  to: string;
  linkLabel: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  empty: string;
  children: ReactNode[];
}) {
  return (
    <Section
      title={title}
      description={description}
      actions={
        <Link
          to={to}
          className="inline-flex items-center gap-1 text-sm font-medium text-information hover:underline"
        >
          {linkLabel}
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      }
    >
      {loading ? (
        <Skeleton className="h-24 w-full" />
      ) : error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : children.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong px-4 py-5 text-sm text-text-secondary">
          {empty}
        </p>
      ) : (
        <ul className="divide-y divide-divider overflow-hidden rounded-lg border border-border bg-surface">
          {children}
        </ul>
      )}
    </Section>
  );
}

function Row({
  to,
  person,
  detail,
  aside,
}: {
  to: string;
  person: string;
  detail: string;
  aside: string;
}) {
  return (
    <li>
      <Link
        to={to}
        className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-surface-hover"
      >
        <PersonCell name={person} detail={detail} />
        <span className="shrink-0 text-sm text-text-secondary">{aside}</span>
      </Link>
    </li>
  );
}

function PendingApprovals() {
  const q = useApprovals({ page: 1, pageSize: 5, status: 'pending' });
  return (
    <AttentionList
      title="Waiting for your decision"
      description="Oldest requests first."
      to={`${CENTER_ROOT}/approvals`}
      linkLabel="Open approvals"
      loading={q.isPending}
      error={q.isError ? errorMessage(q.error) : null}
      onRetry={() => q.refetch()}
      empty="Nothing is waiting for you."
    >
      {(q.data?.items ?? []).map((a) => (
        <Row
          key={a.id}
          to={`${CENTER_ROOT}/approvals`}
          person={a.user.displayName}
          detail={a.definition.name}
          aside={`${a.progress.metCount} of ${a.progress.totalCount} met · ${formatRelative(a.requestedAt)}`}
        />
      ))}
    </AttentionList>
  );
}

function ReadyToIssue() {
  const q = useCandidates({ page: 1, pageSize: 5, status: 'eligible,approved' });
  return (
    <AttentionList
      title="Ready to issue"
      description="Requirements are met and nobody has issued the certificate yet."
      to={`${CENTER_ROOT}/issued?view=ready`}
      linkLabel="See everyone ready"
      loading={q.isPending}
      error={q.isError ? errorMessage(q.error) : null}
      onRetry={() => q.refetch()}
      empty="No one is waiting for a certificate."
    >
      {(q.data?.items ?? []).map((c) => (
        <Row
          key={c.id}
          to={`${CENTER_ROOT}/issued?view=ready`}
          person={c.user.displayName}
          detail={c.definition.name}
          aside={c.eligibleAt ? `Ready since ${formatDate(c.eligibleAt)}` : 'Ready'}
        />
      ))}
    </AttentionList>
  );
}

function ExpiringSoon() {
  const q = useCertificates({
    page: 1,
    pageSize: 5,
    status: 'issued',
    expiringWithinDays: 30,
    sort: 'expiresAt',
  });
  return (
    <AttentionList
      title="Expiring in the next 30 days"
      to={`${CENTER_ROOT}/renewals`}
      linkLabel="Expiry and renewals"
      loading={q.isPending}
      error={q.isError ? errorMessage(q.error) : null}
      onRetry={() => q.refetch()}
      empty="No certificates expire in the next 30 days."
    >
      {(q.data?.items ?? []).map((c) => (
        <Row
          key={c.id}
          to={`${CENTER_ROOT}/issued/${c.id}`}
          person={c.recipient.displayName}
          detail={c.definition.name}
          aside={expiryText(c.expiresAt)}
        />
      ))}
    </AttentionList>
  );
}

function Overview() {
  const p = usePermissions();
  const dashboard = useDashboard();
  const d = dashboard.data;
  return (
    <>
      <PageHeader
        title="Certification center"
        description="Where certification stands across the people you can see."
      />
      {dashboard.isPending ? (
        <Skeleton className="mb-8 h-24 w-full" />
      ) : dashboard.isError ? (
        <ErrorState
          className="mb-8"
          message={errorMessage(dashboard.error)}
          onRetry={() => dashboard.refetch()}
        />
      ) : (
        d && (
          <>
            <StatRow className="mb-8">
              <StatCell>
                <StatTile
                  label="Active certificates"
                  value={d.active}
                  context={`${d.issued} issued in total`}
                />
              </StatCell>
              <StatCell>
                <StatTile
                  label="Expiring in 30 days"
                  value={d.expiring.within30}
                  context={`${d.expiring.within60} in 60 · ${d.expiring.within90} in 90`}
                />
              </StatCell>
              <StatCell>
                <StatTile label="Waiting for approval" value={d.pendingApprovals} />
              </StatCell>
              <StatCell>
                <StatTile label="Ready to issue" value={d.eligible} />
              </StatCell>
              <StatCell>
                <StatTile label="Open renewals" value={d.renewalsOpen} />
              </StatCell>
              <StatCell>
                <StatTile label="Revoked this month" value={d.revokedThisMonth} />
              </StatCell>
            </StatRow>
            {d.pdfFailed > 0 && (
              <Notice
                tone="warning"
                title="Some certificate PDFs could not be generated"
                className="mb-8"
              >
                {d.pdfFailed} {d.pdfFailed === 1 ? 'certificate has' : 'certificates have'} no PDF
                yet. Open the certificate from the issued list and choose Retry PDF.
              </Notice>
            )}
          </>
        )
      )}
      {p.has('certificate_approvals.decide') && <PendingApprovals />}
      {p.has('certificates.issue') && <ReadyToIssue />}
      <ExpiringSoon />
    </>
  );
}

/** `/certification-center`: overview for people who can see certificates, else their first available page. */
export function CenterHomePage() {
  const p = usePermissions();
  if (!p.has('certificates.view')) return <CenterIndexRedirect />;
  return (
    <RequirePermission all={['certificates.view']}>
      <Overview />
    </RequirePermission>
  );
}
