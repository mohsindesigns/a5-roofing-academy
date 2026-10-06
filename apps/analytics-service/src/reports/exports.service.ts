import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Principal, ScopeFilter } from '@a5/auth';
import type { analytics } from '@a5/contracts';
import { sql, type Selectable } from '@a5/database';
import { QueueFactory, type Job } from '@a5/messaging';
import {
  AppError,
  ConflictError,
  EventBus,
  InjectDb,
  LOGGER,
  NotFoundError,
  PreconditionError,
  runsWorkers,
} from '@a5/nest-kit';
import { uuidv7, type Logger } from '@a5/observability';
import { ANALYTICS_CONFIG, type AnalyticsConfig } from '../config.js';
import type { Db, ReportJobsTable } from '../database/index.js';
import { AnalyticsScope, cleanFilters } from '../common/scope.service.js';
import { StorageProvider } from '../storage/storage.provider.js';
import type { QueryContext } from '../analytics/query-context.js';
import { REPORTS_BY_KEY } from './report-definitions.js';
import { formatDateTime, RENDERERS } from './renderers/index.js';
import { ReportsService, type ReportRow } from './reports.service.js';

export const REPORT_QUEUE = 'analytics.report';
const MAX_ATTEMPTS = 3;
const STALE_QUEUED_MS = 5 * 60_000;
const STALE_RUNNING_MS = 30 * 60_000;

type ReportJobData = { kind: 'export'; exportId: string } | { kind: 'maintenance' };
type JobRow = Selectable<ReportJobsTable>;

const SCOPE_LABEL: Record<ScopeFilter['kind'], string> = {
  none: 'No access',
  own: 'Your own records',
  managed: 'Your teams and direct reports',
  organization: 'Whole organization',
  platform: 'Whole organization',
};

/**
 * Report exports: a `report_jobs` row per request, rendered by the `analytics.report` worker into
 * object storage and handed out through short-lived signed links. Files expire after the
 * configured retention; a maintenance job deletes them and recovers stuck jobs.
 */
@Injectable()
export class ExportsService implements OnModuleInit {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(ANALYTICS_CONFIG) private readonly config: AnalyticsConfig,
    private readonly queues: QueueFactory,
    private readonly events: EventBus,
    private readonly storage: StorageProvider,
    private readonly reports: ReportsService,
    private readonly scope: AnalyticsScope,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onModuleInit() {
    if (!runsWorkers(this.config)) return;
    this.queues.worker<ReportJobData>(REPORT_QUEUE, (job) => this.handle(job), { concurrency: 2 });
    await this.queues
      .queue<ReportJobData>(REPORT_QUEUE)
      .upsertJobScheduler(
        'analytics.report.maintenance',
        { every: 15 * 60_000 },
        { name: 'maintenance', data: { kind: 'maintenance' } },
      );
  }

  private async handle(job: Job<ReportJobData>): Promise<unknown> {
    if (job.data.kind === 'maintenance') return this.maintenance();
    return this.run(job.data.exportId, {
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? MAX_ATTEMPTS,
    });
  }

  private toDto(row: JobRow): analytics.ExportJob {
    return {
      id: row.id,
      report: row.report as analytics.ReportKey,
      reportTitle: REPORTS_BY_KEY.get(row.report as analytics.ReportKey)?.title ?? row.report,
      format: row.format as analytics.ExportFormat,
      status: row.status,
      filters: cleanFilters(row.filters),
      sort: row.sort,
      rowCount: row.row_count,
      fileName: row.file_name,
      fileSize: row.file_size === null ? null : Number(row.file_size),
      error: row.error,
      createdAt: row.created_at.toISOString(),
      startedAt: row.started_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
    };
  }

