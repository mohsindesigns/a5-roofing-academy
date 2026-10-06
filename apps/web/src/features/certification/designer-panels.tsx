import { useRef, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Copy,
  Image as ImageIcon,
  Minus,
  Plus,
  QrCode as QrIcon,
  SquareDashed,
  Stamp as StampIcon,
  PenLine,
  Trash2,
  Type,
} from 'lucide-react';
import { certification as c } from '@a5/contracts';
import {
  Button,
  Field,
  IconButton,
  Input,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
  Select,
  Skeleton,
  Switch,
  Textarea,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';
import { useTemplateVersions, useUploadAsset } from './api';
import {
  NEW_ELEMENT_OPTIONS,
  TEXT_PLACEHOLDERS,
  insertPlaceholder,
  placeholderLabel,
  type DesignIssues,
  type NewElementKind,
} from './design-model';
import { ImageUploader } from './image-upload';
import { elementNoun, signatureSlot } from './template-preview';
import type { CertificationAsset, DesignElement, TemplateDesign, TemplateVersion } from './types';

// ------------------------------------------------------------------ shared inputs

function Num({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.1,
  unit,
  disabled,
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={Number.isFinite(value) ? value : ''}
        trailing={
          unit ? (
            <span className="pointer-events-none text-sm text-text-secondary">{unit}</span>
          ) : undefined
        }
        onChange={(e) => {
          if (e.target.value === '') return;
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </Field>
  );
}

function ColorField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
}) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <div>
      <label className="text-sm font-medium" htmlFor={`color-${label}`}>
        {label}
      </label>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="color"
          aria-label={`Pick ${label.toLowerCase()}`}
          disabled={disabled}
          value={valid ? value : '#000000'}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="h-[var(--a5-control-height)] w-11 shrink-0 cursor-pointer rounded border border-border-strong bg-surface p-1"
        />
        <Input
          id={`color-${label}`}
          className="font-mono"
          value={value}
          maxLength={7}
          disabled={disabled}
          aria-invalid={valid ? undefined : true}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {!valid && (
        <p className="mt-1 text-xs font-medium text-danger">
          Use a 6-digit hex colour such as #1F2937.
        </p>
      )}
    </div>
  );
}

const ALIGN_OPTIONS = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Centre' },
  { value: 'right', label: 'Right' },
];

const FONT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'serif', label: 'Serif (Times)' },
  { value: 'sans', label: 'Sans (Helvetica)' },
  { value: 'display', label: 'Display (bold Helvetica)' },
];

const ICONS: Record<c.DesignElementType, typeof Type> = {
  text: Type,
  image: ImageIcon,
  logo: ImageIcon,
  qr: QrIcon,
  signature: PenLine,
  stamp: StampIcon,
  line: Minus,
};

// ------------------------------------------------------------------ element list

