import { Get } from '@nestjs/common';
import { learning } from '@a5/contracts';
import { InjectDb, InternalController, NotFoundError, ZParam, ZResponse } from '@a5/nest-kit';
import type { Db } from '../database/index.js';
import { requirementMap } from '../engine/tree.js';
import { TreeService } from '../engine/tree.service.js';

/** Service-to-service reads (service token required; never routed by the gateway). */
@InternalController('programs')
export class LearningInternalController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly trees: TreeService,
  ) {}

  /** Published structure and requirement map, e.g. for certification eligibility setup. */
  @Get(':id/summary')
  @ZResponse(learning.internalProgramSummarySchema)
  async summary(@ZParam('id') id: string): Promise<learning.InternalProgramSummary> {
    const program = await this.db
      .selectFrom('programs')
      .select(['id', 'organization_id', 'status', 'published_version'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!program) throw new NotFoundError('Program');
    const tree = await this.trees.published(id);
    if (!tree) throw new NotFoundError('Published program');
    const map = requirementMap(tree);
    return {
      id,
      organizationId: program.organization_id,
      title: tree.title,
      status: program.status,
      publishedVersion: program.published_version,
      phaseLabel: tree.phaseLabel,
      phases: map.phases.map((p) => ({
        id: p.phaseId,
        title: p.title,
        position: p.position,
        requiredLessonIds: p.requiredLessonIds,
      })),
      requiredLessonIds: map.requiredLessonIds,
      assessments: map.assessments,
      aiScenarios: map.aiScenarios,
    };
  }
}
