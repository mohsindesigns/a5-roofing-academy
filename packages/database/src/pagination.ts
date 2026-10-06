import type { SelectQueryBuilder } from 'kysely';

export interface PageRequest {
  page: number;
  pageSize: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

/**
 * Offset pagination for admin tables (bounded page sizes, total count via window function so the
 * filter is evaluated once).
 */
export async function paginate<DB, TB extends keyof DB, O>(
  query: SelectQueryBuilder<DB, TB, O>,
  { page, pageSize }: PageRequest,
): Promise<Page<O>> {
  const rows = await query
    .select((eb) => eb.fn.countAll<number>().over().as('__total'))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();
  const total = rows.length
    ? Number((rows[0] as { __total: number }).__total)
    : await countFallback(query);
  const items = rows.map((r) => {
    const { __total: _ignored, ...rest } = r as O & { __total: number };
    return rest as O;
  });
  return { items, page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

async function countFallback<DB, TB extends keyof DB, O>(
  query: SelectQueryBuilder<DB, TB, O>,
): Promise<number> {
  // Requested page is past the end: count separately so the UI can still show totals.
  const result = await query
    .clearSelect()
    .clearOrderBy()
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirst();
  return Number((result as { count?: number } | undefined)?.count ?? 0);
}

/** Escape LIKE wildcards in user input. */
export function likePattern(input: string): string {
  return `%${input.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
