import { Link, useParams } from 'react-router';
import {
  Button,
  DescriptionList,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  Panel,
  Section,
  Skeleton,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { formatDate } from '@/lib/format';
import { useMyCertificate, useMyCertifications } from './api';
import { DownloadButton } from './download-button';
import { ISSUE_MODE, REISSUE_REASONS, expiryText } from './labels';
import { renewalAction } from './mine';
import { RequirementChecklist } from './requirement-checklist';
import { CertificateStatus } from './status';
import { VerificationPanel } from './verification-share';

function MyCertificate() {
  const { id = '' } = useParams();
  const cert = useMyCertificate(id);
  const mine = useMyCertifications();

  if (cert.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading certificate" className="grid gap-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (cert.isError) {
    if (cert.error instanceof ApiError && cert.error.isNotFound) {
      return (
        <EmptyState
          title="Certificate not found"
          description="It may belong to someone else or no longer exist. Your own certificates are listed under Certifications."
          action={
            <Button asChild variant="primary">
              <Link to="/certifications">Back to certifications</Link>
            </Button>
          }
        />
      );
    }
    return (
      <ErrorState
        title="This certificate could not be loaded"
        message={errorMessage(cert.error)}
        onRetry={() => cert.refetch()}
      />
    );
  }

  const c = cert.data;
  const item = mine.data?.items.find((i) => i.definition.id === c.definition.id);
  const renewal = item && item.certificate?.id === c.id ? renewalAction(item) : null;
  const revoked = c.effectiveStatus === 'revoked';
  const shareable =
    c.publicVerificationEnabled &&
    (c.effectiveStatus === 'issued' || c.effectiveStatus === 'expired');
  const reissueReason = c.replaces
    ? (REISSUE_REASONS.find((r) => r.value === c.replaces?.reasonCode)?.label ?? 'Corrected')
    : null;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: 'Certifications', to: '/certifications' },
          { label: c.definition.name },
        ]}
        title={c.definition.name}
        meta={
          <>
            <CertificateStatus status={c.effectiveStatus} />
            <span className="font-mono">{c.certificateNumber}</span>
          </>
        }
        actions={!revoked && <DownloadButton certificate={c} mode="owner" variant="primary" />}
      />

      {revoked && (
        <Notice tone="danger" title="This certificate was revoked" className="mb-6 max-w-3xl">
          {c.revocation
            ? `It stopped being valid on ${formatDate(c.revocation.revokedAt)}.`
            : 'It is no longer valid.'}{' '}
          {c.revocation?.publicNote}
        </Notice>
      )}
      {c.replacedBy && (
        <Notice
          tone="information"
          title="A newer certificate replaced this one"
          className="mb-6 max-w-3xl"
        >
          <Link className="underline underline-offset-2" to={`/certifications/${c.replacedBy.id}`}>
            {c.replacedBy.certificateNumber}
          </Link>{' '}
          was issued on {formatDate(c.replacedBy.at)} as a{' '}
          {c.replacedBy.kind === 'renewal' ? 'renewal' : 'reissue'}.
        </Notice>
      )}
      {c.replaces && (
        <Notice
          tone="information"
          title="This certificate replaces an earlier one"
          className="mb-6 max-w-3xl"
        >
          {c.replaces.certificateNumber} was replaced. Reason: {reissueReason?.toLowerCase()}
          {c.replaces.note ? ` (${c.replaces.note})` : ''}.
        </Notice>
      )}

      <Section title="Certificate">
        <Panel>
          <DescriptionList
            columns={3}
            items={[
              { label: 'Awarded to', value: c.recipientName },
              { label: 'Employee ID', value: c.employeeId },
              { label: 'Certification', value: c.definition.name },
              {
                label: 'Program',
                value: c.programNames.length > 0 ? c.programNames.join(', ') : null,
              },
              { label: 'Completed', value: c.completionDate ? formatDate(c.completionDate) : null },
              { label: 'Issued', value: formatDate(c.issuedAt) },
              { label: 'Validity', value: expiryText(c.expiresAt) },
              { label: 'Issued by', value: c.issuer },
              {
                label: 'Signed by',
                value:
                  c.signatories.length > 0
                    ? c.signatories.map((s) => `${s.name}, ${s.title}`).join('; ')
                    : null,
              },
              { label: 'How it was issued', value: ISSUE_MODE[c.mode] },
            ]}
          />
        </Panel>
      </Section>

      {renewal?.kind === 'renew' && item?.progress && (
        <Section title="Renewal">
          <Panel>
            <p className="mb-3 text-sm text-text-secondary">
              Complete these requirements to receive a new certificate.
            </p>
            <RequirementChecklist
              heading="Renewal requirements"
              requirements={item.progress.requirements}
              metCount={item.progress.metCount}
              totalCount={item.progress.totalCount}
            />
            <Button asChild variant="primary" className="mt-4">
              <Link to="/training">Go to training</Link>
            </Button>
          </Panel>
        </Section>
      )}
      {renewal?.kind === 'waiting' && (
        <Notice tone="information" className="mb-6 max-w-3xl">
          {renewal.message}
        </Notice>
      )}

      <Section
        title="Verify this certificate"
        description="Share the link or QR code with a customer, partner or employer."
      >
        <Panel>
          {shareable ? (
            <VerificationPanel url={c.verificationUrl} certificateNumber={c.certificateNumber} />
          ) : (
            <p className="text-sm text-text-secondary">
              {revoked
                ? 'A revoked certificate cannot be shared. Anyone who checks it will see that it was revoked.'
                : c.publicVerificationEnabled
                  ? 'This certificate has been replaced, so its link is no longer offered for sharing.'
                  : 'Public verification is turned off for this certification.'}
            </p>
          )}
        </Panel>
      </Section>
    </>
  );
}

export function MyCertificatePage() {
  return (
    <RequirePermission all={['certificates.view_own']}>
      <MyCertificate />
    </RequirePermission>
  );
}
