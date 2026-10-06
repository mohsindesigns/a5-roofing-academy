import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PEOPLE, TEAMS } from '@a5/seed-data';
import { ExportsService } from '../src/reports/exports.service.js';
import { csvCell } from '../src/reports/renderers/csv.renderer.js';
import { RENDERERS } from '../src/reports/renderers/index.js';
import { StorageProvider } from '../src/storage/storage.provider.js';
import { createAnalyticsHarness, type AnalyticsHarness } from './harness.js';

let h: AnalyticsHarness;
let exportsService: ExportsService;
let storage: StorageProvider;
let admin: Record<string, string>;

beforeAll(async () => {
  h = await createAnalyticsHarness('exports', { seed: true });
  exportsService = h.app.get(ExportsService, { strict: false });
  storage = h.app.get(StorageProvider, { strict: false });
  admin = await h.as('grant');
});
afterAll(() => h?.close());

interface Created {
  id: string;
  status: string;
}

async function create(body: Record<string, unknown>, who: Record<string, string> = admin) {
  return h.http.post('/api/v1/reports/exports').set(who).send(body);
}

/** Create an export and render it now (the worker is not running in api-role tests). */
async function render(body: Record<string, unknown>, who: Record<string, string> = admin) {
  const res = await create(body, who);
  expect(res.status).toBe(202);
  await exportsService.run((res.body as Created).id);
  return (await h.http.get(`/api/v1/reports/exports/${res.body.id}`).set(who)).body;
}

