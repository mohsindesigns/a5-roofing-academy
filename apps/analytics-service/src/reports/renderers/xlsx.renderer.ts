import type { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import type { analytics } from '@a5/contracts';
import type { ReportRow } from '../reports.service.js';
import {
  wallClockDate,
  type RenderInput,
  type RenderResult,
  type ReportRenderer,
} from './renderer.js';

const NUMBER_FORMATS: Partial<Record<analytics.ReportColumn['type'], string>> = {
  integer: '0',
  number: '0.0',
  percent: '0.0',
  datetime: 'yyyy-mm-dd hh:mm',
  date: 'yyyy-mm-dd',
};

function width(column: analytics.ReportColumn): number {
  if (column.type === 'datetime') return 18;
  if (column.type === 'string') return Math.max(14, Math.min(40, column.label.length + 6));
  return Math.max(10, column.label.length + 2);
}

/** Excel sheet names: max 31 characters, no []:*?/\ characters. */
function sheetName(title: string): string {
  return title.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Report';
}

/**
 * Streaming XLSX writer (exceljs WorkbookWriter): rows are committed as they arrive so memory
 * stays flat for large reports. Date-times are written in the reporting time zone.
 */
export class XlsxRenderer implements ReportRenderer {
  readonly format = 'xlsx' as const;
  readonly contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  readonly extension = 'xlsx';

  private cell(
    value: ReportRow[string],
    column: analytics.ReportColumn,
    timezone: string,
  ): ExcelJS.CellValue {
    if (value === null || value === undefined) return null;
    if (column.type === 'datetime' || column.type === 'date')
      return wallClockDate(String(value), timezone);
    if (column.type === 'boolean') return value ? 'Yes' : 'No';
    return value;
  }

  async render(input: RenderInput, output: Writable): Promise<RenderResult> {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: output,
      useStyles: true,
      useSharedStrings: false,
    });
    workbook.creator = 'A5 Roofing Sales Academy';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet(sheetName(input.title), {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    sheet.columns = input.columns.map((c) => ({
      header: c.label,
      key: c.key,
      width: width(c),
      style: NUMBER_FORMATS[c.type] ? { numFmt: NUMBER_FORMATS[c.type]! } : {},
    }));
    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.commit();

    let rowCount = 0;
    for await (const row of input.rows) {
      sheet
        .addRow(input.columns.map((c) => this.cell(row[c.key] ?? null, c, input.timezone)))
        .commit();
      rowCount += 1;
    }
    sheet.commit();

    const about = workbook.addWorksheet('About');
    about.columns = [
      { header: 'Report', key: 'k', width: 22 },
      { header: input.title, key: 'v', width: 80 },
    ];
    about.getRow(1).font = { bold: true };
    about.getRow(1).commit();
    about.addRow(['Details', input.subtitle]).commit();
    about.addRow(['Rows', rowCount]).commit();
    if (input.truncated?.()) {
      about
        .addRow([
          'Note',
          `Limited to the first ${rowCount.toLocaleString('en-US')} rows. Narrow the filters to export the rest.`,
        ])
        .commit();
    }
    about.addRow(['Times shown in', input.timezone]).commit();
    about.commit();

    await workbook.commit();
    return { rowCount };
  }
}
