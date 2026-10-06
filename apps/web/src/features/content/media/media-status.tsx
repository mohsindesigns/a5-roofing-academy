import { useState } from 'react';
import { FileText, Film, Image as ImageIcon, Subtitles } from 'lucide-react';
import type { media } from '@a5/contracts';
import { StatusText, type Tone } from '@/components/ui';
import { cn } from '@/lib/cn';

export const STATUS: Record<media.MediaStatus, { label: string; tone: Tone }> = {
  awaiting_upload: { label: 'Waiting for upload', tone: 'neutral' },
  uploaded: { label: 'Uploaded', tone: 'information' },
  scanning: { label: 'Checking file', tone: 'information' },
  processing: { label: 'Processing', tone: 'information' },
  ready: { label: 'Ready', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  rejected: { label: 'Rejected', tone: 'danger' },
  archived: { label: 'Archived', tone: 'neutral' },
};

export const KIND_LABEL: Record<media.MediaKind, string> = {
  video: 'Video',
  document: 'Document',
  image: 'Image',
  caption: 'Captions',
};

export function MediaStatus({ status }: { status: media.MediaStatus }) {
  const s = STATUS[status];
  return <StatusText tone={s.tone}>{s.label}</StatusText>;
}

const ICON = { video: Film, document: FileText, image: ImageIcon, caption: Subtitles };

/** Poster frame, or an icon for the kind while there is none (documents, or still processing). */
export function MediaThumb({
  asset,
  className,
}: {
  asset: Pick<media.MediaAssetSummary, 'kind' | 'thumbnailUrl'>;
  className?: string;
}) {
  const Icon = ICON[asset.kind];
  // Signed poster URLs can expire or point at a file that is not there; fall back to the icon.
  const [broken, setBroken] = useState(false);
  return (
    <span
      className={cn(
        'flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-surface-sunken text-text-tertiary',
        className,
      )}
    >
      {asset.thumbnailUrl && !broken ? (
        <img
          src={asset.thumbnailUrl}
          alt=""
          loading="lazy"
          className="size-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <Icon aria-hidden className="size-4" />
      )}
    </span>
  );
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}
