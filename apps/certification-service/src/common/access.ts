import { Injectable } from '@nestjs/common';
import { scopeAdmitsUser, type Principal } from '@a5/auth';
import { DirectoryReader } from '@a5/directory';
import { NotFoundError } from '@a5/nest-kit';
import type { PermissionKey } from '@a5/permissions';

/** Single-record data-scope decisions backed by the directory projection. */
@Injectable()
export class AccessService {
  constructor(private readonly directory: DirectoryReader) {}

  /** Does the principal's scope for `permission` admit a record owned by `userId` in `organizationId`? */
  async admits(
    p: Principal,
    permission: PermissionKey,
    target: { userId: string; organizationId: string },
  ): Promise<boolean> {
    if (target.organizationId !== p.organizationId) return false;
    const filter = p.scopeFilter(permission);
    switch (filter.kind) {
      case 'none':
        return false;
      case 'own':
        return target.userId === p.userId;
      case 'organization':
      case 'platform':
        return true;
      case 'managed': {
        if (target.userId === p.userId || filter.userIds.includes(target.userId)) return true;
        const user = await this.directory.getUser(target.userId);
        return user
          ? scopeAdmitsUser(filter, {
              userId: target.userId,
              organizationId: user.organizationId,
              teamIds: user.teamIds,
            })
          : false;
      }
    }
  }

  /** Throws 404 (never 403) so the existence of out-of-scope records is not disclosed. */
  async assertAdmits(
    p: Principal,
    permission: PermissionKey,
    target: { userId: string; organizationId: string },
    resource: string,
  ): Promise<void> {
    if (!(await this.admits(p, permission, target))) throw new NotFoundError(resource);
  }

  /**
   * Certificates and progress: the owner with `certificates.view_own`, or anyone whose
   * `certificates.view` scope admits the owner.
   */
  async canViewCertificatesOf(
    p: Principal,
    target: { userId: string; organizationId: string },
  ): Promise<boolean> {
    if (target.organizationId !== p.organizationId) return false;
    if (target.userId === p.userId && p.can('certificates.view_own')) return true;
    return this.admits(p, 'certificates.view', target);
  }
}
