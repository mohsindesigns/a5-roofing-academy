import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { identity } from '@a5/contracts';
import { isUniqueViolation, sql } from '@a5/database';
import {
  ConflictError,
  EventBus,
  ForbiddenError,
  InjectDb,
  NotFoundError,
  PreconditionError,
} from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import {
  DEFAULT_ROLES,
  PERMISSIONS,
  isSystemRoleKey,
  permissionsByModule,
  type DataScope,
  type PermissionKey,
} from '@a5/permissions';
import type { Db, Trx } from '../database/index.js';
import { IamCache } from '../common/iam-cache.js';
import { AccessPolicy } from './access-policy.js';

type RoleSummary = identity.RoleSummary;
type RoleDetail = identity.RoleDetail;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

@Injectable()
export class RolesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    private readonly cache: IamCache,
  ) {}

  catalog(): identity.PermissionCatalog {
    return {
      modules: permissionsByModule().map(({ module, permissions }) => ({
        key: module.key,
        label: module.label,
        permissions: permissions.map((p) => ({
          key: p.key as PermissionKey,
          label: p.label,
          description: p.description,
          scoped: p.scoped ?? false,
          platform: p.platform ?? false,
        })),
      })),
    };
  }

  async list(organizationId: string, includeArchived = false): Promise<RoleSummary[]> {
    const rows = await this.db
      .selectFrom('roles as r')
      .select((eb) => [
        'r.id',
        'r.key',
        'r.name',
        'r.description',
        'r.is_system',
        'r.locked',
        'r.data_scope',
        'r.archived_at',
        eb
          .selectFrom('user_roles as ur')
          .innerJoin('users as u', 'u.id', 'ur.user_id')
          .select((e) => e.fn.countAll<number>().as('c'))
          .whereRef('ur.role_id', '=', 'r.id')
          .where('u.status', '!=', 'deactivated')
          .as('user_count'),
        sql<
          string[]
        >`coalesce((select array_agg(permission_key order by permission_key) from role_permissions rp where rp.role_id = r.id), '{}')`.as(
          'permissions',
        ),
      ])
      .where('r.organization_id', '=', organizationId)
      .$if(!includeArchived, (q) => q.where('r.archived_at', 'is', null))
      .orderBy('r.is_system', 'desc')
      .orderBy('r.name')
      .execute();
    return rows.map((r) => this.toSummary(r));
  }

  async get(organizationId: string, id: string): Promise<RoleDetail> {
    const role = (await this.list(organizationId, true)).find((r) => r.id === id);
    if (!role) throw new NotFoundError('Role');
    const permissions = await this.permissionsOf(this.db, id);
    return { ...role, permissions: permissions as PermissionKey[] };
  }

  async matrix(organizationId: string): Promise<identity.PermissionMatrix> {
    const roles = await this.list(organizationId);
    const grants = roles.length
      ? await this.db
          .selectFrom('role_permissions')
          .select(['role_id', 'permission_key'])
          .where(
            'role_id',
            'in',
            roles.map((r) => r.id),
          )
          .execute()
      : [];
    return {
      catalog: this.catalog(),
      roles: roles.map((r) => ({
        ...r,
        permissions: grants
          .filter((g) => g.role_id === r.id)
          .map((g) => g.permission_key as PermissionKey),
      })),
    };
  }

  async create(actor: Principal, input: identity.CreateRoleRequest): Promise<RoleDetail> {
    let permissions = input.permissions ?? [];
    let dataScope = input.dataScope as DataScope;
    if (input.cloneFromRoleId) {
      const source = await this.get(actor.organizationId, input.cloneFromRoleId);
      permissions = input.permissions?.length ? input.permissions : source.permissions;
      dataScope = input.dataScope ?? source.dataScope;
    }
    AccessPolicy.assertCanUseScope(actor, dataScope);
    AccessPolicy.assertPlatformPermissionsMatchScope(permissions, dataScope);
    AccessPolicy.assertCanChangePermissions(actor, permissions, dataScope);

    const id = uuidv7();
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('roles')
          .values({
            id,
            organization_id: actor.organizationId,
            key: `custom_${slugify(input.name)}_${id.slice(-6)}`,
            name: input.name,
            description: input.description ?? null,
            is_system: false,
            locked: false,
            data_scope: dataScope,
            archived_at: null,
            created_by: actor.userId,
            updated_by: actor.userId,
          })
          .execute();
        await this.writePermissions(trx, id, permissions, actor.userId);
        await this.events.audit(trx, {
          action: input.cloneFromRoleId ? 'role.cloned' : 'role.created',
          resourceType: 'role',
          resourceId: id,
          actorDisplay: actor.displayName,
          after: { name: input.name, dataScope, permissions },
          metadata: input.cloneFromRoleId ? { clonedFrom: input.cloneFromRoleId } : undefined,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictError('ROLE_NAME_TAKEN', 'A role with this name already exists.');
      throw err;
    }
    return this.get(actor.organizationId, id);
  }

  async update(
    actor: Principal,
    id: string,
    input: { name?: string; description?: string | null; dataScope?: DataScope },
  ) {
    const role = await this.get(actor.organizationId, id);
    if (role.locked) throw new ForbiddenError('This role is protected and cannot be edited.');
    if (role.archived)
      throw new PreconditionError('ROLE_ARCHIVED', 'Archived roles cannot be edited.');
    if (input.dataScope && input.dataScope !== role.dataScope) {
      AccessPolicy.assertCanUseScope(actor, input.dataScope);
      AccessPolicy.assertCanChangePermissions(actor, role.permissions, input.dataScope);
    }
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('roles')
          .set({
            ...(input.name !== undefined && { name: input.name }),
            ...(input.description !== undefined && { description: input.description }),
            ...(input.dataScope !== undefined && { data_scope: input.dataScope }),
            updated_by: actor.userId,
          })
          .where('id', '=', id)
          .execute();
        await this.events.audit(trx, {
          action: 'role.updated',
          resourceType: 'role',
          resourceId: id,
          actorDisplay: actor.displayName,
          before: { name: role.name, description: role.description, dataScope: role.dataScope },
          after: input,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictError('ROLE_NAME_TAKEN', 'A role with this name already exists.');
      throw err;
    }
    if (input.dataScope && input.dataScope !== role.dataScope)
      await this.cache.bumpEpoch(actor.organizationId);
    return this.get(actor.organizationId, id);
  }

  async setPermissions(
    actor: Principal,
    id: string,
    permissions: PermissionKey[],
    reason?: string | null,
  ) {
    await this.db.transaction().execute(async (trx) => {
      await this.applyPermissions(trx, actor, id, permissions, reason ?? null);
    });
    await this.cache.bumpEpoch(actor.organizationId);
    return this.get(actor.organizationId, id);
  }

  /** Save several roles from the permission matrix atomically. */
  async setMatrix(
    actor: Principal,
    changes: Array<{ roleId: string; permissions: PermissionKey[] }>,
    reason?: string | null,
  ) {
    await this.db.transaction().execute(async (trx) => {
      for (const change of changes)
        await this.applyPermissions(trx, actor, change.roleId, change.permissions, reason ?? null);
    });
    await this.cache.bumpEpoch(actor.organizationId);
    return this.matrix(actor.organizationId);
  }

  async resetToDefault(actor: Principal, id: string) {
    const role = await this.get(actor.organizationId, id);
    if (!role.isSystem || !isSystemRoleKey(role.key)) {
      throw new PreconditionError(
        'NOT_A_SYSTEM_ROLE',
        'Only built-in roles can be reset to their defaults.',
      );
    }
    const defaults = DEFAULT_ROLES.find((r) => r.key === role.key)!;
    await this.db.transaction().execute(async (trx) => {
      await this.applyPermissions(
        trx,
        actor,
        id,
        [...defaults.permissions],
        'Reset to default',
        defaults.dataScope,
      );
      await trx
        .updateTable('roles')
        .set({ data_scope: defaults.dataScope, updated_by: actor.userId })
        .where('id', '=', id)
        .execute();
    });
    await this.cache.bumpEpoch(actor.organizationId);
    return this.get(actor.organizationId, id);
  }

  async archive(actor: Principal, id: string) {
    const role = await this.get(actor.organizationId, id);
    if (role.isSystem)
      throw new PreconditionError('SYSTEM_ROLE', 'Built-in roles cannot be archived.');
    if (role.userCount > 0) {
      throw new PreconditionError(
        'ROLE_IN_USE',
        `This role is assigned to ${role.userCount} ${role.userCount === 1 ? 'person' : 'people'}. Reassign them before archiving.`,
      );
    }
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('roles')
        .set({ archived_at: new Date(), updated_by: actor.userId })
        .where('id', '=', id)
        .execute();
      await this.events.audit(trx, {
        action: 'role.archived',
        resourceType: 'role',
        resourceId: id,
        actorDisplay: actor.displayName,
        before: { name: role.name },
      });
    });
    await this.cache.bumpEpoch(actor.organizationId);
    return this.get(actor.organizationId, id);
  }

  private async applyPermissions(
    trx: Trx,
    actor: Principal,
    id: string,
    next: readonly PermissionKey[],
    reason: string | null,
    scopeOverride?: DataScope,
  ): Promise<void> {
    const role = await trx
      .selectFrom('roles')
      .select(['id', 'name', 'locked', 'archived_at', 'data_scope'])
      .where('id', '=', id)
      .where('organization_id', '=', actor.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!role) throw new NotFoundError('Role');
    if (role.locked)
      throw new ForbiddenError(
        `"${role.name}" is protected and its permissions cannot be changed.`,
      );
    if (role.archived_at)
      throw new PreconditionError('ROLE_ARCHIVED', 'Archived roles cannot be edited.');
    const scope = scopeOverride ?? role.data_scope;
    const current = await this.permissionsOf(trx, id);
    const unique = [...new Set(next)];
    if (sameSet(current, unique)) return;
    const added = unique.filter((p) => !current.includes(p));
    const removed = current.filter((p) => !unique.includes(p as PermissionKey));
    AccessPolicy.assertPlatformPermissionsMatchScope(unique, scope);
    AccessPolicy.assertCanChangePermissions(actor, [...added, ...removed], scope);
    await trx.deleteFrom('role_permissions').where('role_id', '=', id).execute();
    await this.writePermissions(trx, id, unique, actor.userId);
    await trx.updateTable('roles').set({ updated_by: actor.userId }).where('id', '=', id).execute();
    await this.events.audit(trx, {
      action: 'role.permissions_changed',
      resourceType: 'role',
      resourceId: id,
      actorDisplay: actor.displayName,
      before: { permissions: current },
      after: { permissions: unique },
      reason,
      metadata: { added, removed },
    });
  }

  private async writePermissions(
    trx: Trx,
    roleId: string,
    permissions: readonly string[],
    actorId: string | null,
  ) {
    if (permissions.length === 0) return;
    await trx
      .insertInto('role_permissions')
      .values(permissions.map((p) => ({ role_id: roleId, permission_key: p, granted_by: actorId })))
      .execute();
  }

  private async permissionsOf(db: Db | Trx, roleId: string): Promise<string[]> {
    const rows = await db
      .selectFrom('role_permissions')
      .select('permission_key')
      .where('role_id', '=', roleId)
      .execute();
    return rows.map((r) => r.permission_key).sort();
  }

  private toSummary(r: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    is_system: boolean;
    locked: boolean;
    data_scope: DataScope;
    archived_at: Date | null;
    user_count: number | null;
    permissions: string[];
  }): RoleSummary {
    const defaults = r.is_system ? DEFAULT_ROLES.find((d) => d.key === r.key) : undefined;
    return {
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.is_system,
      locked: r.locked,
      dataScope: r.data_scope,
      userCount: Number(r.user_count ?? 0),
      permissionCount: r.permissions.length,
      archived: r.archived_at !== null,
      modifiedFromDefault: defaults
        ? !sameSet(defaults.permissions, r.permissions) || defaults.dataScope !== r.data_scope
        : false,
    };
  }
}

export const KNOWN_PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
