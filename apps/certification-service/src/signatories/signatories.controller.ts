import { Get, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@a5/auth';
import { certification } from '@a5/contracts';
import {
  ApiController,
  CurrentPrincipal,
  RequirePermissions,
  ZBody,
  ZParam,
  ZQuery,
  ZResponse,
} from '@a5/nest-kit';
import { SignatoriesService, StampsService } from './signatories.service.js';

const c = certification;

@ApiController('signatories')
export class SignatoriesController {
  constructor(private readonly signatories: SignatoriesService) {}

  @Get()
  @RequirePermissions('signatures.manage')
  @ZResponse(c.signatoryPageSchema)
  list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(c.listSignatoriesQuerySchema) q: z.infer<typeof c.listSignatoriesQuerySchema>,
  ) {
    return this.signatories.list(p, {
      q: q.q,
      active: q.active,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get(':id')
  @RequirePermissions('signatures.manage')
  @ZResponse(c.signatorySchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.signatories.get(p, id);
  }

  @Get(':id/signatures')
  @RequirePermissions('signatures.manage')
  @ZResponse(z.object({ items: z.array(c.imageVersionSchema) }))
  signatures(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.signatories.signatures(p, id);
  }

  @Post()
  @RequirePermissions('signatures.manage')
  @ZResponse(c.signatorySchema)
  create(
    @CurrentPrincipal() p: Principal,
    @ZBody(c.createSignatoryRequestSchema) body: z.infer<typeof c.createSignatoryRequestSchema>,
  ) {
    return this.signatories.create(p, body);
  }

  @Patch(':id')
  @RequirePermissions('signatures.manage')
  @ZResponse(c.signatorySchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(c.updateSignatoryRequestSchema) body: z.infer<typeof c.updateSignatoryRequestSchema>,
  ) {
    return this.signatories.update(p, id, body);
  }
}

@ApiController('stamps')
export class StampsController {
  constructor(private readonly stamps: StampsService) {}

  @Get()
  @RequirePermissions('stamps.manage')
  @ZResponse(c.stampPageSchema)
  list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(c.listSignatoriesQuerySchema) q: z.infer<typeof c.listSignatoriesQuerySchema>,
  ) {
    return this.stamps.list(p, { q: q.q, active: q.active, page: q.page, pageSize: q.pageSize });
  }

  @Get(':id')
  @RequirePermissions('stamps.manage')
  @ZResponse(c.stampSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.stamps.get(p, id);
  }

  @Post()
  @RequirePermissions('stamps.manage')
  @ZResponse(c.stampSchema)
  create(
    @CurrentPrincipal() p: Principal,
    @ZBody(c.createStampRequestSchema) body: z.infer<typeof c.createStampRequestSchema>,
  ) {
    return this.stamps.create(p, body);
  }

  @Patch(':id')
  @RequirePermissions('stamps.manage')
  @ZResponse(c.stampSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(c.updateStampRequestSchema) body: z.infer<typeof c.updateStampRequestSchema>,
  ) {
    return this.stamps.update(p, id, body);
  }
}
