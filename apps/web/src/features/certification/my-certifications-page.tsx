import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Share2 } from 'lucide-react';
import { Button, EmptyState, ErrorState, Notice, PageHeader, Skeleton, Tag } from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { errorMessage } from '@/lib/api/errors';
import { formatDate } from '@/lib/format';
import { useMyCertifications } from './api';
import { DownloadButton } from './download-button';
import { MY_STATE, expiryText } from './labels';
import { renewalAction, showsChecklist, sortMine } from './mine';
import { RequirementChecklist } from './requirement-checklist';
import { MyStateStatus } from './status';
import type { MyCertificationItem } from './types';
import { ShareDialog } from './verification-share';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-text-tertiary">{label}</dt>
      <dd className="mt-0.5 text-sm text-text-primary">{children}</dd>
    </div>
  );
}

function CertificationRow({ item }: { item: MyCertificationItem }) {
  const [sharing, setSharing] = useState(false);
  const cert = item.certificate;
  const info = MY_STATE[item.state];
  const renewal = renewalAction(item);
  const valid =
    item.state === 'active' || item.state === 'expiring' || item.state === 'renewal_required';
  return (
    <li className="px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold">
              {cert ? (
                <Link to={`/certifications/${cert.id}`} className="hover:underline">
                  {item.definition.name}
                </Link>
              ) : (
                item.definition.name
              )}
            </h2>
            <MyStateStatus state={item.state} />
            {item.definition.badge.label && <Tag>{item.definition.badge.label}</Tag>}
          </div>
          {item.definition.publicDescription && (
            <p className="mt-1 max-w-[70ch] text-sm text-text-secondary">
              {item.definition.publicDescription}
            </p>
          )}
          <p className="mt-1 text-sm text-text-secondary">{info.hint}</p>
          {cert && (
            <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
              <Fact label="Certificate number">
                <span className="font-mono text-sm">{cert.certificateNumber}</span>
              </Fact>
              <Fact label="Issued">{formatDate(cert.issuedAt)}</Fact>
              {item.state === 'revoked' && cert.revokedAt ? (
                <Fact label="Revoked">{formatDate(cert.revokedAt)}</Fact>
              ) : (
                <Fact label="Validity">{expiryText(cert.expiresAt)}</Fact>
              )}
            </dl>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {cert && item.state !== 'revoked' && <DownloadButton certificate={cert} mode="owner" />}
          {valid && item.verificationUrl && (
            <Button leading={<Share2 className="size-4" />} onClick={() => setSharing(true)}>
              Share
            </Button>
          )}
          {cert && (
            <Button asChild trailing={<ArrowRight className="size-4" />}>
              <Link to={`/certifications/${cert.id}`}>Details</Link>
            </Button>
          )}
        </div>
      </div>

      {renewal?.kind === 'renew' && (
        <Notice
          tone="warning"
          title={item.state === 'expired' ? 'Renew to certify again' : 'Renew before this expires'}
          className="mt-4 max-w-2xl"
          action={
            <Button asChild variant="primary" size="sm">
              <Link to="/training">Go to training</Link>
            </Button>
          }
        >
          {renewal.requirementsLeft > 0
            ? `${renewal.requirementsLeft} renewal ${renewal.requirementsLeft === 1 ? 'requirement is' : 'requirements are'} still open.`
            : 'Complete the renewal requirements below.'}
        </Notice>
      )}
      {renewal?.kind === 'waiting' && (
        <Notice tone="information" className="mt-4 max-w-2xl">
          {renewal.message}
        </Notice>
      )}

      {showsChecklist(item) && item.progress && (
        <RequirementChecklist
          className="mt-4 max-w-2xl"
          heading={item.progress.purpose === 'renewal' ? 'Renewal requirements' : 'Requirements'}
          requirements={item.progress.requirements}
          metCount={item.progress.metCount}
          totalCount={item.progress.totalCount}
        />
      )}
      {item.progress?.onHold && item.progress.holdReason && (
        <Notice tone="warning" title="On hold" className="mt-4 max-w-2xl">
          {item.progress.holdReason}. Ask your manager if you have questions.
        </Notice>
      )}

      {sharing && item.verificationUrl && cert && (
        <ShareDialog
          open
          onOpenChange={setSharing}
          url={item.verificationUrl}
          title={item.definition.name}
          certificateNumber={cert.certificateNumber}
        />
      )}
    </li>
  );
}

function MyCertifications() {
  const mine = useMyCertifications();
  return (
    <>
      <PageHeader
        title="Certifications"
        description="Your certificates, what is left to earn the next one, and a link anyone can use to verify them."
      />
      {mine.isPending ? (
        <div aria-busy="true" aria-label="Loading your certifications" className="grid gap-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : mine.isError ? (
        <ErrorState
          title="Your certifications could not be loaded"
          message={errorMessage(mine.error)}
          onRetry={() => mine.refetch()}
        />
      ) : mine.data.items.length === 0 ? (
        <EmptyState
          title="No certifications yet"
          description="Certifications appear here once you are enrolled in a program that leads to one."
          action={
            <Button asChild variant="primary">
              <Link to="/training">Go to training</Link>
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-divider overflow-hidden rounded-lg border border-border bg-surface">
          {sortMine(mine.data.items).map((item) => (
            <CertificationRow key={item.definition.id} item={item} />
          ))}
        </ul>
      )}
    </>
  );
}

export function MyCertificationsPage() {
  return (
    <RequirePermission all={['certificates.view_own']}>
      <MyCertifications />
    </RequirePermission>
  );
}
