import { Inject, Module, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDb, LOGGER } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import type { Db } from '../database/index.js';
import { IamCache } from '../common/iam-cache.js';
import { PermissionsController, RolesController } from './access.controller.js';
import { PrincipalResolver } from './principal.resolver.js';
import { syncPermissionCatalog } from './provisioning.js';
import { RolesService } from './roles.service.js';

@Module({
  controllers: [RolesController, PermissionsController],
  providers: [RolesService, PrincipalResolver, IamCache],
  exports: [RolesService, PrincipalResolver, IamCache],
})
export class AccessModule implements OnApplicationBootstrap {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap() {
    await syncPermissionCatalog(this.db);
    this.logger.debug('permission catalog synchronised');
  }
}
