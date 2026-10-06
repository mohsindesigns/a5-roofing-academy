import { useState } from 'react';
import { Link } from 'react-router';
import { Search } from 'lucide-react';
import {
  Button,
  DialogContent,
  DialogRoot,
  EmptyState,
  ErrorState,
  Input,
  Pagination,
  Skeleton,
} from '@/components/ui';
import { useCan } from '@/features/auth/session';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { errorMessage } from '@/lib/api/errors';
import { useMediaAsset, useMediaList } from './api';
import { KIND_LABEL, MediaStatus, MediaThumb, formatDuration } from './media-status';
import { formatFileSize } from './upload';

type PickerKind = 'video' | 'document' | 'image';

function Chooser({
  kind,
  open,
  onOpenChange,
  onPick,
}: {
  kind: PickerKind;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onPick: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebouncedValue(search, 250);
  const list = useMediaList(
    { kind, status: 'ready', q: q.trim() || undefined, sort: 'title', page, pageSize: 8 },
    open,
  );
  const canUpload = useCan('media.upload');
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title={`Choose ${kind === 'image' ? 'an image' : kind === 'video' ? 'a video' : 'a document'}`}
        description="Only files that finished processing can be used in lessons."
      >
        <Input
          type="search"
          aria-label="Search the library"
          placeholder="Search by title"
          leading={<Search className="size-4" />}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <div className="mt-3">
          {list.isPending ? (
            <Skeleton className="h-48 w-full" />
          ) : list.isError ? (
            <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />
          ) : list.data.items.length === 0 ? (
            <EmptyState
              title={
                q
                  ? 'Nothing matches that search'
                  : `No ${KIND_LABEL[kind].toLowerCase()}s are ready yet`
              }
              description={
                canUpload ? (
                  <>
                    Upload one in the{' '}
                    <Link
                      to="/content/media"
                      className="text-information underline"
                      target="_blank"
                      rel="noreferrer"
                    >
                      media library
                    </Link>{' '}
                    (opens in a new tab), then come back.
                  </>
                ) : (
                  'Ask someone who can upload media to add one.'
                )
              }
            />
          ) : (
            <>
              <ul className="divide-y divide-divider border-y border-divider">
                {list.data.items.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 px-1 py-2 text-left hover:bg-surface-hover"
                      onClick={() => {
                        onPick(a.id);
                        onOpenChange(false);
                      }}
                    >
                      <MediaThumb asset={a} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{a.title}</span>
                        <span className="block truncate text-xs text-text-tertiary">
                          {a.originalFilename} · {formatFileSize(a.sizeBytes)}
                          {a.durationSeconds !== null && ` · ${formatDuration(a.durationSeconds)}`}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <Pagination
                page={list.data.page}
                pageCount={list.data.pageCount}
                total={list.data.total}
                pageSize={list.data.pageSize}
                onPage={setPage}
                noun="files"
              />
            </>
          )}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

/**
 * Picks a ready file from the media library for a lesson. Shows what is currently selected
 * (title and duration) rather than an id.
 */
export function MediaPicker({
  kind,
  value,
  onChange,
  invalid,
  id,
}: {
  kind: PickerKind;
  value: string | null;
  onChange: (id: string | null) => void;
  invalid?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const asset = useMediaAsset(value);
  return (
    <div>
      {value ? (
        <div className="flex items-center gap-3 rounded border border-border-strong px-2 py-1.5">
          {asset.data ? <MediaThumb asset={asset.data} /> : <Skeleton className="h-9 w-16" />}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {asset.data?.title ?? (asset.isError ? 'File not available' : 'Loading…')}
            </p>
            {asset.data && (
              <p className="text-xs text-text-tertiary">
                <MediaStatus status={asset.data.status} />
              </p>
            )}
            {asset.isError && (
              <p className="text-xs text-danger">
                This file was removed or you cannot see it. Choose another.
              </p>
            )}
          </div>
          <Button size="sm" id={id} onClick={() => setOpen(true)}>
            Change
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            Remove
          </Button>
        </div>
      ) : (
        <Button id={id} aria-invalid={invalid || undefined} onClick={() => setOpen(true)}>
          Choose from library
        </Button>
      )}
      <Chooser kind={kind} open={open} onOpenChange={setOpen} onPick={onChange} />
    </div>
  );
}
