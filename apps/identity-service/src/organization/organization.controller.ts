import { Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
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
import { OrganizationService } from './organization.service.js';

const includeArchived = z.object({ includeArchived: z.enum(['true', 'false']).optional() });
type IncludeArchived = z.infer<typeof includeArchived>;
const archiveBody = z.object({ archived: z.boolean() });

@ApiController('organization', 'organization')
export class OrganizationController {
  constructor(private readonly org: OrganizationService) {}

  @Get('structure')
  @RequireAnyPermission('organization.view', 'teams.view', 'users.view')
  @ZResponse(identity.orgStructureSchema)
  structure(@CurrentPrincipal() p: Principal) {
    return this.org.structure(p);
  }
}

@ApiController('locations', 'organization')
export class LocationsController {
  constructor(private readonly org: OrganizationService) {}

  @Get()
  @RequireAnyPermission('organization.view', 'users.view')
  @ZResponse(z.object({ items: z.array(identity.locationSchema) }))
  async list(@CurrentPrincipal() p: Principal, @ZQuery(includeArchived) q: IncludeArchived) {
    return { items: await this.org.locations(p.organizationId, q.includeArchived === 'true') };
  }

  @Post()
  @RequirePermissions('locations.manage')
  @ZResponse(identity.locationSchema)
  async create(
    @CurrentPrincipal() p: Principal,
    @ZBody(identity.upsertLocationRequestSchema)
    body: z.infer<typeof identity.upsertLocationRequestSchema>,
  ) {
    const id = await this.org.upsertUnit(p, 'location', null, body);
    return (await this.org.locations(p.organizationId, true)).find((l) => l.id === id)!;
  }

  @Patch(':id')
  @RequirePermissions('locations.manage')
  @ZResponse(identity.locationSchema)
  async update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(identity.upsertLocationRequestSchema)
    body: z.infer<typeof identity.upsertLocationRequestSchema>,
  ) {
    await this.org.upsertUnit(p, 'location', id, body);
    return (await this.org.locations(p.organizationId, true)).find((l) => l.id === id)!;
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('locations.manage')
  @ZResponse(okSchema)
  async archive(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(archiveBody) body: { archived: boolean },
  ) {
    await this.org.setUnitArchived(p, 'location', id, body.archived);
    return { ok: true as const };
  }
}

@ApiController('departments', 'organization')
export class DepartmentsController {
  constructor(private readonly org: OrganizationService) {}

  @Get()
  @RequireAnyPermission('organization.view', 'users.view')
  @ZResponse(z.object({ items: z.array(identity.departmentSchema) }))
  async list(@CurrentPrincipal() p: Principal, @ZQuery(includeArchived) q: IncludeArchived) {
    return { items: await this.org.departments(p.organizationId, q.includeArchived === 'true') };
  }

  @Post()
  @RequirePermissions('departments.manage')
  @ZResponse(identity.departmentSchema)
  async create(
    @CurrentPrincipal() p: Principal,
    @ZBody(identity.upsertDepartmentRequestSchema)
    body: z.infer<typeof identity.upsertDepartmentRequestSchema>,
  ) {
    const id = await this.org.upsertUnit(p, 'department', null, body);
    return (await this.org.departments(p.organizationId, true)).find((d) => d.id === id)!;
  }

  @Patch(':id')
  @RequirePermissions('departments.manage')
  @ZResponse(identity.departmentSchema)
  async update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(identity.upsertDepartmentRequestSchema)
    body: z.infer<typeof identity.upsertDepartmentRequestSchema>,
  ) {
    await this.org.upsertUnit(p, 'department', id, body);
    return (await this.org.departments(p.organizationId, true)).find((d) => d.id === id)!;
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('departments.manage')
  @ZResponse(okSchema)
  async archive(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(archiveBody) body: { archived: boolean },
  ) {
    await this.org.setUnitArchived(p, 'department', id, body.archived);
    return { ok: true as const };
  }
}

@ApiController('teams', 'organization')
export class TeamsController {
  constructor(private readonly org: OrganizationService) {}

  @Get()
  @RequirePermissions('teams.view')
  @ZResponse(z.object({ items: z.array(identity.teamSummarySchema) }))
  async list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(identity.listTeamsQuerySchema) q: z.infer<typeof identity.listTeamsQuerySchema>,
  ) {
    return { items: await this.org.teams(p, q) };
  }

  @Get(':id')
  @RequirePermissions('teams.view')
  @ZResponse(identity.teamDetailSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.org.team(p, id);
  }

  @Post()
  @RequirePermissions('teams.manage')
  @ZResponse(identity.teamDetailSchema)
  async create(
    @CurrentPrincipal() p: Principal,
    @ZBody(identity.upsertTeamRequestSchema) body: z.infer<typeof identity.upsertTeamRequestSchema>,
  ) {
    return this.org.team(p, await this.org.upsertTeam(p, null, body));
  }

  @Patch(':id')
  @RequirePermissions('teams.manage')
  @ZResponse(identity.teamDetailSchema)
  async update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(identity.upsertTeamRequestSchema) body: z.infer<typeof identity.upsertTeamRequestSchema>,
  ) {
    return this.org.team(p, await this.org.upsertTeam(p, id, body));
  }

  @Put(':id/members')
  @RequirePermissions('teams.manage')
  @ZResponse(identity.teamDetailSchema)
  async members(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(identity.setTeamMembersRequestSchema) body: { memberIds: string[] },
  ) {
    await this.org.setTeamMembers(p, id, body.memberIds);
    return this.org.team(p, id);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('teams.manage')
  @ZResponse(okSchema)
  async archive(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(archiveBody) body: { archived: boolean },
  ) {
    await this.org.setTeamArchived(p, id, body.archived);
    return { ok: true as const };
  }
}