async function fetchFile(who: Record<string, string>, id: string): Promise<Buffer> {
  const link = await h.http.get(`/api/v1/reports/exports/${id}/download`).set(who);
  expect(link.status).toBe(200);
  const url = new URL(link.body.url);
  // The signed route is public: no principal header is sent.
  const file = await h.http
    .get(url.pathname + url.search)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  expect(file.status).toBe(200);
  return file.body as Buffer;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe('CSV export', () => {
  it('queues a job, renders the report to storage and serves it through a signed link', async () => {
    const queued = await create({ report: 'training-completion', format: 'csv', sort: 'employee' });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({
      report: 'training-completion',
      reportTitle: 'Training completion',
      format: 'csv',
      status: 'queued',
      sort: 'employee',
      rowCount: null,
      fileName: null,
      filters: {},
    });
    const id = queued.body.id as string;

    // Not ready yet: a clear, retryable answer.
    const early = await h.http.get(`/api/v1/reports/exports/${id}/download`).set(admin);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('EXPORT_NOT_READY');

    // A BullMQ job with the export id as job id was enqueued.
    const job = await h.app.get(ExportsService, { strict: false }).run(id);
    expect(job).toEqual({ rowCount: 16 });

    const done = (await h.http.get(`/api/v1/reports/exports/${id}`).set(admin)).body;
    expect(done).toMatchObject({
      status: 'completed',
      rowCount: 16,
      fileName: 'training-completion-2026-10-05.csv',
      error: null,
    });
    expect(done.fileSize).toBeGreaterThan(500);
    expect(Date.parse(done.expiresAt) - Date.parse(done.completedAt)).toBe(72 * 3_600_000);

    const link = await h.http.get(`/api/v1/reports/exports/${id}/download`).set(admin);
    expect(link.body.fileName).toBe('training-completion-2026-10-05.csv');
    expect(link.body.url).toMatch(
      /^http:\/\/localhost:4000\/api\/v1\/reports\/files\/object\?key=reports%2F/,
    );
    expect(Date.parse(link.body.expiresAt)).toBeGreaterThan(Date.now());

    const bytes = await fetchFile(admin, id);
    const text = bytes.toString('utf8');
    expect(text.startsWith('﻿Employee,Employee ID,Team,Location,Program,Status,')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    const rows = parseCsv(text.slice(1));
    expect(rows).toHaveLength(17);
    expect(rows[0]).toEqual([
      'Employee',
      'Employee ID',
      'Team',
      'Location',
      'Program',
      'Status',
      'Progress %',
      'Required lessons done',
      'Required lessons',
      'Enrolled',
      'Due',
      'Completed',
      'Days to complete',
      'Overdue',
    ]);
    expect(rows.every((r) => r.length === rows[0]!.length)).toBe(true);
    // Sorted by employee name.
    const employees = rows.slice(1).map((r) => r[0]!);
    expect(employees).toEqual(
      [...employees].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    );
    const ashlyn = rows.find((r) => r[0] === 'Ashlyn Pierce')!;
    expect(ashlyn.slice(0, 9)).toEqual([
      'Ashlyn Pierce',
      'A5-1207',
      'Dallas Residential A',
      'Dallas',
      'A5 New Hire Sales Academy',
      'completed',
      '100',
      '25',
      '25',
    ]);
    expect(ashlyn[9]).toBe('2025-03-03T14:00:00.000Z');
    expect(ashlyn[13]).toBe('No');
    const marcus = rows.find((r) => r[0] === 'Marcus Delgado')!;
    expect(marcus[5]).toBe('active');
    expect(marcus[11]).toBe('');
    expect(marcus[13]).toBe('Yes');
  });

  it('matches the report endpoint row for row, including filters and search', async () => {
    const filters = { teamId: TEAMS[0].id, from: '2026-08-01', to: '2026-10-05' };
    const job = await render({
      report: 'overdue-training',
      format: 'csv',
      filters,
      sort: '-daysOverdue',
    });
    expect(job.filters).toEqual(filters);
    const rows = parseCsv((await fetchFile(admin, job.id)).toString('utf8').slice(1));
    const api = await h.http
      .get(
        `/api/v1/reports/overdue-training?pageSize=100&sort=-daysOverdue&teamId=${filters.teamId}&from=${filters.from}&to=${filters.to}`,
      )
      .set(admin);
    expect(rows.length - 1).toBe(api.body.total);
    expect(rows.slice(1).map((r) => r[0])).toEqual(
      api.body.items.map((r: { employee: string }) => r.employee),
    );
    expect(rows.slice(1).map((r) => Number(r[6]))).toEqual(
      api.body.items.map((r: { daysOverdue: number }) => r.daysOverdue),
    );

    const searched = await render({ report: 'training-completion', format: 'csv', q: 'pierce' });
    expect(parseCsv((await fetchFile(admin, searched.id)).toString('utf8').slice(1))).toHaveLength(
      2,
    );
  });

  it('exports only what the requester may see', async () => {
    const danielle = await h.as('danielle');
    const job = await render({ report: 'training-completion', format: 'csv' }, danielle);
    expect(job.rowCount).toBe(5);
    const text = (await fetchFile(danielle, job.id)).toString('utf8');
    expect(text).toContain('Marcus Delgado');
    expect(text).not.toMatch(/Naomi|Brianna|Sofia|Jasmine/);

    const outside = await create(
      { report: 'training-completion', format: 'csv', filters: { teamId: TEAMS[2].id } },
      danielle,
    );
    expect(outside.status).toBe(403);
    expect(
      (
        await create(
          { report: 'training-completion', format: 'csv', filters: { userId: PEOPLE.naomi.id } },
          danielle,
        )
      ).status,
    ).toBe(403);
  });

  it('keeps exports private to the person who requested them', async () => {
    const mine = await create(
      { report: 'certification-status', format: 'csv' },
      await h.as('danielle'),
    );
    const other = await h.as('andre');
    expect((await h.http.get(`/api/v1/reports/exports/${mine.body.id}`).set(other)).status).toBe(
      404,
    );
    expect(
      (await h.http.get(`/api/v1/reports/exports/${mine.body.id}/download`).set(other)).status,
    ).toBe(404);
    const list = await h.http.get('/api/v1/reports/exports').set(other);
    expect(list.body.items.find((j: Created) => j.id === mine.body.id)).toBeUndefined();
    const own = await h.http
      .get('/api/v1/reports/exports?pageSize=2&page=1')
      .set(await h.as('danielle'));
    expect(own.body.items.map((j: Created) => j.id)).toContain(mine.body.id);
    expect(own.body).toMatchObject({ page: 1, pageSize: 2 });
  });

  it('requires reports.export', async () => {
    const body = { report: 'training-completion', format: 'csv' };
    expect((await create(body, await h.as('ruth'))).status).toBe(403);
    expect((await create(body, await h.as('hector'))).status).toBe(403);
    expect((await create(body, await h.as('marcus'))).status).toBe(403);
    expect((await h.http.post('/api/v1/reports/exports').send(body)).status).toBe(401);
  });

  it('validates the request', async () => {
    expect((await create({ report: 'payroll', format: 'csv' })).status).toBe(400);
    expect((await create({ report: 'training-completion', format: 'docx' })).status).toBe(400);
    const sort = await create({ report: 'training-completion', format: 'csv', sort: 'password' });
    expect(sort.status).toBe(400);
    expect(sort.body.error.fields[0].path).toBe('sort');
    expect(
      (
        await create({
          report: 'training-completion',
          format: 'csv',
          filters: { from: '2026-10-05', to: '2026-09-01' },
        })
      ).status,
    ).toBe(400);
    expect((await h.http.get('/api/v1/reports/exports/not-a-uuid').set(admin)).status).toBe(400);
    expect(
      (await h.http.get('/api/v1/reports/exports/0190a3b2-0000-7000-8000-0000000000ff').set(admin))
        .status,
    ).toBe(404);
  });
});

describe('signed download links', () => {
  it('rejects tampered, foreign and expired links', async () => {
    const job = await render({ report: 'training-completion', format: 'csv' });
    const link = (await h.http.get(`/api/v1/reports/exports/${job.id}/download`).set(admin)).body;
    const url = new URL(link.url);

    const tampered = new URL(url);
    tampered.searchParams.set(
      'key',
      tampered.searchParams.get('key')!.replace('training-completion', 'certification-status'),
    );
    const bad = await h.http.get(tampered.pathname + tampered.search);
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('LINK_INVALID');

    const forged = new URL(url);
    forged.searchParams.set('sig', 'A'.repeat(43));
    expect((await h.http.get(forged.pathname + forged.search)).status).toBe(403);

    const stale = new URL(url);
    stale.searchParams.set('expires', String(Math.floor(Date.now() / 1000) - 10));
    expect((await h.http.get(stale.pathname + stale.search)).status).toBe(403);

    // Only report files are served from this route.
    const local = storage.local!;
    const expires = Math.floor(Date.now() / 1000) + 60;
    const outside = `/api/v1/reports/files/object?key=${encodeURIComponent('secrets/other.txt')}&expires=${expires}&sig=${local.sign('secrets/other.txt', expires)}`;
    expect((await h.http.get(outside)).status).toBe(403);

    const ok = await h.http.get(url.pathname + url.search);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^text\/csv/);
    expect(ok.headers['content-disposition']).toContain('training-completion-2026-10-05.csv');
    expect(ok.headers['cache-control']).toBe('private, no-store');
  });
});

describe('other formats', () => {
  it('writes a valid Excel workbook with typed cells', async () => {
    const job = await render({ report: 'certification-status', format: 'xlsx', sort: 'issuedAt' });
    expect(job).toMatchObject({
      status: 'completed',
      rowCount: 4,
      fileName: 'certification-status-2026-10-05.xlsx',
    });
    const bytes = await fetchFile(admin, job.id);
    expect(bytes.subarray(0, 2).toString()).toBe('PK');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.read(Readable.from(bytes));
    expect(workbook.worksheets.map((w) => w.name)).toEqual(['Certification status', 'About']);
    const sheet = workbook.getWorksheet('Certification status')!;
    expect(sheet.rowCount).toBe(5);
    expect(sheet.getRow(1).values).toEqual([
      undefined,
      'Employee',
      'Employee ID',
      'Team',
      'Certification',
      'Certificate number',
      'Status',
      'Issued',
      'Expires',
      'Days until expiry',
    ]);
    const sofia = sheet.getRow(2);
    expect(sofia.getCell(1).value).toBe('Sofia Navarro');
    expect(sofia.getCell(6).value).toBe('issued');
    // Dates are real date cells showing local wall-clock time (Central), not text.
    expect(sofia.getCell(8).value).toBeInstanceOf(Date);
    expect((sofia.getCell(8).value as Date).toISOString()).toBe('2026-11-22T10:00:00.000Z');
    expect(sofia.getCell(9).value).toBe(49);
    expect(sheet.getRow(4).getCell(6).value).toBe('superseded');
    expect(sheet.getRow(4).getCell(9).value).toBeNull();
  });

  it('writes a printable PDF', async () => {
    const job = await render({ report: 'overdue-training', format: 'pdf' });
    expect(job).toMatchObject({
      status: 'completed',
      rowCount: 6,
      fileName: 'overdue-training-2026-10-05.pdf',
    });
    const bytes = await fetchFile(admin, job.id);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.subarray(-6).toString()).toContain('%%EOF');
    expect(bytes.length).toBeGreaterThan(2_000);
  });

  it('answers 422 for a format without a renderer', async () => {
    const pdf = RENDERERS.pdf;
    delete RENDERERS.pdf;
    try {
      const res = await create({ report: 'training-completion', format: 'pdf' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('EXPORT_FORMAT_UNSUPPORTED');
      expect(res.body.error.message).toMatch(/CSV or XLSX/);
    } finally {
      RENDERERS.pdf = pdf;
    }
  });
});

describe('formula safety', () => {
  it('neutralizes text that spreadsheets would evaluate', () => {
    expect(csvCell('=HYPERLINK("http://evil.example")', 'string')).toBe(
      `"'=HYPERLINK(""http://evil.example"")"`,
    );
    expect(csvCell('+1 (214) 555-1000', 'string')).toBe("'+1 (214) 555-1000");
    expect(csvCell('@SUM(A1)', 'string')).toBe("'@SUM(A1)");
    expect(csvCell('Marcus, Jr.', 'string')).toBe('"Marcus, Jr."');
    expect(csvCell(-3, 'integer')).toBe('-3');
    expect(csvCell(null, 'string')).toBe('');
    expect(csvCell(true, 'boolean')).toBe('Yes');
  });
});

describe('retention', () => {
  it('expires old files, deletes them from storage and refuses their downloads', async () => {
    const job = await render({ report: 'training-engagement', format: 'csv' });
    const row = await h.db
      .selectFrom('report_jobs')
      .select(['file_key'])
      .where('id', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(await storage.storage.headObject(row.file_key!)).not.toBeNull();

    // Within the retention window nothing happens.
    expect((await exportsService.maintenance(new Date())).expired).toBe(0);
    expect((await h.http.get(`/api/v1/reports/exports/${job.id}`).set(admin)).body.status).toBe(
      'completed',
    );

    // 72 hours later the file is removed and the job is marked expired.
    const later = new Date(Date.now() + 73 * 3_600_000);
    const result = await exportsService.maintenance(later);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await storage.storage.headObject(row.file_key!)).toBeNull();
    const after = (await h.http.get(`/api/v1/reports/exports/${job.id}`).set(admin)).body;
    expect(after.status).toBe('expired');
    const download = await h.http.get(`/api/v1/reports/exports/${job.id}/download`).set(admin);
    expect(download.status).toBe(410);
    expect(download.body.error.code).toBe('EXPORT_EXPIRED');
  });

  it('refuses a download once the retention time passed even before the sweep ran', async () => {
    const job = await render({ report: 'training-engagement', format: 'csv' });
    await h.db
      .updateTable('report_jobs')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', job.id)
      .execute();
    expect((await h.http.get(`/api/v1/reports/exports/${job.id}/download`).set(admin)).status).toBe(
      410,
    );
  });

  it('fails stuck jobs and records a readable error on failure', async () => {
    const job = await create({ report: 'training-completion', format: 'csv' });
    await h.db
      .updateTable('report_jobs')
      .set({ status: 'running', started_at: new Date(Date.now() - 3 * 3_600_000) })
      .where('id', '=', job.body.id)
      .execute();
    const result = await exportsService.maintenance(new Date());
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const failed = (await h.http.get(`/api/v1/reports/exports/${job.body.id}`).set(admin)).body;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/narrower date range/);
    const download = await h.http.get(`/api/v1/reports/exports/${job.body.id}/download`).set(admin);
    expect(download.status).toBe(409);
    expect(download.body.error.code).toBe('EXPORT_FAILED');
  });
});
