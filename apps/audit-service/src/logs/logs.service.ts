import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { Principal } from '@a5/auth';
import { audit } from '@a5/contracts';
import type { Selectable } from '@a5/database';
import { ForbiddenError, NotFoundError, PreconditionError, ValidationError } from '@a5/nest-kit';
import { getContext, uuidv7 } from '@a5/observability';
import { AUDIT_CONFIG, type AuditConfig } from '../config.js';
import type { AuditLogsTable } from '../database/index.js';
import { csvLine } from './csv.js';
import { LogsRepository, type ResolvedFilter, type SummaryRow } from './logs.repository.js';

type Row = Selectable<AuditLogsTable>;
type Summary = audit.AuditLogSummary;

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_FACET_DAYS = 90;
const MAX_FACET_DAYS = 366;

function toSummary(row: SummaryRow): Summary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    occurredAt: row.occurred_at.toISOString(),
    actor: { type: row.actor_type, id: row.actor_id, displayName: row.actor_display },
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    reason: row.reason,
    service: row.service,
    ip: row.ip,
    hasChanges: row.has_changes,
  };
}

function toDetail(row: Row): audit.AuditLog {
  return {
    id: row.id,
    organizationId: row.organization_id,
    occurredAt: row.occurred_at.toISOString(),
    actor: { type: row.actor_type, id: row.actor_id, displayName: row.actor_display },
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    reason: row.reason,
    service: row.service,
    ip: row.ip,
    hasChanges: row.before !== null || row.after !== null,
    before: row.before ?? null,
    after: row.after ?? null,
    userAgent: row.user_agent,
    requestId: row.request_id,
    correlationId: row.correlation_id,
    metadata: row.metadata ?? {},
    recordedAt: row.recorded_at.toISOString(),
  };
}

/** Write a chunk honouring backpressure. Resolves false when the client went away. */
function writeChunk(res: Response, chunk: string, isClosed: () => boolean): Promise<boolean> {
  if (isClosed()) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(ok);
    };
    const onDrain = () => done(true);
    const onClose = () => done(false);
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

@Injectable()
export class LogsService {
  constructor(
    private readonly repo: LogsRepository,
    @Inject(AUDIT_CONFIG) private readonly config: AuditConfig,
  ) {}

  async list(p: Principal, q: audit.ListAuditLogsQuery): Promise<audit.AuditLogPage> {
    const { rows, nextCursor } = await this.repo.list(this.resolve(p, q), { limit: q.limit, cursor: q.cursor });
    return { items: rows.map(toSummary), nextCursor };
  }

  async get(p: Principal, id: string): Promise<audit.AuditLog> {
    const row = await this.repo.find(this.organizationFor(p, undefined), id);
    if (!row) throw new NotFoundError('Audit entry');
    return toDetail(row);
  }

  async history(p: Principal, resourceType: string, resourceId: string, q: audit.ResourceHistoryQuery): Promise<audit.AuditLogPage> {
    const filter: ResolvedFilter = { organizationId: this.organizationFor(p, undefined), resourceType, resourceId };
    const { rows, nextCursor } = await this.repo.list(filter, { limit: q.limit, cursor: q.cursor });
    return { items: rows.map(toSummary), nextCursor };
  }

  async facets(p: Principal, q: audit.AuditFacetsQuery): Promise<audit.AuditFacets> {
    const organizationId = this.organizationFor(p, q.organizationId);
    const to = q.to ? this.upperBound(q.to) : new Date();
    const from = q.from ? this.lowerBound(q.from) : new Date(to.getTime() - DEFAULT_FACET_DAYS * DAY_MS);
    this.assertRange(from, to);
    if (to.getTime() - from.getTime() > MAX_FACET_DAYS * DAY_MS) {
      throw new ValidationError([{ path: 'from', message: `Choose a range of at most ${MAX_FACET_DAYS} days.` }]);
    }
    const facets = await this.repo.facets(organizationId, from, to);
    return { from: from.toISOString(), to: to.toISOString(), ...facets };
  }

  /**
   * Stream the selection as CSV. Selections above the configured maximum are refused up front
   * (never silently truncated). The export itself is recorded in the trail.
   */
  async exportCsv(p: Principal, q: audit.AuditFilter, res: Response): Promise<void> {
    const filter = this.resolve(p, q);
    const max = this.config.exportMaxRows;
    const matches = await this.repo.countUpTo(filter, max + 1);
    if (matches > max) {
      throw new PreconditionError(
        'EXPORT_TOO_LARGE',
        `This export matches more than ${max.toLocaleString('en-US')} entries. Narrow the date range or add filters, then export again.`,
        { maxRows: max },
      );
    }
    const ctx = getContext();
    const now = new Date();
    await this.repo.append({
      id: uuidv7(),
      organizationId: filter.organizationId,
      occurredAt: now,
      actorId: p.userId,
      actorDisplay: p.displayName,
      action: 'audit_logs.exported',
      resourceType: 'audit_log',
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      requestId: ctx?.requestId ?? null,
      correlationId: ctx?.correlationId ?? null,
      metadata: { format: 'csv', filters: q, matchedEntries: matches },
    });

    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${now.toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const isClosed = () => closed;
    if (!(await writeChunk(res, csvLine(audit.AUDIT_EXPORT_COLUMNS), isClosed))) return;
    for await (const batch of this.repo.stream(filter, max)) {
      const chunk = batch
        .map((r) =>
          csvLine([
            r.occurred_at,
            r.action,
            r.actor_type,
            r.actor_id,
            r.actor_display,
            r.resource_type,
            r.resource_id,
            r.reason,
            r.service,
            r.ip,
            r.user_agent,
            r.request_id,
            r.correlation_id,
            r.before,
            r.after,
            r.id,
          ]),
        )
        .join('');
      if (!(await writeChunk(res, chunk, isClosed))) return;
    }
    res.end();
  }

  /** Which organization's trail the caller may read. Only platform scope can cross organizations. */
  private organizationFor(p: Principal, requested: string | undefined): string {
    if (requested && requested !== p.organizationId) {
      if (!p.canCrossOrganizations('audit_logs.view')) {
        throw new ForbiddenError('Only platform administrators can view another organization’s audit log.');
      }
      return requested;
    }
    return p.organizationId;
  }

  private lowerBound(value: string): Date {
    return new Date(DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value);
  }

  /** Exclusive upper bound: a plain date includes that whole day (UTC). */
  private upperBound(value: string): Date {
    return DATE_ONLY.test(value) ? new Date(new Date(`${value}T00:00:00.000Z`).getTime() + DAY_MS) : new Date(value);
  }

  private assertRange(from: Date | undefined, to: Date | undefined): void {
    if (from && to && from.getTime() >= to.getTime()) {
      throw new ValidationError([{ path: 'to', message: 'The end of the range must be after its start.' }]);
    }
  }

  private resolve(p: Principal, q: audit.AuditFilter): ResolvedFilter {
    const from = q.from ? this.lowerBound(q.from) : undefined;
    const to = q.to ? this.upperBound(q.to) : undefined;
    this.assertRange(from, to);
    return {
      organizationId: this.organizationFor(p, q.organizationId),
      from,
      to,
      actorId: q.actorId,
      actorType: q.actorType,
      actionPrefix: q.action,
      resourceType: q.resourceType,
      resourceId: q.resourceId,
      service: q.service,
      q: q.q,
    };
  }
}
