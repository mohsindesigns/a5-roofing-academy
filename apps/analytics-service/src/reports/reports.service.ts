import { Injectable } from '@nestjs/common';
import type { analytics } from '@a5/contracts';
import { likePattern, sql } from '@a5/database';
import { InjectDb, ValidationError } from '@a5/nest-kit';
import type { RawBuilder } from 'kysely';
import type { Db } from '../database/index.js';
import { QuerySql, type QueryContext } from '../analytics/query-context.js';
import { REPORTS_BY_KEY, type ReportDefinition } from './report-definitions.js';

export type ReportRow = Record<string, string | number | boolean | null>;

export interface ReportRequest {
  sort?: string | undefined;
  q?: string | undefined;
}

interface ResolvedSort {
  key: string;
  descending: boolean;
  text: string;
}

function cell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string')
    return value;
  if (typeof value === 'bigint') return Number(value);
  return String(value);
}

/** Runs tabular reports with scope, filters, search, whitelisted sorting and pagination. */
@Injectable()
export class ReportsService {
  constructor(@InjectDb() private readonly db: Db) {}

  definition(key: analytics.ReportKey): ReportDefinition {
    const def = REPORTS_BY_KEY.get(key);
    if (!def) throw new ValidationError([{ path: 'report', message: 'Unknown report' }]);
    return def;
  }

  resolveSort(def: ReportDefinition, sort: string | undefined): ResolvedSort {
    const text = sort ?? def.defaultSort;
    const descending = text.startsWith('-');
    const key = descending ? text.slice(1) : text;
    const column = def.columns.find((c) => c.key === key && c.sortable);
    if (!column) {
      throw new ValidationError([
        {
          path: 'sort',
          message: `Sort by one of: ${def.columns
            .filter((c) => c.sortable)
            .map((c) => c.key)
            .join(', ')}`,
        },
      ]);
    }
    return { key, descending, text };
  }

  private source(
    def: ReportDefinition,
    ctx: QueryContext,
    request: ReportRequest,
  ): RawBuilder<Record<string, unknown>> {
    const inner = def.query(new QuerySql(ctx));
    const search = request.q?.trim();
    const where = search
      ? sql`where ${sql.ref(`r.${def.searchColumn}`)} ilike ${likePattern(search)}`
      : sql``;
    return sql<Record<string, unknown>>`select r.* from (${inner}) r ${where}`;
  }

  private ordered(
    def: ReportDefinition,
    sort: ResolvedSort,
    source: RawBuilder<unknown>,
    extra: RawBuilder<unknown>,
  ): RawBuilder<Record<string, unknown>> {
    const column = def.columns.find((c) => c.key === sort.key)!;
    const ref = sql.ref(`s.${sort.key}`);
    const expr = column.type === 'string' ? sql`lower(${ref})` : ref;
    const direction = sort.descending ? sql.raw('desc') : sql.raw('asc');
    return sql<Record<string, unknown>>`
      select s.*, count(*) over () as "__total"
      from (${source}) s
      order by ${expr} ${direction} nulls last, s."rowId" asc
      ${extra}
    `;
  }

  private toRow(def: ReportDefinition, raw: Record<string, unknown>): ReportRow {
    const row: ReportRow = {};
    if (raw.userId !== undefined) row.userId = cell(raw.userId);
    for (const c of def.columns) row[c.key] = cell(raw[c.key]);
    return row;
  }

  async page(
    ctx: QueryContext,
    key: analytics.ReportKey,
    request: ReportRequest & { page: number; pageSize: number },
  ): Promise<analytics.ReportPage> {
    const def = this.definition(key);
    const sort = this.resolveSort(def, request.sort);
    const offset = (request.page - 1) * request.pageSize;
    const result = await this.ordered(
      def,
      sort,
      this.source(def, ctx, request),
      sql`limit ${request.pageSize} offset ${offset}`,
    ).execute(this.db);
    let total = Number(result.rows[0]?.__total ?? 0);
    if (!result.rows.length && request.page > 1) {
      const count = await sql<{
        n: number;
      }>`select count(*) as n from (${this.source(def, ctx, request)}) c`.execute(this.db);
      total = Number(count.rows[0]?.n ?? 0);
    }
    return {
      report: def.key,
      title: def.title,
      columns: def.columns,
      sort: sort.text,
      items: result.rows.map((r) => this.toRow(def, r)),
      page: request.page,
      pageSize: request.pageSize,
      total,
      pageCount: Math.max(1, Math.ceil(total / request.pageSize)),
    };
  }

  /** Stream every row in report order, in bounded batches (exports). */
  async *rows(
    ctx: QueryContext,
    key: analytics.ReportKey,
    request: ReportRequest,
    options: { batchSize?: number; maxRows?: number } = {},
  ): AsyncGenerator<ReportRow> {
    const def = this.definition(key);
    const sort = this.resolveSort(def, request.sort);
    const batch = options.batchSize ?? 1_000;
    const max = options.maxRows ?? Number.POSITIVE_INFINITY;
    let offset = 0;
    while (offset < max) {
      const limit = Math.min(batch, max - offset);
      const result = await this.ordered(
        def,
        sort,
        this.source(def, ctx, request),
        sql`limit ${limit} offset ${offset}`,
      ).execute(this.db);
      for (const raw of result.rows) yield this.toRow(def, raw);
      if (result.rows.length < limit) return;
      offset += limit;
    }
  }
}
