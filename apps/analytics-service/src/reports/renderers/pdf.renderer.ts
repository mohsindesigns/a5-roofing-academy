import type { Writable } from 'node:stream';
import PDFDocument from 'pdfkit';
import type { analytics } from '@a5/contracts';
import {
  displayValue,
  type RenderInput,
  type RenderResult,
  type ReportRenderer,
} from './renderer.js';

const MARGIN = 36;
const ROW_HEIGHT = 14;
const HEADER_HEIGHT = 18;
const FONT_SIZE = 7;
const CHARCOAL = '#2b2b2b';
const COPPER = '#b87333';
const MUTED = '#6b6b6b';
const ZEBRA = '#f4f1ee';

function weight(column: analytics.ReportColumn): number {
  switch (column.type) {
    case 'string':
      return column.key === 'employee' || column.key === 'item' || column.key === 'program'
        ? 2.2
        : 1.6;
    case 'datetime':
      return 1.6;
    default:
      return 1;
  }
}

/**
 * Printable landscape table (PDFKit, built-in Helvetica). Meant for reading and sharing, so it is
 * capped at `maxRows`; CSV and XLSX carry the full data.
 */
export class PdfRenderer implements ReportRenderer {
  readonly format = 'pdf' as const;
  readonly contentType = 'application/pdf';
  readonly extension = 'pdf';
  readonly maxRows = 2_000;

  async render(input: RenderInput, output: Writable): Promise<RenderResult> {
    const doc = new PDFDocument({
      size: 'LETTER',
      layout: 'landscape',
      margin: MARGIN,
      info: { Title: input.title, Author: 'A5 Roofing Sales Academy', Subject: input.subtitle },
    });
    doc.pipe(output);

    const usable = doc.page.width - MARGIN * 2;
    const totalWeight = input.columns.reduce((s, c) => s + weight(c), 0);
    const widths = input.columns.map((c) => (weight(c) / totalWeight) * usable);
    const bottom = () => doc.page.height - MARGIN - 14;
    let page = 1;

    const fit = (text: string, w: number): string => {
      const max = w - 6;
      if (doc.widthOfString(text) <= max) return text;
      let t = text;
      while (t.length > 1 && doc.widthOfString(`${t}…`) > max) t = t.slice(0, -1);
      return `${t}…`;
    };

    const footer = () => {
      doc.font('Helvetica').fontSize(7).fillColor(MUTED);
      doc.text(`${input.title} · Page ${page}`, MARGIN, doc.page.height - MARGIN - 8, {
        width: usable,
        align: 'right',
        lineBreak: false,
      });
    };

    const tableHeader = (y: number): number => {
      doc.rect(MARGIN, y, usable, HEADER_HEIGHT).fill(CHARCOAL);
      doc.font('Helvetica-Bold').fontSize(FONT_SIZE).fillColor('#ffffff');
      let x = MARGIN;
      input.columns.forEach((c, i) => {
        doc.text(fit(c.label, widths[i]!), x + 3, y + 6, {
          width: widths[i]! - 6,
          lineBreak: false,
        });
        x += widths[i]!;
      });
      return y + HEADER_HEIGHT;
    };

    doc.font('Helvetica-Bold').fontSize(16).fillColor(CHARCOAL).text(input.title, MARGIN, MARGIN);
    doc
      .moveTo(MARGIN, doc.y + 2)
      .lineTo(MARGIN + 60, doc.y + 2)
      .lineWidth(2)
      .strokeColor(COPPER)
      .stroke();
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(input.subtitle, MARGIN, doc.y + 8, { width: usable });
    let y = tableHeader(doc.y + 10);

    let rowCount = 0;
    for await (const row of input.rows) {
      if (y + ROW_HEIGHT > bottom()) {
        footer();
        doc.addPage();
        page += 1;
        y = tableHeader(MARGIN);
      }
      if (rowCount % 2 === 1) doc.rect(MARGIN, y, usable, ROW_HEIGHT).fill(ZEBRA);
      doc.font('Helvetica').fontSize(FONT_SIZE).fillColor(CHARCOAL);
      let x = MARGIN;
      input.columns.forEach((c, i) => {
        const text = displayValue(row[c.key] ?? null, c.type, input.timezone);
        const numeric = c.type === 'integer' || c.type === 'number' || c.type === 'percent';
        doc.text(fit(text, widths[i]!), x + 3, y + 4, {
          width: widths[i]! - 6,
          lineBreak: false,
          align: numeric ? 'right' : 'left',
        });
        x += widths[i]!;
      });
      y += ROW_HEIGHT;
      rowCount += 1;
    }

    if (rowCount === 0) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(MUTED)
        .text('No rows match these filters.', MARGIN, y + 8);
    }
    if (input.truncated?.()) {
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor(MUTED)
        .text(
          `Showing the first ${rowCount.toLocaleString('en-US')} rows. Export CSV or Excel for the complete report.`,
          MARGIN,
          Math.min(y + 6, bottom()),
        );
    }
    footer();
    const done = new Promise<void>((resolve, reject) => {
      output.once('finish', resolve);
      output.once('error', reject);
    });
    doc.end();
    await done;
    return { rowCount };
  }
}
