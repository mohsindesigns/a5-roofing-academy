import type { Kysely, Transaction } from '@a5/database';
import type { CertificationDatabase } from './schema.js';

export type Db = Kysely<CertificationDatabase>;
export type Trx = Transaction<CertificationDatabase>;
export type DbOrTrx = Db | Trx;
export * from './schema.js';
