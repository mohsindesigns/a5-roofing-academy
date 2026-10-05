import type { Principal } from '@a5/auth';
import { ForbiddenError } from '@a5/nest-kit';
import { getPermission, isPermissionKey, scopeRank, type DataScope, type PermissionKey } from '@a5/permissions';

/** Widest data scope the actor holds through any permission. */
export function actorMaxScope(actor: Principal): DataScope {
  let max: DataScope = 'own';
  for (const key of actor.permissions.keys()) {
    const scope = actor.permissions.scope(key);
    if (scope && scopeRank(scope) > scopeRank(max)) max = scope;
  }
  return max;
}

/**
 * Permissions in `permissions` that the actor could not grant at `scope`: not held at all, or held
 * with a narrower scope than the role would grant (scoped permissions only).
 */
function ungrantable(actor: Principal, permissions: readonly string[], scope: DataScope): string[] {
  return permissions.filter((p) => {
    if (!isPermissionKey(p)) return true;
    const held = actor.permissions.scope(p as PermissionKey);
    if (!held) return true;
    return getPermission(p).scoped === true && scopeRank(held) < scopeRank(scope);
  });
}

/**
 * Privilege-escalation rules:
 * - you can only grant or revoke permissions you hold, at least at the scope being granted;
 * - platform permissions and platform scope require platform scope;
 * - you cannot create roles with a wider data scope than your own.
 */
export const AccessPolicy = {
  assertCanChangePermissions(actor: Principal, changed: readonly string[], roleScope: DataScope): void {
    const missing = ungrantable(actor, changed, roleScope);
    if (missing.length) {
      throw new ForbiddenError('You can only grant or remove permissions that you hold yourself, at the same scope.', {
        permissions: missing,
      });
    }
    const platform = changed.filter((p) => isPermissionKey(p) && getPermission(p).platform);
    if (platform.length && actorMaxScope(actor) !== 'platform') {
      throw new ForbiddenError('Platform permissions can only be changed by a platform administrator.', { permissions: platform });
    }
  },

  assertCanUseScope(actor: Principal, scope: DataScope): void {
    if (scopeRank(scope) > scopeRank(actorMaxScope(actor))) {
      throw new ForbiddenError(`You cannot create or edit roles with a "${scope}" data scope.`);
    }
  },

  assertPlatformPermissionsMatchScope(permissions: readonly string[], scope: DataScope): void {
    const platform = permissions.filter((p) => isPermissionKey(p) && getPermission(p).platform);
    if (platform.length && scope !== 'platform') {
      throw new ForbiddenError('Platform permissions can only be granted to platform-scope roles.', { permissions: platform });
    }
  },

  /** Assigning a role is equivalent to granting all of its permissions with its scope. */
  assertCanAssignRoles(
    actor: Principal,
    roles: ReadonlyArray<{ name: string; data_scope: DataScope; permissions: readonly string[] }>,
  ): void {
    for (const role of roles) {
      if (scopeRank(role.data_scope) > scopeRank(actorMaxScope(actor))) {
        throw new ForbiddenError(`You cannot assign "${role.name}" because its data scope is wider than yours.`);
      }
      const missing = ungrantable(actor, role.permissions, role.data_scope);
      if (missing.length) {
        throw new ForbiddenError(`You cannot assign "${role.name}" because it grants permissions you do not hold.`, {
          role: role.name,
          permissions: missing,
        });
      }
    }
  },
};