  async create(p: Principal, body: analytics.CreateExportRequest): Promise<analytics.ExportJob> {
    const def = this.reports.definition(body.report);
    if (!RENDERERS[body.format]) {
      throw new PreconditionError(
        'EXPORT_FORMAT_UNSUPPORTED',
        `${body.format.toUpperCase()} export is not available. Choose ${Object.keys(RENDERERS)
          .map((f) => f.toUpperCase())
          .join(' or ')}.`,
      );
    }
    this.reports.resolveSort(def, body.sort);
    const ctx = await this.scope.context(p, 'reports.export', body.filters ?? {});
    const id = uuidv7();
    const row = await this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('report_jobs')
        .values({
          id,
          organization_id: p.organizationId,
          requested_by: p.userId,
          report: def.key,
          format: body.format,
          filters: ctx.filters,
          sort: body.sort ?? null,
          search: body.q?.trim() || null,
          scope: ctx.scope as unknown as Record<string, unknown>,
          status: 'queued',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.events.audit(trx, {
        action: 'report.export_requested',
        resourceType: 'report_export',
        resourceId: id,
        actorDisplay: p.displayName,
        after: {
          report: def.key,
          format: body.format,
          filters: ctx.filters,
          scope: ctx.scope.kind,
        },
      });
      return inserted;
    });
    try {
      await this.enqueue(id);
    } catch (err) {
      // The row is committed; the maintenance job re-enqueues jobs that never reached the queue.
      this.logger.warn(
        { err, exportId: id },
        'could not enqueue report export; it will be retried',
      );
    }
    return this.toDto(row);
  }

  private async enqueue(exportId: string, jobId: string = exportId): Promise<void> {
    await this.queues.add<ReportJobData>(
      REPORT_QUEUE,
      'export',
      { kind: 'export', exportId },
      { jobId, attempts: MAX_ATTEMPTS },
    );
  }

