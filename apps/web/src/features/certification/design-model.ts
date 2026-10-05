import { certification as c } from '@a5/contracts';
import type { DesignElement, TemplateDesign } from './types';

const { min: SAFE_MIN, max: SAFE_MAX } = c.DESIGN_SAFE_AREA;
const MIN_WIDTH = 0.5;
const MIN_HEIGHT = 0.2;

export const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export type NewElementKind =
  'text' | 'image' | 'logo' | 'qr' | 'signature-1' | 'signature-2' | 'stamp' | 'line';

export const NEW_ELEMENT_OPTIONS: Array<{ kind: NewElementKind; label: string }> = [
  { kind: 'text', label: 'Text' },
  { kind: 'logo', label: 'Logo' },
  { kind: 'image', label: 'Image' },
  { kind: 'signature-1', label: 'Signature 1' },
  { kind: 'signature-2', label: 'Signature 2' },
  { kind: 'stamp', label: 'Stamp' },
  { kind: 'qr', label: 'QR code' },
  { kind: 'line', label: 'Line' },
];

const BASE: Omit<DesignElement, 'id' | 'type' | 'x' | 'y' | 'width' | 'height'> = {
  content: '',
  assetId: null,
  align: 'center',
  fontSize: 14,
  fontWeight: 'normal',
  fontStyle: 'normal',
  fontFamily: null,
  color: '#1F2937',
  letterSpacing: 0,
  uppercase: false,
  lineHeight: 1.2,
  strokeWidth: 1,
};

