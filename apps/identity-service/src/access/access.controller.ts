import { Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@a5/auth';
import { identity } from '@a5/contracts';
import {
  ApiController,
  CurrentPrincipal,
  RequirePermissions,
  ZBody,
  ZParam,
  ZQuery,
  ZResponse,
} from '@a5/nest-kit';
import type { DataScope, PermissionKey } from '@a5/permissions';
import { RolesService } from './roles.service.js';

const matrixUpdateSchema = z.object({
  changes: z
    .array(
      z.object({
        roleId: z.uuid(),
        permissions: identity.setRolePermissionsRequestSchema.shape.permissions,
      }),
    )
    .min(1)
    .max(50),
  reason: z.string().trim().max(500).nullable().optional(),
});

@ApiController('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermissions('roles.view')
  @ZResponse(z.object({ items: z.array(identity.roleSummarySchema) }))
  async list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(z.object({ includeArchived: z.enum(['true', 'false']).optional() }))
    q: { includeArchived?: 'true' | 'false' },
  ) {
    return { items: await this.roles.list(p.organizationId, q.includeArchived === 'true') };
  }

  @Get(':id')
  @RequirePermissions('roles.view')
  @ZResponse(identity.roleDetailSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.roles.get(p.organizationId, id);
  }

  @Post()
  @RequirePermissions('roles.create')
  @ZResponse(identity.roleDetailSchema)
  create(
    @CurrentPrincipal() p: Principal,
    @ZBody(identity.createRoleRequestSchema) body: identity.CreateRoleRequest,
  ) {
    return this.roles.create(p, body);
  }

  @Patch(':id')
  @RequirePermissions('roles.update')
  @ZResponse(identity.roleDetailSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(identity.updateRoleRequestSchema)
    body: { name?: string; description?: string | null; dataScope?: DataScope },
  ) {
    return this.roles.update(p, id, body);
  }

  @Put(':id/permissions')
  @RequirePermissions('permissions.manage')
  @ZResponse(identity.roleDetailSchema)
  setPermissions(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(identity.setRolePermissionsRequestSchema)
    body: { permissions: PermissionKey[]; reason?: string | null },
  ) {
    return this.roles.setPermissions(p, id, body.permissions, body.reason);
  }

  @Post(':id/reset')
  @HttpCode(200)
  @RequirePermissions('permissions.manage')
  @ZResponse(identity.roleDetailSchema)
  reset(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.roles.resetToDefault(p, id);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('roles.update')
  @ZResponse(identity.roleDetailSchema)
  archive(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.roles.archive(p, id);
  }
}

@ApiController('permissions')
export class PermissionsController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermissions('roles.view')
  @ZResponse(identity.permissionCatalogSchema)
  catalog() {
    return this.roles.catalog();
  }

  @Get('matrix')
  @RequirePermissions('roles.view')
  @ZResponse(identity.permissionMatrixSchema)
  matrix(@CurrentPrincipal() p: Principal) {
    return this.roles.matrix(p.organizationId);
  }

  @Put('matrix')
  @RequirePermissions('permissions.manage')
  @ZResponse(identity.permissionMatrixSchema)
  saveMatrix(
    @CurrentPrincipal() p: Principal,
    @ZBody(matrixUpdateSchema) body: z.infer<typeof matrixUpdateSchema>,
  ) {
    return this.roles.setMatrix(p, body.changes, body.reason);
  }
}
