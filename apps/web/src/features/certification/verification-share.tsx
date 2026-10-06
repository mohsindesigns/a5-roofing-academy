import { useState } from 'react';
import { Copy, Download, ExternalLink } from 'lucide-react';
import QRCode from 'qrcode';
import { Button, DialogContent, DialogRoot, Input, toast } from '@/components/ui';
import { QrCode } from './qr-code';

/** Copy text; falls back to selecting the field so the person can copy by hand. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verification link, copy button and QR code. Anyone with the link can see the public
 * verification page; nothing else about the certificate holder is exposed through it.
 */
export function VerificationPanel({
  url,
  certificateNumber,
  audience = 'holder',
  className,
}: {
  url: string;
  certificateNumber: string | null;
  /** Whose point of view the explanation takes: the certificate holder or an administrator. */
  audience?: 'holder' | 'admin';
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const qrLabel = certificateNumber
    ? `QR code that opens the verification page for certificate ${certificateNumber}`
    : 'QR code that opens the verification page';

  const copy = async () => {
    if (await copyText(url)) {
      setCopied(true);
      toast.success('Verification link copied');
      window.setTimeout(() => setCopied(false), 2500);
    } else {
      toast.error(
        'Could not copy automatically',
        'Select the link and copy it with your keyboard.',
      );
    }
  };

  const saveQr = async () => {
    try {
      const dataUrl = await QRCode.toDataURL(url, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 640,
      });
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `${certificateNumber ?? 'certificate'}-verification-qr.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      toast.error('Could not save the QR code', 'Take a screenshot of the code instead.');
    }
  };

  return (
    <div className={className}>
      <div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-start">
        <div className="w-fit rounded-lg border border-border bg-white p-2">
          <QrCode value={url} size={152} label={qrLabel} />
        </div>
        <div className="min-w-0">
          <label htmlFor="verification-link" className="text-sm font-medium text-text-primary">
            Verification link
          </label>
          <div className="mt-1.5 flex gap-2">
            <Input
              id="verification-link"
              readOnly
              value={url}
              className="font-mono text-sm"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              onClick={copy}
              leading={<Copy className="size-4" />}
              aria-label="Copy verification link"
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="mt-2 text-sm text-text-secondary">
            {audience === 'holder'
              ? 'Anyone with this link or QR code can confirm the certificate is genuine. It shows your name, the certification, its dates and whether it is still valid, and nothing else.'
              : 'Anyone with this link or QR code can check the certificate. The page shows the holder’s name, the certification, its dates and its status, and nothing else.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button asChild>
              <a href={url} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden className="size-4" />
                Open verification page
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
            <Button onClick={saveQr} leading={<Download className="size-4" />}>
              Save QR code
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ShareDialog({
  open,
  onOpenChange,
  url,
  title,
  certificateNumber,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  title: string;
  certificateNumber: string | null;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Share verification link"
        description={title}
        size="md"
        footer={<Button onClick={() => onOpenChange(false)}>Done</Button>}
      >
        <VerificationPanel url={url} certificateNumber={certificateNumber} />
      </DialogContent>
    </DialogRoot>
  );
}