  private async mine(p: Principal, id: string): Promise<JobRow> {
    const row = await this.db
      .selectFrom('report_jobs')
      .selectAll()
      .where('id', '=', id)
      .where('organization_id', '=', p.organizationId)
      .where('requested_by', '=', p.userId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Export');
    return row;
  }

  async get(p: Principal, id: string): Promise<analytics.ExportJob> {
    return this.toDto(await this.mine(p, id));
  }

  async list(
    p: Principal,
    page: number,
    pageSize: number,
  ): Promise<{
    items: analytics.ExportJob[];
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
  }> {
    const rows = await this.db
      .selectFrom('report_jobs')
      .selectAll()
      .select((eb) => eb.fn.countAll<number>().over().as('total'))
      .where('organization_id', '=', p.organizationId)
      .where('requested_by', '=', p.userId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    const total = rows.length
      ? Number(rows[0]!.total)
      : Number(
          (
            await this.db
              .selectFrom('report_jobs')
              .select((eb) => eb.fn.countAll<number>().as('n'))
              .where('organization_id', '=', p.organizationId)
              .where('requested_by', '=', p.userId)
              .executeTakeFirst()
          )?.n ?? 0,
        );
    return {
      items: rows.map((r) => this.toDto(r)),
      page,
      pageSize,
      total,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async download(p: Principal, id: string): Promise<analytics.ExportDownload> {
    const row = await this.mine(p, id);
    // Retention and link lifetimes are wall-clock concerns, independent of the analytics clock.
    const now = new Date();
    if (
      row.status === 'expired' ||
      (row.status === 'completed' && row.expires_at && row.expires_at <= now)
    ) {
      throw new AppError(
        410,
        'EXPORT_EXPIRED',
        'This export has expired. Run the export again to download a fresh copy.',
      );
    }
    if (row.status === 'failed') {
      throw new ConflictError(
        'EXPORT_FAILED',
        row.error ?? 'This export could not be created. Run it again or narrow the filters.',
      );
    }
    if (row.status !== 'completed' || !row.file_key || !row.file_name) {
      throw new ConflictError(
        'EXPORT_NOT_READY',
        'The export is still being prepared. Check again in a moment.',
      );
    }
    const ttl = this.config.exports.linkTtlSeconds;
    await this.events.audit(this.db, {
      action: 'report.export_downloaded',
      resourceType: 'report_export',
      resourceId: row.id,
      actorDisplay: p.displayName,
      after: { report: row.report, format: row.format, fileName: row.file_name },
    });
    const url = await this.storage.storage.signedGetUrl(row.file_key, {
      expiresInSeconds: ttl,
      downloadName: row.file_name,
      contentType: row.content_type ?? undefined,
    });
    return {
      url,
      fileName: row.file_name,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  private async describeFilters(ctx: QueryContext): Promise<string> {
    const f = ctx.filters;
    const names = await sql<{ kind: string; name: string }>`
      select 'team' as kind, name from dir_teams where id = ${f.teamId ?? null}
      union all select 'location', name from dir_units where id = ${f.locationId ?? null}
      union all select 'department', name from dir_units where id = ${f.departmentId ?? null}
      union all select 'manager', display_name from dir_users where id = ${f.managerId ?? null}
      union all select 'employee', display_name from dir_users where id = ${f.userId ?? null}
      union all select 'program', title from dim_programs where id = ${f.programId ?? null}
      union all select 'certification', name from dim_certifications where id = ${f.certificationId ?? null}
    `.execute(this.db);
    const label = new Map(names.rows.map((r) => [r.kind, r.name]));
    const parts: string[] = [];
    if (f.from || f.to) parts.push(`Dates: ${f.from ?? 'start'} to ${f.to ?? 'today'}`);
    const add = (key: string, title: string, present: unknown) => {
      if (present) parts.push(`${title}: ${label.get(key) ?? 'selected'}`);
    };
    add('program', 'Program', f.programId);
    add('certification', 'Certification', f.certificationId);
    add('team', 'Team', f.teamId);
    add('manager', 'Manager', f.managerId);
    add('department', 'Department', f.departmentId);
    add('location', 'Location', f.locationId);
    add('employee', 'Employee', f.userId);
    return parts.length ? parts.join(' · ') : 'No filters';
  }

  /** Render one export. Retries are handled by BullMQ; the final failure is recorded on the job. */
  async run(
    exportId: string,
    attempt: { attemptsMade: number; maxAttempts: number } = { attemptsMade: 0, maxAttempts: 1 },
  ): Promise<{ rowCount: number } | null> {
    const job = await this.db
      .selectFrom('report_jobs')
      .selectAll()
      .where('id', '=', exportId)
      .executeTakeFirst();
    if (!job || job.status === 'completed' || job.status === 'expired') return null;
    const renderer = RENDERERS[job.format as analytics.ExportFormat];
    const def = REPORTS_BY_KEY.get(job.report as analytics.ReportKey);
    if (!renderer || !def) {
      await this.fail(job.id, 'This export format or report is no longer available.');
      return null;
    }
    await this.db
      .updateTable('report_jobs')
      .set({ status: 'running', started_at: new Date(), attempts: sql`attempts + 1`, error: null })
      .where('id', '=', job.id)
      .execute();

    const tmp = join(tmpdir(), `a5-report-${job.id}-${process.pid}.${renderer.extension}`);
    try {
      const ctx = await this.scope.build(
        job.organization_id,
        job.scope as unknown as ScopeFilter,
        cleanFilters(job.filters),
      );
      const limit = Math.min(
        this.config.exports.maxRows,
        renderer.maxRows ?? Number.POSITIVE_INFINITY,
      );
      const source = this.reports.rows(
        ctx,
        def.key,
        { sort: job.sort ?? undefined, q: job.search ?? undefined },
        { maxRows: limit + 1 },
      );
      let truncated = false;
      const rows = (async function* (): AsyncGenerator<ReportRow> {
        let n = 0;
        for await (const row of source) {
          if (n >= limit) {
            truncated = true;
            return;
          }
          n += 1;
          yield row;
        }
      })();
      const subtitle = [
        `Generated ${formatDateTime(ctx.now.toISOString(), ctx.timezone)} (${ctx.timezone})`,
        `Scope: ${SCOPE_LABEL[ctx.scope.kind]}`,
        await this.describeFilters(ctx),
      ].join(' · ');
      const { rowCount } = await renderer.render(
        {
          title: def.title,
          subtitle,
          columns: def.columns,
          rows,
          timezone: ctx.timezone,
          truncated: () => truncated,
          rowLimit: limit,
        },
        createWriteStream(tmp),
      );
      const { size } = await stat(tmp);
      const date = ctx.now.toISOString().slice(0, 10);
      const fileName = `${def.key}-${date}.${renderer.extension}`;
      const key = `reports/${job.organization_id}/${job.id}/${fileName}`;
      await this.storage.storage.putObject(key, createReadStream(tmp), {
        contentType: renderer.contentType,
        contentLength: size,
      });
      const completedAt = new Date();
      await this.db
        .updateTable('report_jobs')
        .set({
          status: 'completed',
          row_count: rowCount,
          file_key: key,
          file_name: fileName,
          file_size: size,
          content_type: renderer.contentType,
          completed_at: completedAt,
          expires_at: new Date(
            completedAt.getTime() + this.config.exports.retentionHours * 3_600_000,
          ),
        })
        .where('id', '=', job.id)
        .execute();
      return { rowCount };
    } catch (err) {
      const final = attempt.attemptsMade + 1 >= attempt.maxAttempts;
      this.logger.warn({ err, exportId: job.id, final }, 'report export failed');
      if (final)
        await this.fail(
          job.id,
          'The export could not be created. Run it again; if it keeps failing, narrow the filters.',
        );
      else
        await this.db
          .updateTable('report_jobs')
          .set({ status: 'queued' })
          .where('id', '=', job.id)
          .execute();
      throw err;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  private async fail(id: string, message: string): Promise<void> {
    await this.db
      .updateTable('report_jobs')
      .set({ status: 'failed', error: message, completed_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Expire old files, re-enqueue jobs that never reached the queue and fail jobs stuck while running. */
  async maintenance(
    now = new Date(),
  ): Promise<{ expired: number; requeued: number; failed: number }> {
    const due = await this.db
      .selectFrom('report_jobs')
      .select(['id', 'file_key'])
      .where('status', '=', 'completed')
      .where('expires_at', '<=', now)
      .limit(500)
      .execute();
    for (const job of due) {
      if (job.file_key) {
        try {
          await this.storage.storage.deleteObject(job.file_key);
        } catch (err) {
          this.logger.warn({ err, exportId: job.id }, 'could not delete expired export file');
          continue;
        }
      }
      await this.db
        .updateTable('report_jobs')
        .set({ status: 'expired', file_key: null })
        .where('id', '=', job.id)
        .execute();
    }

    const queue = this.queues.queue<ReportJobData>(REPORT_QUEUE);
    const stale = await this.db
      .selectFrom('report_jobs')
      .select(['id'])
      .where('status', '=', 'queued')
      .where('created_at', '<', new Date(now.getTime() - STALE_QUEUED_MS))
      .limit(100)
      .execute();
    let requeued = 0;
    for (const job of stale) {
      const existing = await queue.getJob(job.id);
      const state = existing ? await existing.getState() : 'unknown';
      if (!existing || state === 'completed' || state === 'failed' || state === 'unknown') {
        await this.enqueue(job.id, `${job.id}.retry.${now.getTime()}`);
        requeued += 1;
      }
    }

    const stuck = await this.db
      .updateTable('report_jobs')
      .set({
        status: 'failed',
        error: 'The export took too long. Run it again with a narrower date range.',
        completed_at: now,
      })
      .where('status', '=', 'running')
      .where('started_at', '<', new Date(now.getTime() - STALE_RUNNING_MS))
      .executeTakeFirst();
    return { expired: due.length, requeued, failed: Number(stuck.numUpdatedRows ?? 0n) };
  }
}
