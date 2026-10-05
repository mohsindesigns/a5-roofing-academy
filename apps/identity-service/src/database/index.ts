import type { Kysely, Transaction } from '@a5/database';
import type { IdentityDatabase } from './schema.js';

export type Db = Kysely<IdentityDatabase>;
export type Trx = Transaction<IdentityDatabase>;
export type DbOrTrx = Db | Trx;
export * from './schema.js';
