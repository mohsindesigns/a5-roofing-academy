import { certification as c } from '@a5/contracts';
import type { TemplateDesign, TemplatePreview } from './types';

/**
 * Browser rendering model of a certificate design. It is built from the same structured design the
 * PDF renderer uses (positions in percent of the page, fonts, colours, placeholders), so the
 * on-screen preview and the PDF place every element identically. Text that does not fit its box is
 * shrunk by the PDF renderer; the sample PDF is the exact check for that.
 */
export interface PreviewElement {
  id: string;
  type: c.DesignElementType;
  /** Percent of the page, as in the design. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Resolved text for text elements. */
  text: string | null;
  /** Image for image, logo, signature and stamp elements; null when none is available yet. */
  imageUrl: string | null;
  /** Value encoded by QR elements. */
  qrValue: string | null;
  align: 'left' | 'center' | 'right';
  fontSize: number;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  cssFontFamily: string;
  color: string;
  letterSpacing: number;
  lineHeight: number;
  strokeWidth: number;
  /** Short description for assistive technology and empty-image placeholders. */
  label: string;
}

export interface PreviewBorder {
  style: 'none' | 'single' | 'double' | 'ornamental';
  color: string;
  width: number;
  inset: number;
}

export interface PreviewModel {
  widthPt: number;
  heightPt: number;
  backgroundColor: string;
  backgroundImageUrl: string | null;
  border: PreviewBorder;
  accentColor: string;
  elements: PreviewElement[];
}

export interface PreviewSources {
  /** Text for every placeholder (`recipient_name` → "Jordan Ellis"). */
  values: Readonly<Record<string, string>>;
  qrValue: string;
  signatureUrls: { 1: string | null; 2: string | null };
  stampUrl: string | null;
  /** Uploaded template images by asset id (background, image and logo elements). */
  assetUrls: Readonly<Record<string, string>>;
}

/** CSS font stacks matching the PDF's standard fonts (mirrors the API's rendering constants). */
export const CSS_FONTS: Record<c.DesignFontFamily, string> = {
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  sans: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  display: '"Helvetica Neue", Helvetica, Arial, sans-serif',
};

/** Sample data used until the API's own sample values arrive. Clearly fictional. */
export const FALLBACK_SAMPLE_VALUES: Record<string, string> = {
  certificate_name: 'Certified Sales Professional',
  recipient_name: 'Jordan Ellis',
  employee_id: 'A5-1042',
  program_name: 'New Hire Sales Academy',
  completion_date: 'January 15, 2027',
  issue_date: 'January 15, 2027',
  expiration_date: 'January 15, 2029',
  certificate_number: 'A5-SALES-2027-000001',
  verification_url: 'https://example.invalid/verify/SAMPLE-PREVIEW',
  organization_name: 'A5 Roofing',
  signatory_1_name: 'First Signatory',
  signatory_1_title: 'Title',
  signatory_2_name: 'Second Signatory',
  signatory_2_title: 'Title',
  qr_code: '',
  signatory_1_signature: '',
  signatory_2_signature: '',
  organization_stamp: '',
};

export function signatureSlot(el: Pick<c.DesignElement, 'content'>): 1 | 2 {
  return el.content.includes('signatory_2_signature') ? 2 : 1;
}

/** Resolved text of a text element: placeholders filled, spaces collapsed, case applied. */
export function resolveText(
  el: Pick<c.DesignElement, 'content' | 'uppercase'>,
  values: Readonly<Record<string, string>>,
): string {
  const text = c
    .resolvePlaceholders(el.content, values)
    .replace(/[ \t]+/g, ' ')
    .trim();
  return el.uppercase ? text.toUpperCase() : text;
}

const ELEMENT_NOUN: Record<c.DesignElementType, string> = {
  text: 'Text',
  image: 'Image',
  logo: 'Logo',
  qr: 'QR code',
  signature: 'Signature',
  stamp: 'Stamp',
  line: 'Line',
};

export function elementNoun(type: c.DesignElementType): string {
  return ELEMENT_NOUN[type];
}

function describe(el: c.DesignElement, text: string | null): string {
  switch (el.type) {
    case 'text':
      return `${ELEMENT_NOUN.text}: ${text ? text.slice(0, 60) : '(empty)'}`;
    case 'signature':
      return `Signature ${signatureSlot(el)}`;
    default:
      return ELEMENT_NOUN[el.type];
  }
}

