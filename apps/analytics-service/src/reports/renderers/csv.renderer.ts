import type { Writable } from 'node:stream';
import type { analytics } from '@a5/contracts';
import type { ReportRow } from '../reports.service.js';
import { finish, write, type RenderInput, type RenderResult, type ReportRenderer } from './renderer.js';

const BOM = '﻿';

function quote(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Text cells starting with a formula trigger are prefixed so spreadsheets never evaluate them. */
function neutralize(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function csvCell(value: ReportRow[string], type: analytics.ReportColumn['type']): string {
  if (value === null || value === undefined) return '';
  if (type === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  const text = String(value);
  return quote(type === 'string' ? neutralize(text) : text);
}

/**
 * RFC 4180 CSV (CRLF line endings, UTF-8 with BOM so Excel detects the encoding). Date-times are
 * ISO 8601 in UTC so the file stays machine-readable.
 */
export class CsvRenderer implements ReportRenderer {
  readonly format = 'csv' as const;
  readonly contentType = 'text/csv; charset=utf-8';
  readonly extension = 'csv';

  async render(input: RenderInput, output: Writable): Promise<RenderResult> {
    await write(output, BOM + input.columns.map((c) => quote(c.label)).join(',') + '\r\n');
    let rowCount = 0;
    let buffer = '';
    for await (const row of input.rows) {
      buffer += input.columns.map((c) => csvCell(row[c.key] ?? null, c.type)).join(',') + '\r\n';
      rowCount += 1;
      if (buffer.length > 64 * 1024) {
        await write(output, buffer);
        buffer = '';
      }
    }
    if (buffer) await write(output, buffer);
    await finish(output);
    return { rowCount };
  }
}
