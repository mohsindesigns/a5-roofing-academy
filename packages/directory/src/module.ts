import { Global, Module } from '@nestjs/common';
import { DATABASE } from '@a5/nest-kit';
import type { Kysely } from '@a5/database';
import { DirectoryProjection } from './projection.js';
import { DirectoryReader } from './scope.js';
import type { DirectorySchema } from './schema.js';

/** Registers the directory projection consumer and a reader for the service's database. */
@Global()
@Module({
  providers: [
    DirectoryProjection,
    { provide: DirectoryReader, inject: [DATABASE], useFactory: (db: Kysely<DirectorySchema>) => new DirectoryReader(db) },
  ],
  exports: [DirectoryReader],
})
export class DirectoryModule {}