/** Resolve a design into what the browser draws. Pure: the same inputs always give the same model. */
export function buildPreviewModel(design: TemplateDesign, sources: PreviewSources): PreviewModel {
  const { width, height } = c.pageDimensions(design.page);
  const elements = design.elements.map<PreviewElement>((el) => {
    const family = el.fontFamily ?? design.theme.fontFamily;
    const text = el.type === 'text' ? resolveText(el, sources.values) : null;
    let imageUrl: string | null = null;
    if (el.type === 'signature') imageUrl = sources.signatureUrls[signatureSlot(el)];
    else if (el.type === 'stamp') imageUrl = sources.stampUrl;
    else if ((el.type === 'image' || el.type === 'logo') && el.assetId)
      imageUrl = sources.assetUrls[el.assetId] ?? null;
    return {
      id: el.id,
      type: el.type,
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      text,
      imageUrl,
      qrValue: el.type === 'qr' ? sources.qrValue : null,
      align: el.align,
      fontSize: el.fontSize,
      // The display family is always heavy, as in the PDF.
      fontWeight: family === 'display' ? 'bold' : el.fontWeight,
      fontStyle: el.fontStyle,
      cssFontFamily: CSS_FONTS[family],
      color: el.color,
      letterSpacing: el.letterSpacing,
      lineHeight: el.lineHeight,
      strokeWidth: el.strokeWidth,
      label: describe(el, text),
    };
  });
  const backgroundId = design.theme.backgroundImageAssetId;
  return {
    widthPt: width,
    heightPt: height,
    backgroundColor: design.theme.backgroundColor,
    backgroundImageUrl: backgroundId ? (sources.assetUrls[backgroundId] ?? null) : null,
    border: design.theme.border,
    accentColor: design.theme.accentColor,
    elements,
  };
}

/**
 * Preview sources taken from an API sample render: the placeholder values, the verification URL
 * and the signed image URLs for signatures, the stamp and uploaded images.
 */
export function sourcesFromPreview(
  preview: TemplatePreview,
  design: TemplateDesign,
): PreviewSources {
  const signatureUrls: PreviewSources['signatureUrls'] = { 1: null, 2: null };
  let stampUrl: string | null = null;
  const assetUrls: Record<string, string> = {};
  const byId = new Map(design.elements.map((el) => [el.id, el]));
  for (const resolved of preview.elements) {
    const el = byId.get(resolved.id);
    if (!el || !resolved.imageUrl) continue;
    if (el.type === 'signature') signatureUrls[signatureSlot(el)] ??= resolved.imageUrl;
    else if (el.type === 'stamp') stampUrl ??= resolved.imageUrl;
    else if ((el.type === 'image' || el.type === 'logo') && el.assetId)
      assetUrls[el.assetId] = resolved.imageUrl;
  }
  const backgroundId = design.theme.backgroundImageAssetId;
  if (backgroundId && preview.theme.backgroundImageUrl)
    assetUrls[backgroundId] = preview.theme.backgroundImageUrl;
  return {
    values: preview.sampleValues,
    qrValue:
      preview.sampleValues['verification_url'] ?? FALLBACK_SAMPLE_VALUES['verification_url']!,
    signatureUrls,
    stampUrl,
    assetUrls,
  };
}

export const FALLBACK_SOURCES: PreviewSources = {
  values: FALLBACK_SAMPLE_VALUES,
  qrValue: FALLBACK_SAMPLE_VALUES['verification_url']!,
  signatureUrls: { 1: null, 2: null },
  stampUrl: null,
  assetUrls: {},
};

/**
 * Parts of a design that decide which images the API must resolve. When this changes, a fresh
 * sample render is requested; typing in a text box does not change it.
 */
export function imageFingerprint(design: Pick<TemplateDesign, 'theme' | 'elements'>): string {
  return JSON.stringify([
    design.theme.backgroundImageAssetId,
    design.elements
      .filter((el) => el.type !== 'text' && el.type !== 'line' && el.type !== 'qr')
      .map((el) => [
        el.id,
        el.type,
        el.type === 'signature' ? signatureSlot(el) : null,
        el.assetId,
      ]),
  ]);
}
