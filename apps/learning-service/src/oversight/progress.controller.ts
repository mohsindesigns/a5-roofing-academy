import { Get } from '@nestjs/common';
import type { z } from 'zod';
import type { Principal } from '@a5/auth';
import { learning } from '@a5/contracts';
import { ApiController, CurrentPrincipal, RequirePermissions, ZParam, ZQuery, ZResponse } from '@a5/nest-kit';
import { TeamProgressService } from './team-progress.service.js';

type Out<T extends z.ZodType> = z.output<T>;
type Query = Out<typeof learning.teamProgressQuerySchema>;

/** Manager and trainer progress views (scoped to managed teams and assigned trainees). */
@ApiController('progress')
export class ProgressController {
  constructor(private readonly team: TeamProgressService) {}

  @Get('team')
  @RequirePermissions('enrollments.view')
  @ZResponse(learning.teamProgressPageSchema)
  list(@CurrentPrincipal() p: Principal, @ZQuery(learning.teamProgressQuerySchema) q: Query) {
    return this.team.list(p, { ...q });
  }

  @Get('teams/:teamId')
  @RequirePermissions('enrollments.view')
  @ZResponse(learning.teamProgressPageSchema)
  teamProgress(@CurrentPrincipal() p: Principal, @ZParam('teamId') teamId: string, @ZQuery(learning.teamProgressQuerySchema) q: Query) {
    return this.team.list(p, { ...q, teamId });
  }

  @Get('learners/:userId')
  @RequirePermissions('enrollments.view')
  @ZResponse(learning.learnerProgressSchema)
  learner(@CurrentPrincipal() p: Principal, @ZParam('userId') userId: string) {
    return this.team.learner(p, userId);
  }
}
