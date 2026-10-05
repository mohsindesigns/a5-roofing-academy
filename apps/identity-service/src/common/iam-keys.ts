import { RedisNamespace } from '@a5/messaging';

/**
 * Redis keys shared with the gateway. The gateway reads these with a single MGET per request:
 * session liveness, organization authorization epoch and the cached principal.
 */
export const iamKeys = {
  session: (ns: RedisNamespace, sessionId: string) => ns.key('iam', 'sess', sessionId),
  epoch: (ns: RedisNamespace, organizationId: string) => ns.key('iam', 'epoch', organizationId),
  principal: (ns: RedisNamespace, userId: string) => ns.key('iam', 'principal', userId),
  loginFailures: (ns: RedisNamespace, email: string) => ns.key('iam', 'login-fail', email),
  featureFlags: (ns: RedisNamespace, organizationId: string) => ns.key('iam', 'ff', organizationId),
};

export const PRINCIPAL_CACHE_TTL_SECONDS = 300;
