import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Ban, FilePlus2, RotateCw } from 'lucide-react';
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
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { usePermissions } from '@/features/auth/session';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { formatDate, formatDateTime } from '@/lib/format';
import { useCertificate, useCertificateEvents, useRetryPdf } from '../api';
import { DownloadButton } from '../download-button';
import { ISSUE_MODE, REISSUE_REASONS, expiryText } from '../labels';
import { CertificateStatus, PdfStatusText } from '../status';
import type { CertificateDetail, CertificateEvent } from '../types';
import { VerificationPanel } from '../verification-share';
import { ReissueDialog, RevokeDialog } from './certificate-dialogs';
import { CENTER_ROOT } from './nav';

const EVENT_LABEL: Record<string, string> = {
  issued: 'Issued',
  pdf_generated: 'PDF generated',
  pdf_failed: 'PDF generation failed',
  downloaded: 'PDF downloaded',
  revoked: 'Revoked',
  reissued: 'Reissued',
  superseded: 'Replaced by a newer certificate',
  expired: 'Expired',
  expiry_reminder: 'Expiry reminder sent',
  renewal_opened: 'Renewal window opened',
  renewal_lapsed: 'Renewal lapsed',
  renewed: 'Renewed',
};

export function eventLabel(type: string): string {
  const known = EVENT_LABEL[type];
  if (known) return known;
  const words = type.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One-line detail for the events whose data an administrator needs at a glance. */
export function eventDetail(e: CertificateEvent): string | null {
  const reason = e.data['reason'];
  if (e.type === 'revoked' && typeof reason === 'string') return reason;
  const note = e.data['note'];
  if (e.type === 'reissued' && typeof note === 'string') return note;
  const by = e.data['by'];
  if (e.type === 'downloaded' && typeof by === 'string') {
    return by === 'owner'
      ? 'Downloaded by the certificate holder'
      : 'Downloaded by an administrator';
  }
  return null;
}

function Timeline({ id }: { id: string }) {
  const events = useCertificateEvents(id);
  if (events.isPending) return <Skeleton className="h-24 w-full" />;
  if (events.isError) {
    return <ErrorState message={errorMessage(events.error)} onRetry={() => events.refetch()} />;
  }
  if (events.data.items.length === 0) {
    return <p className="text-sm text-text-secondary">No activity recorded yet.</p>;
  }
  return (
    <ol className="divide-y divide-divider rounded-lg border border-border bg-surface">
      {events.data.items.map((e) => {
        const detail = eventDetail(e);
        return (
          <li
            key={e.id}
            className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5 px-4 py-2.5"
          >
            <div className="min-w-0">
              <p className="text-base font-medium">{eventLabel(e.type)}</p>
              {detail && <p className="text-sm text-text-secondary">{detail}</p>}
            </div>
            <p className="text-sm text-text-secondary">
              {e.actor.displayName ? `${e.actor.displayName} · ` : ''}
              <time dateTime={e.occurredAt}>{formatDateTime(e.occurredAt)}</time>
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function Details({ c }: { c: CertificateDetail }) {
  const permissions = usePermissions();
  const [revoking, setRevoking] = useState(false);
  const [reissuing, setReissuing] = useState(false);
  const retry = useRetryPdf(c.id);
  const status = c.effectiveStatus;
  const canRevoke =
    permissions.has('certificates.revoke') && (status === 'issued' || status === 'expired');
  const canReissue = permissions.has('certificates.reissue') && status === 'issued';
  const canRetry = permissions.has('certificates.reissue') && c.pdfStatus !== 'ready';
  const reissueReason = c.replaces
    ? (REISSUE_REASONS.find((r) => r.value === c.replaces?.reasonCode)?.label ?? 'Corrected')
    : null;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: 'Certification center', to: CENTER_ROOT },
          { label: 'Issued', to: `${CENTER_ROOT}/issued` },
          { label: c.certificateNumber },
        ]}
        title={c.recipientName}
        description={c.definition.name}
        meta={
          <>
            <CertificateStatus status={status} />
            <span className="font-mono">{c.certificateNumber}</span>
          </>
        }
        actions={
          <>
            {status !== 'revoked' && <DownloadButton certificate={c} mode="admin" />}
            {canReissue && (
              <Button leading={<FilePlus2 className="size-4" />} onClick={() => setReissuing(true)}>
                Reissue
              </Button>
            )}
            {canRevoke && (
              <Button
                variant="danger"
                leading={<Ban className="size-4" />}
                onClick={() => setRevoking(true)}
              >
                Revoke
              </Button>
            )}
          </>
        }
      />

      {status === 'revoked' && c.revocation && (
        <Notice
          tone="danger"
          title={`Revoked ${formatDate(c.revocation.revokedAt)}`}
          className="mb-6 max-w-3xl"
        >
          <p>{c.revocation.reason}</p>
          {c.revocation.publicNote && (
            <p className="mt-1">Shown publicly: &ldquo;{c.revocation.publicNote}&rdquo;</p>
          )}
          {c.revocation.revokedBy && (
            <p className="mt-1">By {c.revocation.revokedBy.displayName}.</p>
          )}
        </Notice>
      )}
      {c.replacedBy && (
        <Notice
          tone="information"
          title="Replaced by a newer certificate"
          className="mb-6 max-w-3xl"
        >
          <Link
            className="underline underline-offset-2"
            to={`${CENTER_ROOT}/issued/${c.replacedBy.id}`}
          >
            {c.replacedBy.certificateNumber}
          </Link>{' '}
          was issued on {formatDate(c.replacedBy.at)} as a{' '}
          {c.replacedBy.kind === 'renewal' ? 'renewal' : 'reissue'}.
        </Notice>
      )}
      {c.replaces && (
        <Notice
          tone="information"
          title="Replaces an earlier certificate"
          className="mb-6 max-w-3xl"
        >
          <Link
            className="underline underline-offset-2"
            to={`${CENTER_ROOT}/issued/${c.replaces.id}`}
          >
            {c.replaces.certificateNumber}
          </Link>
          : {reissueReason?.toLowerCase()}. {c.replaces.note}
        </Notice>
      )}
      {c.pdfStatus === 'failed' && (
        <Notice
          tone="danger"
          title="The PDF could not be generated"
          className="mb-6 max-w-3xl"
          action={
            canRetry && (
              <Button
                size="sm"
                loading={retry.isPending}
                leading={<RotateCw className="size-3.5" />}
                onClick={() =>
                  retry.mutate(undefined, {
                    onSuccess: () => toast.success('PDF queued again'),
                    onError: (err) => toast.error('Could not retry', errorMessage(err)),
                  })
                }
              >
                Retry PDF
              </Button>
            )
          }
        >
          The person cannot download this certificate until it is generated.
        </Notice>
      )}
      {c.pdfStatus === 'pending' && canRetry && (
        <Notice
          tone="information"
          title="The PDF is still being prepared"
          className="mb-6 max-w-3xl"
          action={
            <Button
              size="sm"
              loading={retry.isPending}
              onClick={() =>
                retry.mutate(undefined, {
                  onSuccess: () => toast.success('PDF queued again'),
                  onError: (err) => toast.error('Could not retry', errorMessage(err)),
                })
              }
            >
              Queue again
            </Button>
          }
        >
          This usually takes a few seconds. Queue it again if it stays this way.
        </Notice>
      )}

      <Section title="Certificate">
        <Panel>
          <DescriptionList
            columns={3}
            items={[
              { label: 'Recipient', value: c.recipientName },
              { label: 'Employee ID', value: c.employeeId },
              { label: 'Certification', value: c.definition.name },
              { label: 'Program', value: c.programNames.join(', ') || null },
              { label: 'Completed', value: c.completionDate ? formatDate(c.completionDate) : null },
              { label: 'Issued', value: formatDateTime(c.issuedAt) },
              { label: 'Validity', value: expiryText(c.expiresAt) },
              { label: 'Issuing organization', value: c.issuer },
              { label: 'How it was issued', value: ISSUE_MODE[c.mode] },
              { label: 'Issued by', value: c.issuedBy?.displayName ?? 'System' },
              {
                label: 'Signed by',
                value: c.signatories.map((s) => `${s.name}, ${s.title}`).join('; ') || null,
              },
              { label: 'Template version', value: `Version ${c.template.version}` },
              { label: 'PDF', value: <PdfStatusText status={c.pdfStatus} /> },
              {
                label: 'PDF generated',
                value: c.pdfGeneratedAt ? formatDateTime(c.pdfGeneratedAt) : null,
              },
              {
                label: 'PDF checksum',
                value: c.pdfSha256 ? (
                  <span className="font-mono text-xs break-all">{c.pdfSha256}</span>
                ) : null,
              },
              ...(c.overrideReason
                ? [{ label: 'Requirements override reason', value: c.overrideReason }]
                : []),
            ]}
          />
        </Panel>
      </Section>

      {c.renewal && (
        <Section title="Renewal">
          <Panel>
            <DescriptionList
              columns={3}
              items={[
                {
                  label: 'Status',
                  value: c.renewal.status.charAt(0).toUpperCase() + c.renewal.status.slice(1),
                },
                { label: 'Window opened', value: formatDate(c.renewal.windowOpenedAt) },
                { label: 'Due', value: c.renewal.dueAt ? formatDate(c.renewal.dueAt) : null },
                {
                  label: 'Completed',
                  value: c.renewal.completedAt ? formatDate(c.renewal.completedAt) : null,
                },
              ]}
            />
          </Panel>
        </Section>
      )}

      <Section
        title="Verification"
        description={
          c.publicVerificationEnabled
            ? 'The public page anyone can use to check this certificate.'
            : 'Public verification is turned off for this certification.'
        }
      >
        {c.publicVerificationEnabled && (
          <Panel>
            <VerificationPanel url={c.verificationUrl} certificateNumber={c.certificateNumber} />
          </Panel>
        )}
      </Section>

      <Section title="Activity">
        <Timeline id={c.id} />
      </Section>

      {revoking && <RevokeDialog certificate={c} open onOpenChange={setRevoking} />}
      {reissuing && <ReissueDialog certificate={c} open onOpenChange={setReissuing} />}
    </>
  );
}

function IssuedDetail() {
  const { id = '' } = useParams();
  const cert = useCertificate(id);
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
          description="It may not exist, or it belongs to someone outside your scope."
          action={
            <Button asChild variant="primary">
              <Link to={`${CENTER_ROOT}/issued`}>Back to issued certificates</Link>
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
  return <Details c={cert.data} />;
}

export function IssuedDetailPage() {
  return (
    <RequirePermission all={['certificates.view']}>
      <IssuedDetail />
    </RequirePermission>
  );
}
