import { useEffect, useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { Button, DialogContent, DialogRoot, IconButton, Input } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  acceptAttribute,
  acceptedTypesText,
  formatFileSize,
  kindOfFile,
  titleFromFilename,
  type UploadKind,
} from './upload';
import { KIND_LABEL } from './media-status';
import { useUploads } from './upload-manager';

interface Draft {
  key: string;
  file: File;
  title: string;
  kind: UploadKind | null;
}

let draftSeq = 0;
const toDraft = (file: File): Draft => ({
  key: `d${++draftSeq}`,
  file,
  title: titleFromFilename(file.name),
  kind: kindOfFile(file),
});

/**
 * Pick or drop files, name them, and hand them to the upload queue. Files the library does not
 * accept are listed with the reason instead of being dropped silently.
 */
export function UploadDialog({
  open,
  onOpenChange,
  initialFiles = [],
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialFiles?: File[];
}) {
  const enqueue = useUploads((s) => s.enqueue);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setDrafts(initialFiles.map(toDraft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const add = (files: FileList | File[] | null) => {
    if (!files) return;
    setDrafts((d) => [...d, ...Array.from(files).map(toDraft)]);
  };
  const accepted = drafts.filter((d) => d.kind !== null && d.title.trim());

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title="Upload media"
        description="Videos, PDFs, Office documents and images. Videos are checked and converted for streaming after the upload."
        footer={
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={accepted.length === 0}
              onClick={() => {
                enqueue(
                  accepted.map((d) => ({ file: d.file, title: d.title.trim(), kind: d.kind! })),
                );
                onOpenChange(false);
              }}
            >
              Upload {accepted.length > 0 ? accepted.length : ''}{' '}
              {accepted.length === 1 ? 'file' : 'files'}
            </Button>
          </>
        }
      >
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            add(e.dataTransfer.files);
          }}
          className={cn(
            'flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong px-4 py-6 text-center',
            dragging && 'border-information bg-information-soft',
          )}
        >
          <Upload aria-hidden className="size-5 text-text-tertiary" />
          <p className="text-sm text-text-secondary">Drop files here, or</p>
          <Button onClick={() => input.current?.click()}>Choose files</Button>
          <input
            ref={input}
            type="file"
            multiple
            accept={acceptAttribute()}
            className="sr-only"
            tabIndex={-1}
            aria-label="Files to upload"
            onChange={(e) => {
              add(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {drafts.length > 0 && (
          <ul className="mt-4 divide-y divide-divider border-y border-divider">
            {drafts.map((d) => (
              <li
                key={d.key}
                className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  {d.kind ? (
                    <>
                      <Input
                        aria-label={`Title for ${d.file.name}`}
                        value={d.title}
                        maxLength={200}
                        onChange={(e) =>
                          setDrafts((l) =>
                            l.map((x) => (x.key === d.key ? { ...x, title: e.target.value } : x)),
                          )
                        }
                      />
                      <p className="mt-1 truncate text-xs text-text-tertiary">
                        {KIND_LABEL[d.kind]} · {d.file.name} · {formatFileSize(d.file.size)}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="truncate font-medium">{d.file.name}</p>
                      <p role="alert" className="text-sm text-danger">
                        This type of file cannot be added to the library. {acceptedTypesText()}.
                      </p>
                    </>
                  )}
                </div>
                <IconButton
                  label={`Remove ${d.file.name}`}
                  onClick={() => setDrafts((l) => l.filter((x) => x.key !== d.key))}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
