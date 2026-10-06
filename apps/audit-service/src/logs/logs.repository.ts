import { Injectable } from '@nestjs/common';
import { sql, type Selectable, type SelectQueryBuilder } from '@a5/database';
import { InjectDb, ValidationError } from '@a5/nest-kit';
import type { AuditDatabase, AuditLogsTable, Db, DbOrTrx } from '../database/index.js';

type Row = Selectable<AuditLogsTable>;
type Query<O> = SelectQueryBuilder<AuditDatabase, 'audit_logs', O>;

/** A filter with dates resolved and the organization decided by the caller's permissions. */
export interface ResolvedFilter {
  organizationId: string;
  from?: Date;
  /** Exclusive. */
  to?: Date;
  actorId?: string;
  actorType?: 'user' | 'service' | 'system';
  actionPrefix?: string;
  resourceType?: string;
  resourceId?: string;
  service?: string;
  q?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Keyset cursor over (occurred_at, id); the timestamp keeps its microseconds as text. */
export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !id || !TIMESTAMP.test(at) || !UUID.test(id)) {
    throw new ValidationError([
      { path: 'cursor', message: 'This cursor is invalid. Reload the list and try again.' },
    ]);
  }
  return { at, id };
}

/** Escape LIKE wildcards so user input matches literally. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function applyFilters<O>(query: Query<O>, f: ResolvedFilter): Query<O> {
  let q = query.where('organization_id', '=', f.organizationId);
  if (f.from) q = q.where('occurred_at', '>=', f.from);
  if (f.to) q = q.where('occurred_at', '<', f.to);
  if (f.actorId) q = q.where('actor_id', '=', f.actorId);
  if (f.actorType) q = q.where('actor_type', '=', f.actorType);
  if (f.actionPrefix) q = q.where('action', 'like', `${escapeLike(f.actionPrefix)}%`);
  if (f.resourceType) q = q.where('resource_type', '=', f.resourceType);
  if (f.resourceId) q = q.where('resource_id', '=', f.resourceId);
  if (f.service) q = q.where('service', '=', f.service);
  if (f.q) {
    const pattern = `%${escapeLike(f.q)}%`;
    q = q.where((eb) =>
      eb.or([
        eb('actor_display', 'ilike', pattern),
        eb('action', 'ilike', pattern),
        eb('resource_type', 'ilike', pattern),
        eb('resource_id', 'ilike', pattern),
        eb('reason', 'ilike', pattern),
      ]),
    );
  }
  return q;
}

const cursorAt = sql<string>`to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface SummaryRow extends Pick<
  Row,
  | 'id'
  | 'organization_id'
  | 'occurred_at'
  | 'actor_type'
  | 'actor_id'
  | 'actor_display'
  | 'action'
  | 'resource_type'
  | 'resource_id'
  | 'reason'
  | 'service'
  | 'ip'
> {
  has_changes: boolean;
  cursor_at: string;
}

export interface FacetValue {
  value: string;
  count: number;
}

const FACET_LIMIT = 200;
const EXPORT_BATCH = 1_000;

@Injectable()
export class LogsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  /** One page, newest first, with a keyset cursor (stable under concurrent inserts). */
  async list(
    filter: ResolvedFilter,
    options: { limit: number; cursor?: string },
  ): Promise<{ rows: SummaryRow[]; nextCursor: string | null }> {
    let query = applyFilters(
      this.db
        .selectFrom('audit_logs')
        .select([
          'id',
          'organization_id',
          'occurred_at',
          'actor_type',
          'actor_id',
          'actor_display',
          'action',
          'resource_type',
          'resource_id',
          'reason',
          'service',
          'ip',
          sql<boolean>`("before" is not null or "after" is not null)`.as('has_changes'),
          cursorAt.as('cursor_at'),
        ]),
      filter,
    );
    if (options.cursor) {
      const c = decodeCursor(options.cursor);
      query = query.where(sql<boolean>`(occurred_at, id) < (${c.at}::timestamptz, ${c.id}::uuid)`);
    }
    const rows = await query
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(options.limit + 1)
      .execute();
    const page = rows.slice(0, options.limit);
    const last = page[page.length - 1];
    return {
      rows: page,
      nextCursor:
        rows.length > options.limit && last ? encodeCursor(last.cursor_at, last.id) : null,
    };
  }

  async find(organizationId: string, id: string): Promise<Row | undefined> {
    return this.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('id', '=', id)
      .where('organization_id', '=', organizationId)
      .limit(1)
      .executeTakeFirst();
  }

  async facets(
    organizationId: string,
    from: Date,
    to: Date,
  ): Promise<{ actions: FacetValue[]; resourceTypes: FacetValue[]; services: FacetValue[] }> {
    const group = async (column: 'action' | 'resource_type' | 'service'): Promise<FacetValue[]> => {
      const rows = await this.db
        .selectFrom('audit_logs')
        .select([
          sql<string>`${sql.ref(column)}`.as('value'),
          sql<number>`count(*)::int`.as('count'),
        ])
        .where('organization_id', '=', organizationId)
        .where('occurred_at', '>=', from)
        .where('occurred_at', '<', to)
        .groupBy(column)
        .orderBy('count', 'desc')
        .orderBy('value')
        .limit(FACET_LIMIT)
        .execute();
      return rows.map((r) => ({ value: r.value, count: r.count }));
    };
    const [actions, resourceTypes, services] = await Promise.all([
      group('action'),
      group('resource_type'),
      group('service'),
    ]);
    return { actions, resourceTypes, services };
  }

  /** Number of matching entries, counted only up to `cap` so huge selections stay cheap. */
  async countUpTo(filter: ResolvedFilter, cap: number): Promise<number> {
    const rows = await applyFilters(this.db.selectFrom('audit_logs').select('id'), filter)
      .limit(cap)
      .execute();
    return rows.length;
  }

  /** All matching entries, newest first, fetched in keyset batches. Stops after `max` rows. */
  async *stream(filter: ResolvedFilter, max: number): AsyncGenerator<Row[]> {
    let cursor: { at: string; id: string } | null = null;
    let remaining = max;
    while (remaining > 0) {
      const size = Math.min(EXPORT_BATCH, remaining);
      let query = applyFilters(
        this.db.selectFrom('audit_logs').selectAll().select(cursorAt.as('cursor_at')),
        filter,
      );
      if (cursor)
        query = query.where(
          sql<boolean>`(occurred_at, id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
        );
      const rows = await query
        .orderBy('occurred_at', 'desc')
        .orderBy('id', 'desc')
        .limit(size)
        .execute();
      if (rows.length === 0) return;
      yield rows;
      remaining -= rows.length;
      if (rows.length < size) return;
      const last = rows[rows.length - 1]!;
      cursor = { at: last.cursor_at, id: last.id };
    }
  }

  /** Append an entry written by the audit service itself (e.g. an export). */
  async append(
    entry: {
      id: string;
      organizationId: string | null;
      occurredAt: Date;
      actorId: string;
      actorDisplay: string;
      action: string;
      resourceType: string;
      ip: string | null;
      userAgent: string | null;
      requestId: string | null;
      correlationId: string | null;
      metadata: Record<string, unknown>;
    },
    db: DbOrTrx = this.db,
  ): Promise<void> {
    await db
      .insertInto('audit_logs')
      .values({
        id: entry.id,
        organization_id: entry.organizationId,
        occurred_at: entry.occurredAt,
        actor_type: 'user',
        actor_id: entry.actorId,
        actor_display: entry.actorDisplay,
        action: entry.action,
        resource_type: entry.resourceType,
        resource_id: null,
        before: null,
        after: null,
        reason: null,
        ip: entry.ip,
        user_agent: entry.userAgent,
        request_id: entry.requestId,
        correlation_id: entry.correlationId,
        service: 'audit-service',
        metadata: JSON.stringify(entry.metadata),
      })
      .execute();
  }
}
