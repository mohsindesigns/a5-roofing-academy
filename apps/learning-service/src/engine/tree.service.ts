import { Inject, Injectable } from '@nestjs/common';
import { Cache } from '@a5/messaging';
import { InjectDb } from '@a5/nest-kit';
import { LEARNING_CONFIG, type LearningConfig } from '../config.js';
import type { Db, DbOrTrx } from '../database/index.js';
import { treeFromSnapshot, type ProgramTree } from './tree.js';
import { loadWorkingTree } from './tree-loader.js';

/**
 * Loads program trees. The published tree (what learners see) is an immutable snapshot cached in
 * Redis under a versioned namespace per program; every structural change bumps the namespace.
 */
@Injectable()
export class TreeService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly cache: Cache,
    @Inject(LEARNING_CONFIG) private readonly config: LearningConfig,
  ) {}

  private namespace(programId: string): string {
    return `lrn:tree:${programId}`;
  }

  /** Invalidate cached trees of a program. Call after the change committed. */
  async bump(programId: string): Promise<void> {
    await this.cache.bump(this.namespace(programId));
  }

  /** The program's current published tree, or null when it was never published. */
  async published(programId: string, db: DbOrTrx = this.db): Promise<ProgramTree | null> {
    const program = await db
      .selectFrom('programs')
      .select(['published_version'])
      .where('id', '=', programId)
      .executeTakeFirst();
    if (!program || program.published_version === 0) return null;
    return this.version(programId, program.published_version, db);
  }

  /** A specific published version (immutable, so safe to cache). */
  async version(
    programId: string,
    version: number,
    db: DbOrTrx = this.db,
  ): Promise<ProgramTree | null> {
    const key = await this.cache.versioned(this.namespace(programId), 'published', version);
    const snapshot = await this.cache.getOrSet(
      key,
      this.config.learning.treeCacheSeconds,
      async () => {
        const row = await db
          .selectFrom('program_versions')
          .select('snapshot')
          .where('program_id', '=', programId)
          .where('version', '=', version)
          .executeTakeFirst();
        return row?.snapshot ?? null;
      },
    );
    return snapshot ? treeFromSnapshot(snapshot) : null;
  }

  /** The working copy without archived nodes (previews, publishing). Not cached. */
  working(programId: string, db: DbOrTrx = this.db): Promise<ProgramTree | null> {
    return loadWorkingTree(db, programId);
  }
}
