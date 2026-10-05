import type { Kysely, Transaction } from '@a5/database';
import type { AiDatabase } from './schema.js';

export type Db = Kysely<AiDatabase>;
export type Trx = Transaction<AiDatabase>;
export type DbOrTrx = Db | Trx;
export * from './schema.js';
