import { sql, type Kysely } from '@a5/database';

/** First day (UTC) of the month containing `date`. */
export function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function addMonths(month: Date, months: number): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + months, 1));
}

/** Partition name for the month containing `date`, e.g. `audit_logs_y2026m11`. */
export function partitionName(date: Date): string {
  const m = monthStart(date);
  return `audit_logs_y${m.getUTCFullYear()}m${String(m.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The months from the one containing `from` through the one containing `to`, inclusive. */
export function monthsBetween(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  for (let m = monthStart(from); m <= monthStart(to); m = addMonths(m, 1)) out.push(m);
  return out;
}

/**
 * Create the monthly partitions that are missing (idempotent). Returns the names created. Rows
 * already collected in the default partition for a created month are moved into it by the
 * database function, without deleting anything.
 */
export async function ensurePartitions(
  db: Kysely<unknown>,
  months: Iterable<Date>,
): Promise<string[]> {
  const created: string[] = [];
  for (const month of months) {
    const day = monthStart(month).toISOString().slice(0, 10);
    const result = await sql<{
      name: string | null;
    }>`select audit_logs_ensure_partition(${day}::date) as name`.execute(db);
    const name = result.rows[0]?.name;
    if (name) created.push(name);
  }
  return created;
}

/** Ensure the current month and `monthsAhead` following months exist. */
export function ensureUpcomingPartitions(
  db: Kysely<unknown>,
  monthsAhead: number,
  now = new Date(),
): Promise<string[]> {
  return ensurePartitions(db, monthsBetween(now, addMonths(monthStart(now), monthsAhead)));
}

export interface PartitionInfo {
  name: string;
  /** `null` for the default partition. */
  from: string | null;
  to: string | null;
  rows: number;
}

/** Partitions of the audit table with their ranges and exact row counts (for operators and tests). */
export async function listPartitions(db: Kysely<unknown>): Promise<PartitionInfo[]> {
  const result = await sql<{ name: string; bound: string }>`
    select c.relname as name, pg_get_expr(c.relpartbound, c.oid) as bound
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'audit_logs'::regclass
    order by c.relname
  `.execute(db);
  const out: PartitionInfo[] = [];
  for (const row of result.rows) {
    const match = /FROM \('([^']+)'\) TO \('([^']+)'\)/.exec(row.bound);
    const count = await sql<{
      n: number;
    }>`select count(*)::int as n from ${sql.table(row.name)}`.execute(db);
    out.push({
      name: row.name,
      from: match?.[1] ?? null,
      to: match?.[2] ?? null,
      rows: count.rows[0]?.n ?? 0,
    });
  }
  return out;
}
