import { RotateCw, X } from 'lucide-react';
import { Button, IconButton, ProgressBar, Spinner, StatusText } from '@/components/ui';
import { formatFileSize } from './upload';
import { useUploads, type UploadItem } from './upload-manager';

function Row({ item }: { item: UploadItem }) {
  const cancel = useUploads((s) => s.cancel);
  const retry = useUploads((s) => s.retry);
  const dismiss = useUploads((s) => s.dismiss);
  const percent = item.file.size ? (item.loaded / item.file.size) * 100 : 0;
  return (
    <li className="grid gap-1 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,220px)_auto] sm:items-center sm:gap-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{item.title}</p>
        <p className="text-xs text-text-tertiary">{formatFileSize(item.file.size)}</p>
      </div>
      <div className="min-w-0">
        {item.stage === 'uploading' || item.stage === 'queued' ? (
          <ProgressBar value={percent} label={`Uploading ${item.title}`} showValue size="md" />
        ) : item.stage === 'verifying' ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-text-secondary">
            <Spinner size={14} /> Checking the file…
          </span>
        ) : item.stage === 'done' ? (
          <StatusText tone="success">Uploaded. Processing continues in the library.</StatusText>
        ) : item.stage === 'cancelled' ? (
          <StatusText tone="neutral">Cancelled</StatusText>
        ) : (
          <p role="alert" className="text-sm text-danger">
            {item.error ?? 'The upload failed.'}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-1">
        {(item.stage === 'uploading' || item.stage === 'queued') && (
          <Button size="sm" onClick={() => cancel(item.id)}>
            Cancel
            <span className="sr-only"> upload of {item.title}</span>
          </Button>
        )}
        {(item.stage === 'failed' || item.stage === 'cancelled') && (
          <Button
            size="sm"
            leading={<RotateCw className="size-3.5" />}
            onClick={() => retry(item.id)}
          >
            Try again
            <span className="sr-only"> {item.title}</span>
          </Button>
        )}
        {(item.stage === 'failed' || item.stage === 'cancelled' || item.stage === 'done') && (
          <IconButton label={`Dismiss ${item.title}`} size="sm" onClick={() => dismiss(item.id)}>
            <X className="size-4" />
          </IconButton>
        )}
      </div>
    </li>
  );
}

/** Uploads started in this browser session. They keep running while you browse other pages. */
export function UploadsPanel() {
  const items = useUploads((s) => s.items);
  if (items.length === 0) return null;
  return (
    <section
      aria-labelledby="uploads-heading"
      className="mb-5 rounded-lg border border-border bg-surface px-4 py-3"
    >
      <h2 id="uploads-heading" className="text-sm font-semibold">
        Uploads
      </h2>
      <ul className="divide-y divide-divider" aria-live="polite">
        {items.map((i) => (
          <Row key={i.id} item={i} />
        ))}
      </ul>
      <p className="mt-1 text-xs text-text-tertiary">
        Large files upload in one piece. If a transfer is interrupted, use Try again to resend it.
      </p>
    </section>
  );
}
