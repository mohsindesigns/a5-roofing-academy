import { Get, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { Principal } from '@a5/auth';
import { analytics } from '@a5/contracts';
import {
  ApiController,
  AppError,
  CurrentPrincipal,
  NotFoundError,
  Public,
  RequirePermissions,
  ZBody,
  ZParam,
  ZQuery,
  ZResponse,
} from '@a5/nest-kit';
import { AnalyticsScope } from '../common/scope.service.js';
import { StorageProvider } from '../storage/storage.provider.js';
import { ExportsService } from './exports.service.js';
import { REPORTS, reportDefinitionDto } from './report-definitions.js';
import { ReportsService } from './reports.service.js';

type ReportQuery = z.infer<typeof analytics.reportQuerySchema>;

const fileQuerySchema = z.object({
  key: z.string().min(1).max(500),
  expires: z.coerce.number().int(),
  sig: z.string().min(16).max(200),
  download: z.string().max(200).optional(),
});

/**
 * Signed file route for the local storage driver (development and tests). Production uses S3
 * presigned URLs and this route answers 404. It is public: the HMAC signature is the credential.
 */
@ApiController('reports/files', 'reports')
export class ReportFilesController {
  constructor(private readonly files: StorageProvider) {}

  @Public()
  @Get('object')
  async object(@ZQuery(fileQuerySchema) q: z.infer<typeof fileQuerySchema>, @Res() res: Response) {
    const local = this.files.local;
    if (!local) throw new NotFoundError('File');
    if (!q.key.startsWith('reports/') || !local.verify(q.key, q.expires, q.sig, q.download ?? '')) {
      throw new AppError(
        403,
        'LINK_INVALID',
        'This download link is invalid or has expired. Request a new link from your exports.',
      );
    }
    const head = await local.headObject(q.key);
    if (!head) throw new NotFoundError('File');
    const object = await local.getObject(q.key);
    const name = (q.download ?? q.key.split('/').pop() ?? 'report').replace(/[^\w.-]+/g, '_');
    res.status(200);
    res.setHeader('content-type', object.contentType ?? 'application/octet-stream');
    res.setHeader('content-length', String(object.size));
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader(
      'content-disposition',
      `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    object.body.pipe(res);
  }
}

@ApiController('reports/exports', 'reports')
export class ReportExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post()
  @HttpCode(202)
  @RequirePermissions('reports.export')
  @ZResponse(analytics.exportJobSchema, 'Export queued')
  create(
    @CurrentPrincipal() p: Principal,
    @ZBody(analytics.createExportRequestSchema) body: analytics.CreateExportRequest,
  ) {
    return this.exports.create(p, body);
  }

  @Get()
  @RequirePermissions('reports.export')
  @ZResponse(analytics.exportPageSchema)
  list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(analytics.exportListQuerySchema) q: { page: number; pageSize: number },
  ) {
    return this.exports.list(p, q.page, q.pageSize);
  }

  @Get(':id')
  @RequirePermissions('reports.export')
  @ZResponse(analytics.exportJobSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.exports.get(p, id);
  }

  @Get(':id/download')
  @RequirePermissions('reports.export')
  @ZResponse(analytics.exportDownloadSchema)
  download(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.exports.download(p, id);
  }
}

@ApiController('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly scope: AnalyticsScope,
  ) {}

  @Get()
  @RequirePermissions('reports.view')
  @ZResponse(analytics.reportListSchema)
  list() {
    return { items: REPORTS.map(reportDefinitionDto) };
  }

  @Get(':report')
  @RequirePermissions('reports.view')
  @ZResponse(analytics.reportPageSchema)
  async run(
    @CurrentPrincipal() p: Principal,
    @ZParam('report', analytics.reportKeySchema) report: analytics.ReportKey,
    @ZQuery(analytics.reportQuerySchema) query: ReportQuery,
  ) {
    const ctx = await this.scope.context(p, 'reports.view', query);
    return this.reports.page(ctx, report, {
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
      q: query.q,
    });
  }
}
