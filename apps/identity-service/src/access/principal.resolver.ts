import { Inject, Injectable } from '@nestjs/common';
import type { PrincipalData } from '@a5/auth';
import { InjectDb, InjectRedis } from '@a5/nest-kit';
import { RedisNamespace, type Redis } from '@a5/messaging';
import { widestScope, type DataScope, type PermissionKey, type PermissionMap } from '@a5/permissions';
import type { Db } from '../database/index.js';
import { PRINCIPAL_CACHE_TTL_SECONDS, iamKeys } from '../common/iam-keys.js';

export interface CachedPrincipal {
  epoch: number;
  data: PrincipalData;
}

/**
 * Computes a user's effective authorization: permissions with the widest granting scope, managed
 * teams and directly supervised users. Results are cached for the gateway, keyed by the
 * organization's authorization epoch so role edits invalidate every principal at once.
 */
@Injectable()
export class PrincipalResolver {
  constructor(
    @InjectDb() private readonly db: Db,
    @InjectRedis() private readonly redis: Redis,
    @Inject(RedisNamespace) private readonly ns: RedisNamespace,
  ) {}

  async compute(userId: string, sessionId: string | null = null): Promise<PrincipalData | null> {
    const user = await this.db
      .selectFrom('users')
      .select(['id', 'organization_id', 'first_name', 'last_name', 'status'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user || user.status !== 'active') return null;

    const [grants, roleKeys, managedTeams, supervised] = await Promise.all([
      this.db
        .selectFrom('user_roles as ur')
        .innerJoin('roles as r', 'r.id', 'ur.role_id')
        .innerJoin('role_permissions as rp', 'rp.role_id', 'r.id')
        .select(['rp.permission_key', 'r.data_scope'])
        .where('ur.user_id', '=', userId)
        .where('r.archived_at', 'is', null)
        .execute(),
      this.db
        .selectFrom('user_roles as ur')
        .innerJoin('roles as r', 'r.id', 'ur.role_id')
        .select('r.key')
        .where('ur.user_id', '=', userId)
        .where('r.archived_at', 'is', null)
        .execute(),
      this.db
        .selectFrom('team_managers as tm')
        .innerJoin('teams as t', 't.id', 'tm.team_id')
        .select('tm.team_id')
        .where('tm.user_id', '=', userId)
        .where('t.archived_at', 'is', null)
        .execute(),
      this.db.selectFrom('user_relationships').select('user_id').where('supervisor_id', '=', userId).execute(),
    ]);

    const permissions: PermissionMap = {};
    for (const g of grants) {
      const key = g.permission_key as PermissionKey;
      const existing = permissions[key];
      permissions[key] = existing ? widestScope(existing, g.data_scope as DataScope) : (g.data_scope as DataScope);
    }

    return {
      userId: user.id,
      organizationId: user.organization_id,
      sessionId,
      displayName: `${user.first_name} ${user.last_name}`,
      roles: roleKeys.map((r) => r.key),
      permissions,
      managedTeamIds: [...new Set(managedTeams.map((t) => t.team_id))],
      managedUserIds: [...new Set(supervised.map((s) => s.user_id))],
    };
  }

  /** Cached resolution used by the gateway. Session id is not cached (it varies per device). */
  async resolveCached(userId: string): Promise<PrincipalData | null> {
    const user = await this.db.selectFrom('users').select('organization_id').where('id', '=', userId).executeTakeFirst();
    if (!user) return null;
    const [epochRaw, cachedRaw] = await this.redis.mget(
      iamKeys.epoch(this.ns, user.organization_id),
      iamKeys.principal(this.ns, userId),
    );
    const epoch = Number(epochRaw ?? 0);
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw) as CachedPrincipal;
      if (cached.epoch === epoch) return cached.data;
    }
    const data = await this.compute(userId);
    if (!data) {
      await this.redis.del(iamKeys.principal(this.ns, userId));
      return null;
    }
    const value: CachedPrincipal = { epoch, data };
    await this.redis.set(iamKeys.principal(this.ns, userId), JSON.stringify(value), 'EX', PRINCIPAL_CACHE_TTL_SECONDS);
    return data;
  }
}
