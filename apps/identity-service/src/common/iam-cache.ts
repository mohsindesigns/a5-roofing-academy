import { Inject, Injectable } from '@nestjs/common';
import { InjectRedis } from '@a5/nest-kit';
import { RedisNamespace, type Redis } from '@a5/messaging';
import { iamKeys } from './iam-keys.js';

/**
 * Invalidation of authorization data cached for the gateway. Always called after the database
 * transaction commits so a racing request cannot re-cache stale data from before the change.
 */
@Injectable()
export class IamCache {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    @Inject(RedisNamespace) private readonly ns: RedisNamespace,
  ) {}

  /** Invalidate every cached principal in an organization (role or structure changes). */
  async bumpEpoch(organizationId: string): Promise<void> {
    await this.redis.incr(iamKeys.epoch(this.ns, organizationId));
  }

  async invalidateUsers(userIds: readonly string[]): Promise<void> {
    if (userIds.length)
      await this.redis.del(...userIds.map((id) => iamKeys.principal(this.ns, id)));
  }

  async markSessionActive(sessionId: string, expiresAt: Date): Promise<void> {
    const ttl = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    await this.redis.set(iamKeys.session(this.ns, sessionId), '1', 'EX', ttl);
  }

  async revokeSessions(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length)
      await this.redis.del(...sessionIds.map((id) => iamKeys.session(this.ns, id)));
  }

  async invalidateFeatureFlags(organizationId: string): Promise<void> {
    await this.redis.del(iamKeys.featureFlags(this.ns, organizationId));
  }
}
