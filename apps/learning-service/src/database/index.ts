import type { Kysely, Transaction } from '@a5/database';
import type { LearningDatabase } from './schema.js';

export type Db = Kysely<LearningDatabase>;
export type Trx = Transaction<LearningDatabase>;
export type DbOrTrx = Db | Trx;
export * from './schema.js';
