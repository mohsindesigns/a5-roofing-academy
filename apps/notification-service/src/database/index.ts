import type { Kysely, Transaction } from '@a5/database';
import type { NotificationDatabase } from './schema.js';

export type Db = Kysely<NotificationDatabase>;
export type Trx = Transaction<NotificationDatabase>;
export type DbOrTrx = Db | Trx;
export * from './schema.js';

/** Serialize a value for a JSONB column (arrays would otherwise be sent as Postgres arrays). */
export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}
