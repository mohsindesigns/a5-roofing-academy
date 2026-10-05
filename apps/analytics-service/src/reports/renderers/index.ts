import type { analytics } from '@a5/contracts';
import { CsvRenderer } from './csv.renderer.js';
import { PdfRenderer } from './pdf.renderer.js';
import type { ReportRenderer } from './renderer.js';
import { XlsxRenderer } from './xlsx.renderer.js';

export * from './renderer.js';

/** Available export formats. A format missing here is rejected with 422 EXPORT_FORMAT_UNSUPPORTED. */
export const RENDERERS: Partial<Record<analytics.ExportFormat, ReportRenderer>> = {
  csv: new CsvRenderer(),
  xlsx: new XlsxRenderer(),
  pdf: new PdfRenderer(),
};
