import { certification } from '@a5/contracts';

type TemplateDesign = certification.TemplateDesign;
type DesignElement = certification.DesignElement;
type FontFamily = certification.DesignFontFamily;

/**
 * Geometry shared by the PDF renderer and the HTML preview: every element is positioned in percent
 * of the page, so both renderings place it identically.
 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function pageSize(design: Pick<TemplateDesign, 'page'>): { width: number; height: number } {
  return certification.pageDimensions(design.page);
}

export function elementBox(
  el: Pick<DesignElement, 'x' | 'y' | 'width' | 'height'>,
  page: { width: number; height: number },
): Box {
  return {
    x: (el.x / 100) * page.width,
    y: (el.y / 100) * page.height,
    w: (el.width / 100) * page.width,
    h: (el.height / 100) * page.height,
  };
}

/** PDF standard fonts (embedded by PDFKit from its AFM metrics) per design family and style. */
const PDF_FONTS: Record<
  FontFamily,
  { normal: string; bold: string; italic: string; boldItalic: string }
> = {
  serif: {
    normal: 'Times-Roman',
    bold: 'Times-Bold',
    italic: 'Times-Italic',
    boldItalic: 'Times-BoldItalic',
  },
  sans: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italic: 'Helvetica-Oblique',
    boldItalic: 'Helvetica-BoldOblique',
  },
  display: {
    normal: 'Helvetica-Bold',
    bold: 'Helvetica-Bold',
    italic: 'Helvetica-BoldOblique',
    boldItalic: 'Helvetica-BoldOblique',
  },
};

/** CSS stacks that match the PDF fonts for the live HTML preview. */
export const CSS_FONTS: Record<FontFamily, string> = {
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  sans: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  display: '"Helvetica Neue", Helvetica, Arial, sans-serif',
};

export function elementFontFamily(
  el: Pick<DesignElement, 'fontFamily'>,
  design: Pick<TemplateDesign, 'theme'>,
): FontFamily {
  return el.fontFamily ?? design.theme.fontFamily;
}

export function pdfFontName(
  family: FontFamily,
  weight: 'normal' | 'bold',
  style: 'normal' | 'italic',
): string {
  const f = PDF_FONTS[family];
  if (weight === 'bold') return style === 'italic' ? f.boldItalic : f.bold;
  return style === 'italic' ? f.italic : f.normal;
}

/** Display weight for the preview (display family is always heavy). */
export function cssFontWeight(family: FontFamily, weight: 'normal' | 'bold'): 'normal' | 'bold' {
  return family === 'display' ? 'bold' : weight;
}

/** Resolved text of a text element (placeholders filled, case applied). */
export function elementText(
  el: Pick<DesignElement, 'content' | 'uppercase'>,
  values: Readonly<Record<string, string>>,
): string {
  const text = certification
    .resolvePlaceholders(el.content, values)
    .replace(/[ \t]+/g, ' ')
    .trim();
  return el.uppercase ? text.toUpperCase() : text;
}

/** Which slot image a signature element shows (1 or 2). */
export function signatureSlotOf(el: Pick<DesignElement, 'content'>): 1 | 2 {
  return el.content.includes('signatory_2_signature') ? 2 : 1;
}

/** Characters of the WinAnsi encoding outside Latin-1. */
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

/** PDF standard fonts use WinAnsi; map characters outside it to their closest base letter. */
export function pdfSafeText(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0xa0 && code <= 0xff) ||
      WIN_ANSI_EXTRA.includes(ch)
    ) {
      out += ch;
    } else {
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      out += /^[ -~]+$/.test(base) ? base : '?';
    }
  }
  return out;
}
