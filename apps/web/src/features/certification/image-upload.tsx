import { useId, useRef, useState } from 'react';
import { ImagePlus, Trash2, Upload } from 'lucide-react';
import { certification as c } from '@a5/contracts';
import { Button } from '@/components/ui';
import { errorMessage } from '@/lib/api/errors';

export type UploadPurpose = keyof typeof c.IMAGE_UPLOAD_RULES;
type Rule = (typeof c.IMAGE_UPLOAD_RULES)[UploadPurpose];

const ACCEPTED = ['image/png', 'image/jpeg'];

function megabytes(bytes: number): string {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

/**
 * Checks an image against the upload limits for its purpose. The API applies the same limits
 * (and inspects the file itself); checking here saves a round trip and explains what to change.
 * Returns a message or null when the image is acceptable.
 */
export function imageProblem(
  file: { type: string; size: number },
  size: { width: number; height: number } | null,
  rule: Rule,
): string | null {
  if (!ACCEPTED.includes(file.type))
    return 'Use a PNG or JPEG image. SVG and other formats are not accepted.';
  if (file.size > rule.maxBytes)
    return `The image is ${megabytes(file.size)}. Use one under ${megabytes(rule.maxBytes)}.`;
  if (!size) return 'The image could not be read. Try exporting it again as a PNG or JPEG.';
  const { width, height } = size;
  if (width < rule.minWidth || height < rule.minHeight) {
    return `The image is ${width} × ${height} px. It must be at least ${rule.minWidth} × ${rule.minHeight} px.`;
  }
  if (width > rule.maxWidth || height > rule.maxHeight) {
    return `The image is ${width} × ${height} px. It must be at most ${rule.maxWidth} × ${rule.maxHeight} px.`;
  }
  const aspect = width / height;
  if (aspect < rule.minAspect || aspect > rule.maxAspect) {
    return `The image proportions (${width} × ${height}) are outside what this artwork allows. Crop it closer to the expected shape.`;
  }
  return null;
}

/** Natural size of an image file, or null if the browser cannot decode it. */
export function readImageSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

export function limitsText(purpose: UploadPurpose): string {
  const r = c.IMAGE_UPLOAD_RULES[purpose];
  return `PNG or JPEG, up to ${megabytes(r.maxBytes)}, at least ${r.minWidth} × ${r.minHeight} px.`;
}

/**
 * Image picker with preview. `onUpload` stores the file through the certification assets API; its
 * failure message (for example an image that is too small) is shown inline.
 */
export function ImageUploader({
  purpose,
  label,
  currentUrl,
  currentAlt,
  onUpload,
  onRemove,
  disabled,
  uploadLabel = 'Upload image',
}: {
  purpose: UploadPurpose;
  label: string;
  currentUrl?: string | null;
  currentAlt?: string;
  onUpload: (file: File) => Promise<unknown>;
  onRemove?: () => void;
  disabled?: boolean;
  uploadLabel?: string;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [broken, setBroken] = useState(false);
  const rule = c.IMAGE_UPLOAD_RULES[purpose];

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const problem = imageProblem(file, await readImageSize(file), rule);
      if (problem) {
        setError(problem);
        return;
      }
      await onUpload(file);
      setBroken(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-20 w-32 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-white">
          {currentUrl && !broken ? (
            <img
              src={currentUrl}
              alt={currentAlt ?? label}
              className="max-h-full max-w-full object-contain"
              onError={() => setBroken(true)}
            />
          ) : (
            <ImagePlus aria-hidden className="size-6 text-text-tertiary" />
          )}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap gap-2">
            <input
              ref={input}
              id={inputId}
              type="file"
              accept="image/png,image/jpeg"
              className="sr-only"
              disabled={disabled || busy}
              onChange={(e) => void choose(e.target.files?.[0])}
            />
            <Button
              loading={busy}
              disabled={disabled}
              leading={<Upload className="size-4" />}
              onClick={() => input.current?.click()}
            >
              {currentUrl ? 'Replace image' : uploadLabel}
              <span className="sr-only"> for {label}</span>
            </Button>
            {currentUrl && onRemove && (
              <Button
                variant="ghost"
                disabled={disabled || busy}
                leading={<Trash2 className="size-4" />}
                onClick={onRemove}
              >
                Remove
              </Button>
            )}
          </div>
          <p className="mt-1.5 text-xs text-text-tertiary">{limitsText(purpose)}</p>
          {broken && (
            <p className="mt-1 text-xs text-warning">
              The preview link expired. Reload the page to see the image again.
            </p>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
