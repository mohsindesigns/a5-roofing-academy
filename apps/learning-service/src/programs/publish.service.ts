import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { learning } from '@a5/contracts';
import { EventBus, InjectDb } from '@a5/nest-kit';
import type { Db } from '../database/index.js';
import { ProgressService } from '../engine/progress.service.js';
import { TreeService } from '../engine/tree.service.js';
import { ProgramsService } from './programs.service.js';
import { PublishCore } from './publish-core.js';

/** "Publish changes" for the program builder. The transaction itself lives in {@link PublishCore}. */
@Injectable()
export class PublishService {
  private readonly core: PublishCore;

  constructor(
    @InjectDb() private readonly db: Db,
    events: EventBus,
    private readonly trees: TreeService,
    progress: ProgressService,
    private readonly programs: ProgramsService,
  ) {
    this.core = new PublishCore(events, progress);
  }

  async publish(
    p: Principal,
    programId: string,
    changeNote: string,
  ): Promise<{ version: learning.ProgramVersion; program: learning.ProgramDetail }> {
    const version = await this.db
      .transaction()
      .execute((trx) =>
        this.core.publish(trx, {
          organizationId: p.organizationId,
          programId,
          changeNote,
          actor: { userId: p.userId, displayName: p.displayName },
        }),
      );
    await this.trees.bump(programId);
    const versions = await this.programs.versions(p, programId);
    return {
      version: versions.find((v) => v.version === version)!,
      program: await this.programs.get(p, programId),
    };
  }
}