function uniqueId(prefix: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const id = `${prefix}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** A new element placed inside the printable area, ready to be dragged where it belongs. */
export function newElement(
  kind: NewElementKind,
  existing: readonly DesignElement[],
): DesignElement {
  const taken = new Set(existing.map((e) => e.id));
  const make = (
    type: c.DesignElementType,
    box: Pick<DesignElement, 'x' | 'y' | 'width' | 'height'>,
    extra: Partial<DesignElement> = {},
  ) => ({ ...BASE, ...extra, ...box, type, id: uniqueId(type, taken) }) satisfies DesignElement;
  switch (kind) {
    case 'text':
      return make('text', { x: 25, y: 40, width: 50, height: 6 }, { content: 'New text' });
    case 'image':
      return make('image', { x: 40, y: 8, width: 20, height: 14 });
    case 'logo':
      return make('logo', { x: 42, y: 6, width: 16, height: 12 });
    case 'qr':
      return make('qr', { x: 86, y: 82, width: 8, height: 10.5 }, { content: '{{qr_code}}' });
    case 'signature-1':
      return make(
        'signature',
        { x: 11, y: 65, width: 24, height: 11 },
        { content: '{{signatory_1_signature}}' },
      );
    case 'signature-2':
      return make(
        'signature',
        { x: 65, y: 65, width: 24, height: 11 },
        { content: '{{signatory_2_signature}}' },
      );
    case 'stamp':
      return make(
        'stamp',
        { x: 42, y: 64, width: 16, height: 20 },
        { content: '{{organization_stamp}}' },
      );
    case 'line':
      return make('line', { x: 20, y: 50, width: 60, height: 0.8 });
  }
}

function mapElement(
  design: TemplateDesign,
  id: string,
  fn: (el: DesignElement) => DesignElement,
): TemplateDesign {
  return { ...design, elements: design.elements.map((el) => (el.id === id ? fn(el) : el)) };
}

export function updateElement(
  design: TemplateDesign,
  id: string,
  patch: Partial<DesignElement>,
): TemplateDesign {
  return mapElement(design, id, (el) => ({ ...el, ...patch }));
}

/** Move inside the printable area; snaps to 0.1% so saved values stay tidy. */
export function moveElement(
  design: TemplateDesign,
  id: string,
  x: number,
  y: number,
): TemplateDesign {
  return mapElement(design, id, (el) => ({
    ...el,
    x: round1(clamp(x, SAFE_MIN, SAFE_MAX - el.width)),
    y: round1(clamp(y, SAFE_MIN, SAFE_MAX - el.height)),
  }));
}

/** Resize while keeping the element inside the printable area. */
export function resizeElement(
  design: TemplateDesign,
  id: string,
  width: number,
  height: number,
): TemplateDesign {
  return mapElement(design, id, (el) => ({
    ...el,
    width: round1(clamp(width, MIN_WIDTH, SAFE_MAX - el.x)),
    height: round1(clamp(height, MIN_HEIGHT, SAFE_MAX - el.y)),
  }));
}

export function nudgeElement(
  design: TemplateDesign,
  id: string,
  dx: number,
  dy: number,
  mode: 'move' | 'resize',
): TemplateDesign {
  const el = design.elements.find((e) => e.id === id);
  if (!el) return design;
  return mode === 'move'
    ? moveElement(design, id, el.x + dx, el.y + dy)
    : resizeElement(design, id, el.width + dx, el.height + dy);
}

export function removeElement(design: TemplateDesign, id: string): TemplateDesign {
  return { ...design, elements: design.elements.filter((e) => e.id !== id) };
}

export function duplicateElement(
  design: TemplateDesign,
  id: string,
): { design: TemplateDesign; id: string | null } {
  const index = design.elements.findIndex((e) => e.id === id);
  const el = design.elements[index];
  if (!el) return { design, id: null };
  const taken = new Set(design.elements.map((e) => e.id));
  const copy: DesignElement = {
    ...el,
    id: uniqueId(el.type, taken),
    x: round1(clamp(el.x + 2, SAFE_MIN, SAFE_MAX - el.width)),
    y: round1(clamp(el.y + 2, SAFE_MIN, SAFE_MAX - el.height)),
  };
  const elements = [...design.elements];
  elements.splice(index + 1, 0, copy);
  return { design: { ...design, elements }, id: copy.id };
}

/** Elements are drawn in list order: later ones sit on top. */
export function reorderElement(
  design: TemplateDesign,
  id: string,
  direction: -1 | 1,
): TemplateDesign {
  const index = design.elements.findIndex((e) => e.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= design.elements.length) return design;
  const elements = [...design.elements];
  const [moved] = elements.splice(index, 1);
  elements.splice(target, 0, moved!);
  return { ...design, elements };
}

export function addElement(design: TemplateDesign, el: DesignElement): TemplateDesign {
  return { ...design, elements: [...design.elements, el] };
}

export interface DesignIssues {
  /** Messages per element id. */
  byElement: Map<string, string[]>;
  /** Problems not tied to one element. */
  general: string[];
  count: number;
}

/** Problems the API would reject, grouped by element so the editor can point at them. */
export function designIssues(design: TemplateDesign): DesignIssues {
  const byElement = new Map<string, string[]>();
  const general: string[] = [];
  const parsed = c.templateDesignSchema.safeParse(design);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [head, index] = issue.path;
      const id =
        head === 'elements' && typeof index === 'number' ? design.elements[index]?.id : undefined;
      if (id) byElement.set(id, [...(byElement.get(id) ?? []), issue.message]);
      else general.push(issue.message);
    }
  }
  let count = general.length;
  for (const list of byElement.values()) count += list.length;
  return { byElement, general, count };
}

/** Placeholders a text element can use (image placeholders belong to QR, signature and stamp elements). */
export const TEXT_PLACEHOLDERS = c.BUILT_IN_PLACEHOLDERS.filter(
  (p) => !(c.IMAGE_PLACEHOLDERS as readonly string[]).includes(p),
);

export function placeholderLabel(key: string): string {
  return c.isBuiltInPlaceholder(key) ? c.PLACEHOLDER_LABELS[key] : `Custom: ${key}`;
}

/** Insert `{{key}}` into text at the selection (or the end). */
export function insertPlaceholder(
  text: string,
  key: string,
  selectionStart: number | null,
  selectionEnd: number | null,
): string {
  const token = `{{${key}}}`;
  const start = selectionStart ?? text.length;
  const end = selectionEnd ?? start;
  return `${text.slice(0, start)}${token}${text.slice(end)}`;
}
