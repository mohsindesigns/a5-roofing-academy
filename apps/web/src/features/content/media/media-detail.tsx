import { useRef, useState } from 'react';
import { Archive, Download, Pencil, Plus, Trash2 } from 'lucide-react';
import type { media } from '@a5/contracts';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  DescriptionList,
  DialogRoot,
  ErrorState,
  Field,
  IconButton,
  Input,
  Notice,
  ProgressBar,
  SheetContent,
  Skeleton,
  StatusText,
  Textarea,
  toast,
} from '@/components/ui';
import { useCan } from '@/features/auth/session';
import { VideoPlayer, formatClock, type PlayerSource } from '@/features/media/video-player';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';
import {
  useArchiveMedia,
  useCaptions,
  useChapters,
  useMediaAsset,
  useMediaPreview,
  useUpdateMedia,
} from './api';
import { KIND_LABEL, MediaStatus, STATUS, formatDuration } from './media-status';
import { formatFileSize, parseClock } from './upload';
import { uploadCaptions } from './upload-manager';

// ------------------------------------------------------------------ preview

function toSource(d: media.PlaybackDescriptor): PlayerSource | null {
  if (d.kind === 'document') return null;
  return {
    kind: d.kind,
    url: d.url,
    posterUrl: d.posterUrl,
    durationSeconds: d.durationSeconds,
    captions: d.captions.map((c) => ({
      language: c.language,
      label: c.label,
      url: c.url,
      isDefault: c.isDefault,
    })),
    chapters: d.chapters.map((c) => ({ startSeconds: c.startSeconds, title: c.title })),
    resume: null,
  };
}

