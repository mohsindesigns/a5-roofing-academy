import { Delete, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@a5/auth';
import { identity, okSchema } from '@a5/contracts';
import {
  ApiController,
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermissions,
  ZBody,
  ZParam,
  ZQuery,
  ZResponse,
} from '@a5/nest-kit';
import { UsersService } from './users.service.js';

type ListQuery = z.infer<typeof identity.listUsersQuerySchema>;

@ApiController('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('users.view')
  @ZResponse(identity.userPageSchema)
  list(@CurrentPrincipal() p: Principal, @ZQuery(identity.listUsersQuerySchema) q: ListQuery) {
    return this.users.list(p, {
      q: q.q,
      status: q.status,
      roleId: q.roleId,
      teamId: q.teamId,
      locationId: q.locationId,
      departmentId: q.departmentId,
      ids: q.ids,
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get(':id')
  @ZResponse(identity.userDetailSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.users.get(p, id);
  }

  @Post()
  @RequirePermissions('users.create', 'roles.assign')
  @ZResponse(identity.invitationResultSchema)
  create(
    @CurrentPrincipal() p: Principal,
    @ZBody(identity.createUserRequestSchema) body: z.infer<typeof identity.createUserRequestSchema>,
  ) {
    return this.users.create(p, body);
  }

  @Patch(':id')
  @RequirePermissions('users.update')
  @ZResponse(identity.userDetailSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(identity.updateUserRequestSchema) body: z.infer<typeof identity.updateUserRequestSchema>,
  ) {
    return this.users.update(p, id, body);
  }

  @Put(':id/roles')
  @RequirePermissions('roles.assign')
  @ZResponse(identity.userDetailSchema)
  setRoles(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(identity.setUserRolesRequestSchema) body: { roleIds: string[] },
  ) {
    return this.users.setRoles(p, id, body.roleIds);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermissions('users.disable')
  @ZResponse(identity.userDetailSchema)
  deactivate(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(identity.deactivateUserRequestSchema) body: { reason: string },
  ) {
    return this.users.deactivate(p, id, body.reason);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermissions('users.disable')
  @ZResponse(identity.userDetailSchema)
  reactivate(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.users.reactivate(p, id);
  }

  @Post(':id/invitation')
  @HttpCode(200)
  @RequirePermissions('users.create')
  @ZResponse(identity.invitationResultSchema)
  resendInvitation(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.users.resendInvitation(p, id);
  }

  @Delete(':id')
  @RequirePermissions('users.delete')
  @ZResponse(okSchema)
  async remove(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    await this.users.delete(p, id);
    return { ok: true as const };
  }

  @Get(':id/sessions')
  @RequireAnyPermission('sessions.view', 'users.view')
  @ZResponse(z.object({ items: z.array(identity.sessionSchema) }))
  async sessions(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return { items: await this.users.sessions(p, id) };
  }

  @Get(':id/login-history')
  @RequireAnyPermission('sessions.view', 'users.view')
  @ZResponse(z.object({ items: z.array(identity.loginHistoryEntrySchema) }))
  async loginHistory(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return { items: await this.users.loginHistory(p, id) };
  }

  @Delete(':id/sessions')
  @RequirePermissions('sessions.revoke')
  @ZResponse(z.object({ revoked: z.int() }))
  async revokeSessions(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return { revoked: await this.users.revokeSessions(p, id) };
  }
}
