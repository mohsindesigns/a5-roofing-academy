import { Download } from 'lucide-react';
import { Button, toast } from '@/components/ui';
import { errorMessage } from '@/lib/api/errors';
import { useDownloadCertificate } from './api';
import type { CertificateSummary } from './types';

/**
 * Downloads the certificate PDF through a short-lived signed link. The button reflects the PDF's
 * state so nobody clicks into an error: the PDF is rendered in the background after issuance.
 */
export function DownloadButton({
  certificate,
  mode,
  variant = 'secondary',
  size = 'md',
}: {
  certificate: Pick<CertificateSummary, 'id' | 'pdfStatus'>;
  mode: 'owner' | 'admin';
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md';
}) {
  const download = useDownloadCertificate(mode);
  const unavailable = certificate.pdfStatus !== 'ready';
  const label =
    certificate.pdfStatus === 'pending'
      ? 'PDF is being prepared'
      : certificate.pdfStatus === 'failed'
        ? 'PDF unavailable'
        : 'Download PDF';
  return (
    <Button
      variant={variant}
      size={size}
      loading={download.isPending}
      disabled={unavailable}
      leading={<Download className="size-4" />}
      onClick={() =>
        download.mutate(certificate.id, {
          onError: (err) => toast.error('Could not download the PDF', errorMessage(err)),
        })
      }
    >
      {label}
    </Button>
  );
}
