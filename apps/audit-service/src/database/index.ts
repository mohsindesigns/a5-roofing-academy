import type { Kysely, Transaction } from '@a5/database';
import type { AuditDatabase } from './schema.js';

export type Db = Kysely<AuditDatabase>;
export type Trx = Transaction<AuditDatabase>;
export type DbOrTrx = Db | Trx;
export * from './schema.js';

/** Serialize a value for a JSONB column; absent values become SQL NULL. */
export function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}