export function ElementList({
  design,
  selectedId,
  onSelect,
  issues,
  onAdd,
  onReorder,
  onDuplicate,
  onRemove,
  readOnly,
}: {
  design: TemplateDesign;
  selectedId: string | null;
  onSelect: (id: string) => void;
  issues: DesignIssues;
  onAdd: (kind: NewElementKind) => void;
  onReorder: (id: string, direction: -1 | 1) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  readOnly: boolean;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          Elements{' '}
          <span className="font-normal text-text-secondary">({design.elements.length} of 80)</span>
        </h3>
        {!readOnly && (
          <MenuRoot>
            <MenuTrigger asChild>
              <Button
                size="sm"
                leading={<Plus className="size-4" />}
                trailing={<ChevronDown className="size-3.5" />}
                disabled={design.elements.length >= 80}
              >
                Add
              </Button>
            </MenuTrigger>
            <MenuContent>
              {NEW_ELEMENT_OPTIONS.map((o) => (
                <MenuItem key={o.kind} onSelect={() => onAdd(o.kind)}>
                  {o.label}
                </MenuItem>
              ))}
            </MenuContent>
          </MenuRoot>
        )}
      </div>
      {design.elements.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong px-3 py-4 text-sm text-text-secondary">
          The page is empty. Add text, a logo, signatures or a QR code.
        </p>
      ) : (
        <ul className="max-h-[260px] divide-y divide-divider overflow-y-auto rounded-lg border border-border bg-surface">
          {design.elements.map((el, index) => {
            const Icon = ICONS[el.type];
            const problems = issues.byElement.get(el.id);
            const selected = el.id === selectedId;
            const name =
              el.type === 'text'
                ? el.content
                    .replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (_m, k: string) => `‹${k}›`)
                    .slice(0, 40) || '(empty)'
                : el.type === 'signature'
                  ? `Signature ${signatureSlot(el)}`
                  : elementNoun(el.type);
            return (
              <li
                key={el.id}
                className={cn('flex items-center gap-1 pr-1', selected && 'bg-surface-selected')}
              >
                <button
                  type="button"
                  aria-current={selected || undefined}
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-hover"
                  onClick={() => onSelect(el.id)}
                >
                  <Icon aria-hidden className="size-4 shrink-0 text-text-tertiary" />
                  <span className="min-w-0 truncate">{name}</span>
                  {problems && (
                    <span className="shrink-0 rounded-sm bg-danger-soft px-1.5 text-xs font-medium text-danger">
                      {problems.length} {problems.length === 1 ? 'problem' : 'problems'}
                    </span>
                  )}
                </button>
                {!readOnly && (
                  <span className="flex shrink-0">
                    <IconButton
                      label={`Send ${name} backward`}
                      size="sm"
                      disabled={index === 0}
                      onClick={() => onReorder(el.id, -1)}
                    >
                      <ArrowDown className="size-3.5" />
                    </IconButton>
                    <IconButton
                      label={`Bring ${name} forward`}
                      size="sm"
                      disabled={index === design.elements.length - 1}
                      onClick={() => onReorder(el.id, 1)}
                    >
                      <ArrowUp className="size-3.5" />
                    </IconButton>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!readOnly && selectedId && (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            leading={<Copy className="size-3.5" />}
            onClick={() => onDuplicate(selectedId)}
          >
            Duplicate
          </Button>
          <Button
            size="sm"
            leading={<Trash2 className="size-3.5" />}
            onClick={() => onRemove(selectedId)}
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ element properties

export function ElementProperties({
  element,
  problems,
  onChange,
  onAsset,
  customKeys,
  readOnly,
}: {
  element: DesignElement;
  problems: string[];
  onChange: (patch: Partial<DesignElement>) => void;
  onAsset: (asset: CertificationAsset) => void;
  customKeys: string[];
  readOnly: boolean;
}) {
  const text = useRef<HTMLTextAreaElement>(null);
  const upload = useUploadAsset('logo');
  const isText = element.type === 'text';
  const hasBox = element.type !== 'line';
  const slot = element.type === 'signature' ? signatureSlot(element) : null;

  return (
    <div className="grid gap-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{elementNoun(element.type)}</h3>
        <code className="font-mono text-xs text-text-secondary">{element.id}</code>
      </div>
      {problems.length > 0 && (
        <ul
          role="alert"
          className="grid gap-1 rounded bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {isText && (
        <div className="grid gap-2">
          <Field
            label="Text"
            hint="Placeholders such as {{recipient_name}} are replaced for each certificate."
          >
            <Textarea
              ref={text}
              rows={3}
              maxLength={600}
              disabled={readOnly}
              value={element.content}
              onChange={(e) => onChange({ content: e.target.value })}
            />
          </Field>
          {!readOnly && (
            <Field label="Insert placeholder" hideLabel>
              <Select
                value=""
                aria-label="Insert placeholder"
                onChange={(e) => {
                  if (!e.target.value) return;
                  const el = text.current;
                  const next = insertPlaceholder(
                    element.content,
                    e.target.value,
                    el?.selectionStart ?? null,
                    el?.selectionEnd ?? null,
                  );
                  onChange({ content: next });
                  e.target.value = '';
                }}
              >
                <option value="">Insert placeholder…</option>
                {TEXT_PLACEHOLDERS.map((p) => (
                  <option key={p} value={p}>
                    {placeholderLabel(p)}
                  </option>
                ))}
                {customKeys.map((k) => (
                  <option key={k} value={k}>
                    {placeholderLabel(k)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      )}

      {element.type === 'signature' && (
        <Field label="Whose signature" hint="Signatories are chosen on each certification.">
          <Select
            value={String(slot)}
            disabled={readOnly}
            onChange={(e) => onChange({ content: `{{signatory_${e.target.value}_signature}}` })}
          >
            <option value="1">Signatory 1</option>
            <option value="2">Signatory 2</option>
          </Select>
        </Field>
      )}

      {(element.type === 'image' || element.type === 'logo') && (
        <div>
          <p className="mb-1.5 text-sm font-medium">Image</p>
          <ImageUploader
            purpose="logo"
            label={element.type === 'logo' ? 'logo' : 'image'}
            currentUrl={upload.data?.id === element.assetId ? upload.data.previewUrl : null}
            disabled={readOnly}
            onUpload={async (file) => {
              const asset = await upload.mutateAsync(file);
              onAsset(asset);
              onChange({ assetId: asset.id });
            }}
          />
          {element.assetId && upload.data?.id !== element.assetId && (
            <p className="mt-1.5 text-xs text-text-secondary">
              An image is set. Upload a new one to replace it.
            </p>
          )}
        </div>
      )}

      {hasBox && (
        <fieldset className="grid gap-3">
          <legend className="mb-1 text-sm font-semibold">Position and size</legend>
          <div className="grid grid-cols-2 gap-3">
            <Num
              label="Left"
              unit="%"
              min={c.DESIGN_SAFE_AREA.min}
              max={c.DESIGN_SAFE_AREA.max}
              value={element.x}
              disabled={readOnly}
              onChange={(x) => onChange({ x })}
            />
            <Num
              label="Top"
              unit="%"
              min={c.DESIGN_SAFE_AREA.min}
              max={c.DESIGN_SAFE_AREA.max}
              value={element.y}
              disabled={readOnly}
              onChange={(y) => onChange({ y })}
            />
            <Num
              label="Width"
              unit="%"
              min={0.5}
              max={100}
              value={element.width}
              disabled={readOnly}
              onChange={(width) => onChange({ width })}
            />
            <Num
              label="Height"
              unit="%"
              min={0.2}
              max={100}
              value={element.height}
              disabled={readOnly}
              onChange={(height) => onChange({ height })}
            />
          </div>
          <p className="text-xs text-text-secondary">
            Keep elements between {c.DESIGN_SAFE_AREA.min}% and {c.DESIGN_SAFE_AREA.max}% of the
            page so printers do not clip them.
          </p>
        </fieldset>
      )}

      {element.type === 'line' && (
        <fieldset className="grid gap-3">
          <legend className="mb-1 text-sm font-semibold">Position and length</legend>
          <div className="grid grid-cols-2 gap-3">
            <Num
              label="Left"
              unit="%"
              min={c.DESIGN_SAFE_AREA.min}
              max={c.DESIGN_SAFE_AREA.max}
              value={element.x}
              disabled={readOnly}
              onChange={(x) => onChange({ x })}
            />
            <Num
              label="Top"
              unit="%"
              min={c.DESIGN_SAFE_AREA.min}
              max={c.DESIGN_SAFE_AREA.max}
              value={element.y}
              disabled={readOnly}
              onChange={(y) => onChange({ y })}
            />
            <Num
              label="Length"
              unit="%"
              min={0.5}
              max={100}
              value={element.width}
              disabled={readOnly}
              onChange={(width) => onChange({ width })}
            />
            <Num
              label="Thickness"
              unit="pt"
              min={0.25}
              max={10}
              step={0.25}
              value={element.strokeWidth}
              disabled={readOnly}
              onChange={(strokeWidth) => onChange({ strokeWidth })}
            />
          </div>
        </fieldset>
      )}

      {element.type !== 'line' && (
        <Field label="Alignment">
          <Select
            value={element.align}
            disabled={readOnly}
            onChange={(e) => onChange({ align: e.target.value as DesignElement['align'] })}
          >
            {ALIGN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {isText && (
        <fieldset className="grid gap-3">
          <legend className="mb-1 text-sm font-semibold">Type</legend>
          <Field label="Font">
            <Select
              value={element.fontFamily ?? ''}
              disabled={readOnly}
              onChange={(e) =>
                onChange({ fontFamily: (e.target.value || null) as DesignElement['fontFamily'] })
              }
            >
              <option value="">Use the page font</option>
              {FONT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Num
              label="Size"
              unit="pt"
              min={5}
              max={120}
              step={0.5}
              value={element.fontSize}
              disabled={readOnly}
              onChange={(fontSize) => onChange({ fontSize })}
            />
            <Num
              label="Line height"
              min={0.8}
              max={3}
              step={0.05}
              value={element.lineHeight}
              disabled={readOnly}
              onChange={(lineHeight) => onChange({ lineHeight })}
            />
            <Num
              label="Letter spacing"
              unit="pt"
              min={0}
              max={20}
              step={0.5}
              value={element.letterSpacing}
              disabled={readOnly}
              onChange={(letterSpacing) => onChange({ letterSpacing })}
            />
            <Field label="Weight">
              <Select
                value={element.fontWeight}
                disabled={readOnly}
                onChange={(e) =>
                  onChange({ fontWeight: e.target.value as DesignElement['fontWeight'] })
                }
              >
                <option value="normal">Regular</option>
                <option value="bold">Bold</option>
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Style">
              <Select
                value={element.fontStyle}
                disabled={readOnly}
                onChange={(e) =>
                  onChange({ fontStyle: e.target.value as DesignElement['fontStyle'] })
                }
              >
                <option value="normal">Upright</option>
                <option value="italic">Italic</option>
              </Select>
            </Field>
            <div className="flex items-center gap-2 pt-6">
              <Switch
                id={`upper-${element.id}`}
                aria-labelledby={`upper-label-${element.id}`}
                checked={element.uppercase}
                disabled={readOnly}
                onCheckedChange={(uppercase) => onChange({ uppercase })}
              />
              <label
                id={`upper-label-${element.id}`}
                htmlFor={`upper-${element.id}`}
                className="text-sm font-medium"
              >
                Capitals
              </label>
            </div>
          </div>
        </fieldset>
      )}

      {(isText || element.type === 'line' || element.type === 'qr') && (
        <ColorField
          label={element.type === 'qr' ? 'Code colour' : 'Colour'}
          value={element.color}
          disabled={readOnly}
          onChange={(color) => onChange({ color })}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ page and theme

export function PageThemePanel({
  design,
  onChange,
  onAsset,
  backgroundUrl,
  readOnly,
}: {
  design: TemplateDesign;
  onChange: (next: TemplateDesign) => void;
  onAsset: (asset: CertificationAsset) => void;
  backgroundUrl: string | null;
  readOnly: boolean;
}) {
  const upload = useUploadAsset('background');
  const { page, theme } = design;
  const setTheme = (patch: Partial<TemplateDesign['theme']>) =>
    onChange({ ...design, theme: { ...theme, ...patch } });
  const setBorder = (patch: Partial<TemplateDesign['theme']['border']>) =>
    setTheme({ border: { ...theme.border, ...patch } });
  return (
    <div className="grid gap-5">
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-semibold">Page</legend>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Paper size">
            <Select
              value={page.size}
              disabled={readOnly}
              onChange={(e) =>
                onChange({ ...design, page: { ...page, size: e.target.value as typeof page.size } })
              }
            >
              <option value="LETTER">US Letter</option>
              <option value="A4">A4</option>
            </Select>
          </Field>
          <Field label="Orientation">
            <Select
              value={page.orientation}
              disabled={readOnly}
              onChange={(e) =>
                onChange({
                  ...design,
                  page: { ...page, orientation: e.target.value as typeof page.orientation },
                })
              }
            >
              <option value="landscape">Landscape</option>
              <option value="portrait">Portrait</option>
            </Select>
          </Field>
        </div>
        <Field label="Page font" hint="Used by text that does not choose its own.">
          <Select
            value={theme.fontFamily}
            disabled={readOnly}
            onChange={(e) => setTheme({ fontFamily: e.target.value as typeof theme.fontFamily })}
          >
            {FONT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-semibold">Colours</legend>
        <ColorField
          label="Paper colour"
          value={theme.backgroundColor}
          disabled={readOnly}
          onChange={(backgroundColor) => setTheme({ backgroundColor })}
        />
        <ColorField
          label="Accent colour"
          value={theme.accentColor}
          disabled={readOnly}
          onChange={(accentColor) => setTheme({ accentColor })}
        />
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-semibold">Border</legend>
        <Field label="Style">
          <Select
            value={theme.border.style}
            disabled={readOnly}
            onChange={(e) => setBorder({ style: e.target.value as typeof theme.border.style })}
          >
            <option value="none">None</option>
            <option value="single">Single line</option>
            <option value="double">Double line</option>
            <option value="ornamental">Ornamental</option>
          </Select>
        </Field>
        {theme.border.style !== 'none' && (
          <>
            <ColorField
              label="Border colour"
              value={theme.border.color}
              disabled={readOnly}
              onChange={(color) => setBorder({ color })}
            />
            <div className="grid grid-cols-2 gap-3">
              <Num
                label="Thickness"
                unit="pt"
                min={0.25}
                max={12}
                step={0.25}
                value={theme.border.width}
                disabled={readOnly}
                onChange={(width) => setBorder({ width })}
              />
              <Num
                label="Inset"
                unit="%"
                min={0}
                max={10}
                step={0.5}
                value={theme.border.inset}
                disabled={readOnly}
                onChange={(inset) => setBorder({ inset })}
              />
            </div>
          </>
        )}
      </fieldset>

      <div>
        <p className="mb-1.5 text-sm font-semibold">Background image</p>
        <ImageUploader
          purpose="background"
          label="background image"
          currentUrl={theme.backgroundImageAssetId ? backgroundUrl : null}
          disabled={readOnly}
          onUpload={async (file) => {
            const asset = await upload.mutateAsync(file);
            onAsset(asset);
            setTheme({ backgroundImageAssetId: asset.id });
          }}
          onRemove={() => setTheme({ backgroundImageAssetId: null })}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ versions

export function VersionsPanel({
  templateId,
  currentVersion,
  onRestore,
  restoring,
  readOnly,
}: {
  templateId: string;
  currentVersion: number;
  onRestore: (version: TemplateVersion) => void;
  restoring: string | null;
  readOnly: boolean;
}) {
  const versions = useTemplateVersions(templateId);
  if (versions.isPending) return <Skeleton className="h-24 w-full" />;
  if (versions.isError) {
    return (
      <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
        {errorMessage(versions.error)}
      </p>
    );
  }
  return (
    <div>
      <p className="mb-3 text-sm text-text-secondary">
        Every save creates a new version. Certificates already issued keep the version they were
        issued with.
      </p>
      <ol className="divide-y divide-divider rounded-lg border border-border bg-surface">
        {versions.data.items.map((v) => (
          <li key={v.id} className="px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium">
                Version {v.version}
                {v.version === currentVersion && (
                  <span className="ml-2 text-xs font-normal text-success">Current</span>
                )}
              </p>
              <time dateTime={v.createdAt} className="text-xs text-text-secondary">
                {formatDateTime(v.createdAt)}
              </time>
            </div>
            {v.changeNote && <p className="mt-0.5 text-sm text-text-secondary">{v.changeNote}</p>}
            <div className="mt-1 flex items-center justify-between gap-2">
              <p className="text-xs text-text-secondary">{v.createdBy?.displayName ?? 'System'}</p>
              {!readOnly && v.version !== currentVersion && (
                <Button size="sm" loading={restoring === v.id} onClick={() => onRestore(v)}>
                  Load into editor
                  <span className="sr-only"> version {v.version}</span>
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-xs text-text-secondary">
      <SquareDashed aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
