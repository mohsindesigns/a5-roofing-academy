import { Get, Inject } from '@nestjs/common';
import { z } from 'zod';
import { InjectDb, InternalController, NotFoundError, ZParam, ZQuery } from '@a5/nest-kit';
import { PrincipalResolver } from '../access/principal.resolver.js';
import { IamCache } from '../common/iam-cache.js';
import type { Db } from '../database/index.js';
import { AuthService } from '../auth/auth.service.js';

/** Service-to-service endpoints. Not routed by the gateway; require a service token. */
@InternalController('')
export class IdentityInternalController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly principals: PrincipalResolver,
    private readonly cache: IamCache,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  /**
   * Gateway fallback when its Redis lookup misses. When a session id is supplied the session is
   * verified against the database and its liveness key restored.
   */
  @Get('principals/:userId')
  async principal(
    @ZParam('userId') userId: string,
    @ZQuery(z.object({ sessionId: z.uuid().optional() })) q: { sessionId?: string },
  ) {
    if (q.sessionId) {
      const session = await this.db
        .selectFrom('sessions')
        .select(['id', 'expires_at', 'revoked_at', 'user_id'])
        .where('id', '=', q.sessionId)
        .executeTakeFirst();
      const active = Boolean(
        session &&
        !session.revoked_at &&
        session.expires_at > new Date() &&
        session.user_id === userId,
      );
      if (!active) return { principal: null, sessionActive: false };
      await this.cache.markSessionActive(session!.id, session!.expires_at);
    }
    const principal = await this.principals.resolveCached(userId);
    return { principal, sessionActive: true };
  }

  @Get('users')
  async users(
    @ZQuery(
      z.object({
        ids: z
          .string()
          .transform((v) => v.split(',').filter(Boolean))
          .pipe(z.array(z.uuid()).max(500)),
      }),
    )
    q: {
      ids: string[];
    },
  ) {
    if (q.ids.length === 0) return { items: [] };
    const rows = await this.db
      .selectFrom('users')
      .select([
        'id',
        'organization_id',
        'email',
        'first_name',
        'last_name',
        'employee_id',
        'job_title',
        'status',
      ])
      .where('id', 'in', q.ids)
      .execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        organizationId: r.organization_id,
        email: r.email,
        firstName: r.first_name,
        lastName: r.last_name,
        displayName: `${r.first_name} ${r.last_name}`,
        employeeId: r.employee_id,
        jobTitle: r.job_title,
        status: r.status,
      })),
    };
  }

  @Get('organizations/:id')
  async organization(@ZParam('id') id: string) {
    const org = await this.db
      .selectFrom('organizations')
      .select(['id', 'slug', 'name', 'legal_name', 'timezone', 'branding'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!org) throw new NotFoundError('Organization');
    return {
      id: org.id,
      slug: org.slug,
      name: org.name,
      legalName: org.legal_name,
      timezone: org.timezone,
      branding: org.branding,
    };
  }

  @Get('organizations/:id/feature-flags')
  async flags(@ZParam('id') id: string) {
    return this.auth.featureFlags(id);
  }
}
