import {
  PermissionSet,
  scopeCovers,
  type DataScope,
  type PermissionKey,
  type PermissionMap,
} from '@a5/permissions';

export interface PrincipalData {
  userId: string;
  organizationId: string;
  sessionId: string | null;
  displayName: string;
  roles: string[];
  permissions: PermissionMap;
  managedTeamIds: string[];
  managedUserIds: string[];
}

/**
 * Authenticated caller as seen by a service. Built from the internal principal token.
 * Encapsulates permission checks and data-scope decisions so services never inspect role names.
 */
export class Principal {
  readonly permissions: PermissionSet;

  constructor(readonly data: PrincipalData) {
    this.permissions = new PermissionSet(data.permissions);
  }

  get userId(): string {
    return this.data.userId;
  }

  get organizationId(): string {
    return this.data.organizationId;
  }

  get sessionId(): string | null {
    return this.data.sessionId;
  }

  get displayName(): string {
    return this.data.displayName;
  }

  get managedTeamIds(): readonly string[] {
    return this.data.managedTeamIds;
  }

  get managedUserIds(): readonly string[] {
    return this.data.managedUserIds;
  }

  can(permission: PermissionKey): boolean {
    return this.permissions.has(permission);
  }

  scopeOf(permission: PermissionKey): DataScope | null {
    return this.permissions.scope(permission);
  }

  /** Can this principal act on data in another organization (platform administrators)? */
  canCrossOrganizations(permission: PermissionKey): boolean {
    const scope = this.scopeOf(permission);
    return scope !== null && scopeCovers(scope, 'platform');
  }

  /**
   * Query filter for a scoped permission. Services translate it into SQL using their directory
   * projection (`managed` → team membership join).
   */
  scopeFilter(permission: PermissionKey): ScopeFilter {
    const scope = this.scopeOf(permission);
    switch (scope) {
      case null:
        return { kind: 'none' };
      case 'own':
        return { kind: 'own', userId: this.userId };
      case 'managed':
        return {
          kind: 'managed',
          organizationId: this.organizationId,
          userId: this.userId,
          teamIds: [...this.managedTeamIds],
          userIds: [...this.managedUserIds],
        };
      case 'organization':
        return { kind: 'organization', organizationId: this.organizationId };
      case 'platform':
        return { kind: 'platform' };
    }
  }
}

export type ScopeFilter =
  | { kind: 'none' }
  | { kind: 'own'; userId: string }
  | { kind: 'managed'; organizationId: string; userId: string; teamIds: string[]; userIds: string[] }
  | { kind: 'organization'; organizationId: string }
  | { kind: 'platform' };

/**
 * Decide whether a filter admits a specific user, given that user's organization and team ids.
 * For list queries prefer SQL translation; this is for single-record checks.
 */
export function scopeAdmitsUser(
  filter: ScopeFilter,
  target: { userId: string; organizationId: string; teamIds: readonly string[] },
): boolean {
  switch (filter.kind) {
    case 'none':
      return false;
    case 'own':
      return filter.userId === target.userId;
    case 'managed':
      return (
        target.organizationId === filter.organizationId &&
        (filter.userId === target.userId ||
          filter.userIds.includes(target.userId) ||
          target.teamIds.some((t) => filter.teamIds.includes(t)))
      );
    case 'organization':
      return filter.organizationId === target.organizationId;
    case 'platform':
      return true;
  }
}