function Preview({ asset }: { asset: media.MediaAssetDetail }) {
  const [show, setShow] = useState(false);
  const preview = useMediaPreview(asset.id, show);
  if (asset.status !== 'ready') return null;
  if (asset.kind === 'image' && asset.thumbnailUrl) {
    return (
      <img
        src={asset.thumbnailUrl}
        alt={asset.title}
        className="max-h-64 rounded border border-border"
      />
    );
  }
  if (asset.kind === 'document') {
    return asset.downloadUrl ? (
      <Button asChild leading={<Download className="size-4" />}>
        <a href={asset.downloadUrl} download={asset.originalFilename}>
          Download original
        </a>
      </Button>
    ) : null;
  }
  if (asset.kind !== 'video') return null;
  const source = preview.data ? toSource(preview.data) : null;
  return (
    <div>
      {!show ? (
        <Button onClick={() => setShow(true)}>Preview video</Button>
      ) : preview.isPending ? (
        <Skeleton className="aspect-video w-full" />
      ) : preview.isError ? (
        <ErrorState
          title="Preview unavailable"
          message={errorMessage(preview.error)}
          onRetry={() => preview.refetch()}
        />
      ) : source ? (
        <VideoPlayer
          // Previews never record watch progress or enforce lesson rules.
          source={source}
          policy={{ allowSkipping: true, maxCreditedPlaybackRate: 4 }}
          title={asset.title}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ details

function DetailsForm({ asset, canEdit }: { asset: media.MediaAssetDetail; canEdit: boolean }) {
  const update = useUpdateMedia(asset.id);
  const [title, setTitle] = useState(asset.title);
  const [description, setDescription] = useState(asset.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const dirty = title !== asset.title || description !== (asset.description ?? '');
  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await update.mutateAsync({
            title: title.trim(),
            description: description.trim() || null,
          });
          toast.success('Details saved');
        } catch (err) {
          setError(
            err instanceof ApiError && err.fields.length
              ? err.fields.map((f) => f.message).join(' ')
              : errorMessage(err),
          );
        }
      }}
    >
      <Field label="Title" required>
        <Input
          value={title}
          maxLength={200}
          disabled={!canEdit}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label="Description" optional>
        <Textarea
          rows={3}
          value={description}
          maxLength={2000}
          disabled={!canEdit}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      {error && (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {canEdit && (
        <div>
          <Button
            type="submit"
            variant="primary"
            loading={update.isPending}
            disabled={!dirty || !title.trim()}
          >
            Save details
          </Button>
        </div>
      )}
    </form>
  );
}

// ------------------------------------------------------------------ captions

const LANGUAGE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

function AddCaptions({ videoId, onDone }: { videoId: string; onDone: () => void }) {
  const [language, setLanguage] = useState('en');
  const [label, setLabel] = useState('English');
  const [isDefault, setIsDefault] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const languageError = LANGUAGE.test(language.trim())
    ? undefined
    : 'Use a language code such as en or es-US.';
  const fileError =
    file && !/\.vtt$/i.test(file.name) ? 'Captions must be a WebVTT (.vtt) file.' : undefined;
  const busy = progress !== null;
  return (
    <form
      className="mt-3 grid gap-3 rounded-lg border border-border p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!file || languageError || fileError || !label.trim()) return;
        setError(null);
        setProgress(0);
        try {
          await uploadCaptions(
            videoId,
            { file, language: language.trim(), label: label.trim(), isDefault },
            (loaded, total) => setProgress(total ? (loaded / total) * 100 : 0),
          );
          toast.success('Captions added', 'They are checked before viewers can select them.');
          onDone();
        } catch (err) {
          setError(errorMessage(err));
          setProgress(null);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Language code" error={languageError} hint="For example en, es or es-US.">
          <Input value={language} disabled={busy} onChange={(e) => setLanguage(e.target.value)} />
        </Field>
        <Field label="Name shown to viewers">
          <Input
            value={label}
            maxLength={80}
            disabled={busy}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
      </div>
      <Field label="WebVTT file" error={fileError}>
        <input
          ref={input}
          type="file"
          accept=".vtt,text/vtt"
          disabled={busy}
          className="block w-full text-sm file:mr-3 file:rounded file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      <label className="flex items-center gap-2.5 text-sm">
        <Checkbox
          checked={isDefault}
          disabled={busy}
          onCheckedChange={(c) => setIsDefault(c === true)}
        />
        Show these captions by default
      </label>
      {progress !== null && <ProgressBar value={progress} label="Uploading captions" showValue />}
      {error && (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={!file || Boolean(languageError || fileError) || !label.trim()}
        >
          Upload captions
        </Button>
        <Button disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Captions({ asset, canEdit }: { asset: media.MediaAssetDetail; canEdit: boolean }) {
  const captions = useCaptions(asset.id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<media.Caption | null>(null);
  return (
    <section aria-labelledby="media-captions">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 id="media-captions" className="text-md font-semibold">
          Captions
        </h3>
        {canEdit && !adding && (
          <Button size="sm" leading={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
            Add captions
          </Button>
        )}
      </div>
      {asset.captions.length === 0 && !adding ? (
        <p className="text-sm text-text-secondary">
          No captions yet. Viewers who need them cannot follow this video without them.
        </p>
      ) : (
        <ul className="divide-y divide-divider border-y border-divider">
          {asset.captions.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {c.label} <span className="font-normal text-text-tertiary">({c.language})</span>
                </p>
                <p className="text-xs">
                  <StatusText tone={STATUS[c.status].tone}>{STATUS[c.status].label}</StatusText>
                  {c.isDefault && <span className="ml-2 text-text-secondary">Default</span>}
                </p>
              </div>
              {canEdit && (
                <div className="flex gap-1">
                  {!c.isDefault && (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={captions.update.isPending}
                      onClick={() =>
                        captions.update.mutate(
                          { captionId: c.id, body: { isDefault: true } },
                          {
                            onError: (e) =>
                              toast.error('Could not change the default', errorMessage(e)),
                          },
                        )
                      }
                    >
                      Make default
                      <span className="sr-only"> {c.label}</span>
                    </Button>
                  )}
                  <IconButton
                    label={`Remove ${c.label} captions`}
                    size="sm"
                    onClick={() => setRemoving(c)}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && <AddCaptions videoId={asset.id} onDone={() => setAdding(false)} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.label ?? ''} captions?`}
        description="Viewers will no longer be able to turn these captions on."
        confirmLabel="Remove"
        tone="danger"
        loading={captions.remove.isPending}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await captions.remove.mutateAsync(removing.id);
            toast.success('Captions removed');
            setRemoving(null);
          } catch (err) {
            toast.error('Could not remove the captions', errorMessage(err));
          }
        }}
      />
    </section>
  );
}

// ------------------------------------------------------------------ chapters

function ChapterRow({
  asset,
  chapter,
  canEdit,
}: {
  asset: media.MediaAssetDetail;
  chapter: media.Chapter;
  canEdit: boolean;
}) {
  const chapters = useChapters(asset.id);
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(formatClock(chapter.startSeconds));
  const [title, setTitle] = useState(chapter.title);
  const seconds = parseClock(start);
  const startError = seconds === null ? 'Use minutes and seconds, like 1:30.' : undefined;
  if (!editing) {
    return (
      <li className="flex items-center justify-between gap-3 py-2">
        <p className="min-w-0 text-sm">
          <span className="tabular mr-3 text-text-secondary">
            {formatClock(chapter.startSeconds)}
          </span>
          {chapter.title}
        </p>
        {canEdit && (
          <div className="flex gap-1">
            <IconButton
              label={`Edit chapter ${chapter.title}`}
              size="sm"
              onClick={() => setEditing(true)}
            >
              <Pencil className="size-4" />
            </IconButton>
            <IconButton
              label={`Delete chapter ${chapter.title}`}
              size="sm"
              onClick={() =>
                chapters.remove.mutate(chapter.id, {
                  onError: (e) => toast.error('Could not delete the chapter', errorMessage(e)),
                })
              }
            >
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        )}
      </li>
    );
  }
  return (
    <li className="py-2">
      <form
        className="grid gap-2 sm:grid-cols-[90px_minmax(0,1fr)_auto] sm:items-start"
        onSubmit={async (e) => {
          e.preventDefault();
          if (seconds === null || !title.trim()) return;
          try {
            await chapters.update.mutateAsync({
              chapterId: chapter.id,
              body: { startSeconds: seconds, title: title.trim() },
            });
            setEditing(false);
          } catch (err) {
            toast.error('Could not save the chapter', errorMessage(err));
          }
        }}
      >
        <Field label="Start" hideLabel error={startError}>
          <Input value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Chapter title" hideLabel>
          <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="flex gap-1">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={chapters.update.isPending}
            disabled={seconds === null || !title.trim()}
          >
            Save
          </Button>
          <Button size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </li>
  );
}

function Chapters({ asset, canEdit }: { asset: media.MediaAssetDetail; canEdit: boolean }) {
  const chapters = useChapters(asset.id);
  const [start, setStart] = useState('');
  const [title, setTitle] = useState('');
  const seconds = parseClock(start);
  const pastEnd =
    seconds !== null && asset.durationSeconds !== null && seconds > asset.durationSeconds;
  const startError =
    start && seconds === null
      ? 'Use minutes and seconds, like 1:30.'
      : pastEnd
        ? `The video is only ${formatDuration(asset.durationSeconds)} long.`
        : undefined;
  const ordered = [...asset.chapters].sort((a, b) => a.startSeconds - b.startSeconds);
  return (
    <section aria-labelledby="media-chapters">
      <h3 id="media-chapters" className="mb-2 text-md font-semibold">
        Chapters
      </h3>
      {ordered.length === 0 ? (
        <p className="text-sm text-text-secondary">
          No chapters. Chapters let viewers jump to a topic inside a long video.
        </p>
      ) : (
        <ul className="divide-y divide-divider border-y border-divider">
          {ordered.map((c) => (
            <ChapterRow key={c.id} asset={asset} chapter={c} canEdit={canEdit} />
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          className="mt-3 grid gap-2 sm:grid-cols-[90px_minmax(0,1fr)_auto] sm:items-start"
          onSubmit={async (e) => {
            e.preventDefault();
            if (seconds === null || pastEnd || !title.trim()) return;
            try {
              await chapters.create.mutateAsync({ startSeconds: seconds, title: title.trim() });
              setStart('');
              setTitle('');
            } catch (err) {
              toast.error('Could not add the chapter', errorMessage(err));
            }
          }}
        >
          <Field label="Start" hideLabel error={startError}>
            <Input
              placeholder="0:00"
              aria-label="New chapter start"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          <Field label="Chapter title" hideLabel>
            <Input
              placeholder="Chapter title"
              aria-label="New chapter title"
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Button
            type="submit"
            loading={chapters.create.isPending}
            disabled={seconds === null || pastEnd || !title.trim()}
            leading={<Plus className="size-3.5" />}
          >
            Add
          </Button>
        </form>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ sheet

function Body({ id, onClose }: { id: string; onClose: () => void }) {
  const asset = useMediaAsset(id);
  const canEdit = useCan('media.upload');
  const canArchive = useCan('media.delete');
  const archive = useArchiveMedia(id);
  const [confirm, setConfirm] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  if (asset.isPending) return <Skeleton className="h-64 w-full" />;
  if (asset.isError)
    return <ErrorState message={errorMessage(asset.error)} onRetry={() => asset.refetch()} />;
  const a = asset.data;
  const archived = a.status === 'archived';
  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <MediaStatus status={a.status} />
        <span className="text-sm text-text-secondary">
          {KIND_LABEL[a.kind]} · {formatFileSize(a.sizeBytes)}
          {a.durationSeconds !== null && ` · ${formatDuration(a.durationSeconds)}`}
          {a.width && a.height && ` · ${a.width}×${a.height}`}
        </span>
      </div>
      {(a.status === 'failed' || a.status === 'rejected') && a.error && (
        <Notice tone="danger" title={a.status === 'failed' ? 'Processing failed' : 'File rejected'}>
          {a.error}
        </Notice>
      )}
      {['uploaded', 'scanning', 'processing'].includes(a.status) && (
        <Notice tone="information" title="Still working on this file">
          It is being checked and converted. This page updates on its own; videos can take several
          minutes.
        </Notice>
      )}
      <Preview asset={a} />
      <DetailsForm key={a.updatedAt} asset={a} canEdit={canEdit && !archived} />
      {a.kind === 'video' && !archived && (
        <>
          <Captions asset={a} canEdit={canEdit} />
          <Chapters asset={a} canEdit={canEdit} />
        </>
      )}
      <DescriptionList
        columns={2}
        items={[
          { label: 'File name', value: a.originalFilename },
          { label: 'Added', value: formatDateTime(a.createdAt) },
          { label: 'Ready', value: a.readyAt ? formatDateTime(a.readyAt) : null },
          { label: 'Virus scan', value: <span className="capitalize">{a.scanStatus}</span> },
          ...(a.renditions.length
            ? [
                {
                  label: 'Streaming sizes',
                  value: a.renditions.map((r) => `${r.height}p`).join(', '),
                },
              ]
            : []),
        ]}
      />
      {canArchive && !archived && (
        <div className="border-t border-divider pt-4">
          <Button leading={<Archive className="size-4" />} onClick={() => setConfirm(true)}>
            Archive
          </Button>
          <p className="mt-2 text-xs text-text-tertiary">
            Media is archived, not deleted, so lesson history and watch records stay intact. The
            library does not replace a file in place: upload the new version and choose it in the
            lesson.
          </p>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={(o) => {
          setConfirm(o);
          if (!o) setArchiveError(null);
        }}
        title={`Archive “${a.title}”?`}
        description="It leaves the library and can no longer be chosen for lessons. Lessons already using it are not changed."
        confirmLabel="Archive"
        tone="danger"
        loading={archive.isPending}
        error={archiveError}
        onConfirm={async () => {
          setArchiveError(null);
          try {
            await archive.mutateAsync();
            toast.success('Archived');
            setConfirm(false);
            onClose();
          } catch (err) {
            setArchiveError(errorMessage(err));
          }
        }}
      />
    </div>
  );
}

/** Library entry detail (`?asset=`): preview, details, captions, chapters and archive. */
export function MediaDetail({ assetId, onClose }: { assetId: string | null; onClose: () => void }) {
  const asset = useMediaAsset(assetId);
  return (
    <DialogRoot open={Boolean(assetId)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        className="sm:w-[min(640px,94vw)]"
        title={asset.data?.title ?? 'Media details'}
        description={asset.data?.originalFilename}
      >
        {assetId && <Body id={assetId} onClose={onClose} />}
      </SheetContent>
    </DialogRoot>
  );
}
