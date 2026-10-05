import { Get, Res } from '@nestjs/common';
import { ApiProduces } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import type { Principal } from '@a5/auth';
import { audit } from '@a5/contracts';
import { ApiController, CurrentPrincipal, RequirePermissions, ZParam, ZQuery, ZResponse } from '@a5/nest-kit';
import { LogsService } from './logs.service.js';

const resourceTypeParam = z.string().trim().min(1).max(100);
const resourceIdParam = z.string().trim().min(1).max(200);

/** Read access to the immutable audit trail. Nothing here can create, change or delete entries. */
@ApiController('audit')
@RequirePermissions('audit_logs.view')
export class LogsController {
  constructor(private readonly logs: LogsService) {}

  /** Filtered entries, newest first, with keyset pagination (`nextCursor`). */
  @Get('logs')
  @ZResponse(audit.auditLogPageSchema)
  list(@CurrentPrincipal() p: Principal, @ZQuery(audit.listAuditLogsQuerySchema) q: audit.ListAuditLogsQuery) {
    return this.logs.list(p, q);
  }

  @Get('logs/:id')
  @ZResponse(audit.auditLogSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.logs.get(p, id);
  }

  /** Everything that happened to one resource, newest first. */
  @Get('resources/:resourceType/:resourceId/history')
  @ZResponse(audit.auditLogPageSchema)
  history(
    @CurrentPrincipal() p: Principal,
    @ZParam('resourceType', resourceTypeParam) resourceType: string,
    @ZParam('resourceId', resourceIdParam) resourceId: string,
    @ZQuery(audit.resourceHistoryQuerySchema) q: audit.ResourceHistoryQuery,
  ) {
    return this.logs.history(p, resourceType, resourceId, q);
  }

  /** Distinct actions, resource types and services (with counts) for building filters. */
  @Get('facets')
  @ZResponse(audit.auditFacetsSchema)
  facets(@CurrentPrincipal() p: Principal, @ZQuery(audit.auditFacetsQuerySchema) q: audit.AuditFacetsQuery) {
    return this.logs.facets(p, q);
  }

  /** Stream the filtered entries as CSV (bounded; the export is itself recorded). */
  @Get('export')
  @ApiProduces('text/csv')
  async export(@CurrentPrincipal() p: Principal, @ZQuery(audit.auditFilterSchema) q: audit.AuditFilter, @Res() res: Response): Promise<void> {
    await this.logs.exportCsv(p, q, res);
  }
}
