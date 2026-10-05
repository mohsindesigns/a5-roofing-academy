import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import type { certification } from '@a5/contracts';
import {
  elementBox,
  elementFontFamily,
  elementText,
  pageSize,
  pdfFontName,
  pdfSafeText,
  signatureSlotOf,
  type Box,
} from './layout.js';

type TemplateDesign = certification.TemplateDesign;
type DesignElement = certification.DesignElement;
type Doc = PDFKit.PDFDocument;

export interface RenderImages {
  signature1: Buffer | null;
  signature2: Buffer | null;
  stamp: Buffer | null;
  /** Template images (background, logo, image elements) by asset id. */
  assets: ReadonlyMap<string, Buffer>;
}

export interface RenderInput {
  design: TemplateDesign;
  /** Text values for every placeholder. */
  values: Readonly<Record<string, string>>;
  /** Encoded in QR elements (the verification URL). */
  qrValue: string;
  images: RenderImages;
  info: { title: string; author: string; subject: string; keywords: string; creationDate: Date };
  /** Small identification line printed at the bottom edge (certificate id). */
  footer: string | null;
  /** Diagonal watermark (template previews). */
  watermark: string | null;
}

const MIN_FONT_SIZE = 5;

/**
 * Render a certificate design to a single-page PDF. Geometry follows the design model exactly
 * (percent of the page), text uses embedded standard fonts and shrinks to fit its box, QR codes are
 * drawn as vectors and images are embedded at full resolution.
 */
