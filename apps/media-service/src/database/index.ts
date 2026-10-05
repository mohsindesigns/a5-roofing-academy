import type { Kysely, Transaction } from '@a5/database';
import type { MediaDatabase } from './schema.js';

export type Db = Kysely<MediaDatabase>;
export type Trx = Transaction<MediaDatabase>;
export type DbOrTrx = Db | Trx;
export * from './schema.js';
