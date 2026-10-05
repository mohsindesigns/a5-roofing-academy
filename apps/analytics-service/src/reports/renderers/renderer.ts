import { once } from 'node:events';
import type { Writable } from 'node:stream';
import type { analytics } from '@a5/contracts';
import type { ReportRow } from '../reports.service.js';

export interface RenderInput {
  title: string;
  /** Context line: generation time, scope and filters. */
  subtitle: string;
  columns: analytics.ReportColumn[];
  rows: AsyncIterable<ReportRow>;
  /** Reporting time zone for human-readable dates. */
  timezone: string;
  /** Called after the rows are consumed: true when the export row limit cut the report short. */
  truncated?: () => boolean;
  /** Row limit that applied, for the truncation note. */
  rowLimit?: number;
}

export interface RenderResult {
  rowCount: number;
}

/**
 * Writes a report to a stream in one file format. Renderers stream rows (constant memory) and
 * must end the output stream when done.
 */
export interface ReportRenderer {
  readonly format: analytics.ExportFormat;
  readonly contentType: string;
  readonly extension: string;
  /** Formats meant for reading (PDF) cap the number of rows. */
  readonly maxRows?: number;
  render(input: RenderInput, output: Writable): Promise<RenderResult>;
}

/** Write with back-pressure. */
export async function write(output: Writable, chunk: string | Buffer): Promise<void> {
  if (!output.write(chunk)) await once(output, 'drain');
}

export async function finish(output: Writable): Promise<void> {
  if (output.writableFinished) return;
  const done = once(output, 'finish');
  output.end();
  await done;
}

/** Wall-clock date/time of an instant in a time zone, e.g. "Oct 5, 2026, 10:00 AM". */
export function formatDateTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

/**
 * A Date whose UTC fields equal the wall-clock time of `iso` in `timezone`. Spreadsheet date cells
 * have no time zone, so this makes Excel show the same local time people see in the app.
 */
export function wallClockDate(iso: string, timezone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')));
}

/** Human-readable cell text (PDF and CSV booleans). */
export function displayValue(value: ReportRow[string], type: analytics.ReportColumn['type'], timezone: string): string {
  if (value === null || value === undefined) return '';
  switch (type) {
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'datetime':
      return formatDateTime(String(value), timezone);
    case 'percent':
    case 'number':
      return typeof value === 'number' ? value.toFixed(1).replace(/\.0$/, '') : String(value);
    default:
      return String(value);
  }
}