export async function renderCertificatePdf(input: RenderInput): Promise<Buffer> {
  const { design } = input;
  const page = pageSize(design);
  const doc = new PDFDocument({
    size: [page.width, page.height],
    margin: 0,
    autoFirstPage: true,
    pdfVersion: '1.7',
    displayTitle: true,
    info: {
      Title: pdfSafeText(input.info.title),
      Author: pdfSafeText(input.info.author),
      Subject: pdfSafeText(input.info.subject),
      Keywords: pdfSafeText(input.info.keywords),
      Creator: 'A5 Sales Academy',
      Producer: 'A5 Sales Academy certification service',
      CreationDate: input.info.creationDate,
      ModDate: input.info.creationDate,
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  drawBackground(doc, design, page, input.images);
  drawBorder(doc, design, page);
  for (const el of design.elements) {
    const box = elementBox(el, page);
    switch (el.type) {
      case 'text':
        drawText(doc, el, box, pdfSafeText(elementText(el, input.values)), pdfFontName(elementFontFamily(el, design), el.fontWeight, el.fontStyle));
        break;
      case 'line':
        drawLine(doc, el, box);
        break;
      case 'qr':
        drawQr(doc, el, box, input.qrValue);
        break;
      case 'signature':
        drawImage(doc, el, box, signatureSlotOf(el) === 1 ? input.images.signature1 : input.images.signature2);
        break;
      case 'stamp':
        drawImage(doc, el, box, input.images.stamp);
        break;
      case 'image':
      case 'logo':
        drawImage(doc, el, box, el.assetId ? (input.images.assets.get(el.assetId) ?? null) : null);
        break;
    }
  }
  if (input.footer) drawFooter(doc, page, pdfSafeText(input.footer));
  if (input.watermark) drawWatermark(doc, page, pdfSafeText(input.watermark));
  doc.end();
  return done;
}

function drawBackground(doc: Doc, design: TemplateDesign, page: { width: number; height: number }, images: RenderImages) {
  doc.save();
  doc.rect(0, 0, page.width, page.height).fill(design.theme.backgroundColor);
  doc.restore();
  const assetId = design.theme.backgroundImageAssetId;
  const image = assetId ? images.assets.get(assetId) : undefined;
  if (image) {
    doc.save();
    doc.rect(0, 0, page.width, page.height).clip();
    doc.image(image, 0, 0, { cover: [page.width, page.height], align: 'center', valign: 'center' });
    doc.restore();
  }
}

function drawBorder(doc: Doc, design: TemplateDesign, page: { width: number; height: number }) {
  const border = design.theme.border;
  if (border.style === 'none') return;
  const inset = (border.inset / 100) * Math.min(page.width, page.height);
  const w = border.width;
  const outer = { x: inset + w / 2, y: inset + w / 2, w: page.width - 2 * inset - w, h: page.height - 2 * inset - w };
  doc.save();
  doc.lineJoin('miter');
  doc.lineWidth(w).strokeColor(border.color).rect(outer.x, outer.y, outer.w, outer.h).stroke();
  if (border.style === 'double' || border.style === 'ornamental') {
    const gap = Math.max(3, w * 2.5);
    const innerWidth = Math.max(0.5, w / 2);
    const inner = { x: outer.x + gap, y: outer.y + gap, w: outer.w - 2 * gap, h: outer.h - 2 * gap };
    doc.lineWidth(innerWidth).rect(inner.x, inner.y, inner.w, inner.h).stroke();
    if (border.style === 'ornamental') {
      const size = Math.max(5, w * 3);
      const accent = design.theme.accentColor;
      const corners: Array<[number, number]> = [
        [inner.x, inner.y],
        [inner.x + inner.w, inner.y],
        [inner.x, inner.y + inner.h],
        [inner.x + inner.w, inner.y + inner.h],
      ];
      const mids: Array<[number, number]> = [
        [inner.x + inner.w / 2, inner.y],
        [inner.x + inner.w / 2, inner.y + inner.h],
        [inner.x, inner.y + inner.h / 2],
        [inner.x + inner.w, inner.y + inner.h / 2],
      ];
      for (const [cx, cy] of corners) diamond(doc, cx, cy, size, accent, border.color);
      for (const [cx, cy] of mids) diamond(doc, cx, cy, size * 0.6, accent, border.color);
      // Fine dotted rule inside the double frame.
      const dot = gap + Math.max(2, w);
      doc
        .lineWidth(Math.max(0.35, w / 3))
        .dash(0.6, { space: 2.4 })
        .strokeColor(border.color)
        .rect(inner.x + dot, inner.y + dot, inner.w - 2 * dot, inner.h - 2 * dot)
        .stroke()
        .undash();
    }
  }
  doc.restore();
}

function diamond(doc: Doc, cx: number, cy: number, size: number, fill: string, stroke: string) {
  doc
    .save()
    .moveTo(cx, cy - size)
    .lineTo(cx + size, cy)
    .lineTo(cx, cy + size)
    .lineTo(cx - size, cy)
    .closePath()
    .lineWidth(0.5)
    .fillAndStroke(fill, stroke)
    .restore();
}

function textOptions(el: DesignElement, box: Box, size: number): PDFKit.Mixins.TextOptions {
  return {
    width: box.w,
    align: el.align,
    characterSpacing: el.letterSpacing,
    lineGap: Math.max(0, (el.lineHeight - 1) * size),
    lineBreak: true,
  };
}

/** Shrink the font until the text (and its longest word) fits the box, then center vertically. */
function drawText(doc: Doc, el: DesignElement, box: Box, text: string, font: string) {
  if (!text) return;
  doc.font(font);
  const longestWord = text.split(/\s+/).reduce((a, b) => (b.length > a.length ? b : a), '');
  let size = el.fontSize;
  let height = 0;
  for (;;) {
    doc.fontSize(size);
    height = doc.heightOfString(text, textOptions(el, box, size));
    const wordWidth = doc.widthOfString(longestWord, { characterSpacing: el.letterSpacing });
    if ((height <= box.h + 0.5 && wordWidth <= box.w) || size <= MIN_FONT_SIZE) break;
    size = Math.max(MIN_FONT_SIZE, size - 0.5);
  }
  const y = box.y + Math.max(0, (box.h - height) / 2);
  doc.save();
  doc.fillColor(el.color).fontSize(size);
  doc.text(text, box.x, y, { ...textOptions(el, box, size), height: Math.max(box.h, height) + 1, ellipsis: true });
  doc.restore();
}

function drawLine(doc: Doc, el: DesignElement, box: Box) {
  const y = box.y + box.h / 2;
  doc.save().moveTo(box.x, y).lineTo(box.x + box.w, y).lineWidth(el.strokeWidth).strokeColor(el.color).lineCap('butt').stroke().restore();
}

function drawImage(doc: Doc, el: DesignElement, box: Box, image: Buffer | null) {
  if (!image) return;
  doc.save();
  doc.image(image, box.x, box.y, { fit: [box.w, box.h], align: el.align, valign: 'center' });
  doc.restore();
}

/** QR code as vector modules (runs of dark modules merged per row) with a 2-module quiet zone. */
function drawQr(doc: Doc, el: DesignElement, box: Box, value: string) {
  const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 2;
  const side = Math.min(box.w, box.h);
  const cell = side / (n + quiet * 2);
  const ox = box.x + (el.align === 'left' ? 0 : el.align === 'right' ? box.w - side : (box.w - side) / 2);
  const oy = box.y + (box.h - side) / 2;
  doc.save();
  doc.rect(ox, oy, side, side).fill('#FFFFFF');
  for (let row = 0; row < n; row++) {
    let col = 0;
    while (col < n) {
      if (!qr.modules.get(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < n && qr.modules.get(row, col)) col++;
      doc.rect(ox + (start + quiet) * cell, oy + (row + quiet) * cell, (col - start) * cell + 0.02, cell + 0.02);
    }
  }
  doc.fill(el.color);
  doc.restore();
}

function drawFooter(doc: Doc, page: { width: number; height: number }, text: string) {
  doc.save();
  doc.font('Helvetica').fontSize(5.5).fillColor('#6B7280');
  doc.text(text, 0, page.height - 9, { width: page.width, align: 'center', lineBreak: false, height: 8 });
  doc.restore();
}

function drawWatermark(doc: Doc, page: { width: number; height: number }, text: string) {
  doc.save();
  doc.rotate(-28, { origin: [page.width / 2, page.height / 2] });
  doc.font('Helvetica-Bold').fontSize(Math.min(page.width, page.height) / 9).fillColor('#9CA3AF').fillOpacity(0.2);
  doc.text(text, -page.width, page.height / 2 - 30, { width: page.width * 3, align: 'center', lineBreak: false, height: 80 });
  doc.restore();
}
