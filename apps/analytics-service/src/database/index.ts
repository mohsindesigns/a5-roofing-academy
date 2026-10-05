import type { Kysely, Transaction } from '@a5/database';
import type { AnalyticsDatabase } from './schema.js';

export type Db = Kysely<AnalyticsDatabase>;
export type Trx = Transaction<AnalyticsDatabase>;
export type DbOrTrx = Db | Trx;
export * from './schema.js';
