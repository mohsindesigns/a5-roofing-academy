import { Injectable } from '@nestjs/common';
import { scopeAdmitsUser, type Principal, type ScopeFilter } from '@a5/auth';
import { sql, type Expression, type SqlBool } from '@a5/database';
import { DirectoryReader, userScopeCondition } from '@a5/directory';
import { NotFoundError } from '@a5/nest-kit';
import type { PermissionKey } from '@a5/permissions';

export interface ScopeColumns {
  userColumn: string;
  orgColumn: string;
}

/**
 * Data-scope decisions for user-owned learning records (enrollments, progress, approvals).
 * Tenant isolation is always applied: platform scope does not cross organizations here.
 */
@Injectable()
export class ScopeService {
  constructor(private readonly directory: DirectoryReader) {}

  private filters(p: Principal, permissions: readonly PermissionKey[]): ScopeFilter[] {
    return permissions.map((perm) => p.scopeFilter(perm)).filter((f) => f.kind !== 'none');
  }

  /** SQL condition: same organization and admitted by at least one of the permissions' scopes. */
  condition(
    p: Principal,
    permissions: PermissionKey | readonly PermissionKey[],
    cols: ScopeColumns,
  ): Expression<SqlBool> {
    const list = this.filters(p, typeof permissions === 'string' ? [permissions] : permissions);
    if (list.length === 0) return sql<SqlBool>`false`;
    const parts = list.map((f) => userScopeCondition(f, cols));
    const admitted = parts.length === 1 ? parts[0]! : sql<SqlBool>`(${sql.join(parts, sql` or `)})`;
    return sql<SqlBool>`(${sql.ref(cols.orgColumn)} = ${p.organizationId} and ${admitted})`;
  }

  /** Does at least one of the permissions admit this user? */
  async admits(
    p: Principal,
    permissions: readonly PermissionKey[],
    target: { userId: string; organizationId: string },
  ): Promise<boolean> {
    if (target.organizationId !== p.organizationId) return false;
    const list = this.filters(p, permissions);
    if (list.length === 0) return false;
    if (list.some((f) => f.kind === 'organization' || f.kind === 'platform')) return true;
    const user = await this.directory.getUser(target.userId);
    const teamIds = user?.teamIds ?? [];
    return list.some((f) =>
      scopeAdmitsUser(f, { userId: target.userId, organizationId: target.organizationId, teamIds }),
    );
  }

  /** 404 (not 403) for records outside the caller's scope so existence is not disclosed. */
  async assertAdmits(
    p: Principal,
    permissions: readonly PermissionKey[],
    target: { userId: string; organizationId: string },
    resource: string,
  ): Promise<void> {
    if (!(await this.admits(p, permissions, target))) throw new NotFoundError(resource);
  }
}