@ApiController('settings', 'settings')
export class SettingsController {
  constructor(private readonly org: OrganizationService) {}

  @Get('organization')
  @RequireAnyPermission('settings.view', 'organization.view')
  @ZResponse(identity.organizationSettingsSchema)
  get(@CurrentPrincipal() p: Principal) {
    return this.org.settings(p.organizationId);
  }

  @Put('organization')
  @RequirePermissions('organization.update')
  @ZResponse(identity.organizationSettingsSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZBody(identity.organizationSettingsSchema) body: identity.OrganizationSettings,
  ) {
    return this.org.updateSettings(p, body);
  }

  @Get('security')
  @RequireAnyPermission('settings.view', 'security_settings.manage')
  @ZResponse(identity.securitySettingsSchema)
  security(@CurrentPrincipal() p: Principal) {
    return this.org.security(p.organizationId);
  }

  @Put('security')
  @RequirePermissions('security_settings.manage')
  @ZResponse(identity.securitySettingsSchema)
  updateSecurity(
    @CurrentPrincipal() p: Principal,
    @ZBody(identity.securitySettingsSchema) body: identity.SecuritySettings,
  ) {
    return this.org.updateSecurity(p, body);
  }
}

@ApiController('feature-flags', 'settings')
export class FeatureFlagsController {
  constructor(private readonly org: OrganizationService) {}

  @Get()
  @ZResponse(z.object({ items: z.array(identity.featureFlagEntrySchema) }))
  async list(@CurrentPrincipal() p: Principal) {
    return { items: await this.org.featureFlags(p.organizationId) };
  }

  @Put(':key')
  @RequirePermissions('feature_flags.manage')
  @ZResponse(z.object({ items: z.array(identity.featureFlagEntrySchema) }))
  async set(
    @CurrentPrincipal() p: Principal,
    @ZParam('key', z.string().regex(/^[a-z_]+$/)) key: string,
    @ZBody(identity.setFeatureFlagRequestSchema) body: { enabled: boolean },
  ) {
    return { items: await this.org.setFeatureFlag(p, key, body.enabled) };
  }
}
