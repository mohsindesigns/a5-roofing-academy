import { Inject, Injectable } from '@nestjs/common';
import { scopeAdmitsUser, sealLink, type Principal } from '@a5/auth';
import type { identity } from '@a5/contracts';
import { isUniqueViolation, type Page } from '@a5/database';
import { identityEvents } from '@a5/events';
import {
  ConflictError,
  EventBus,
  ForbiddenError,
  InjectDb,
  NotFoundError,
  PreconditionError,
} from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import type { DataScope, PermissionKey } from '@a5/permissions';
import { AccessPolicy } from '../access/access-policy.js';
import { IamCache } from '../common/iam-cache.js';
import { DirectoryPublisher } from '../common/directory-publisher.js';
import { issueOneTimeToken } from '../common/one-time-tokens.js';
import { assertOrgReferences } from '../common/org-validator.js';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config.js';
import type { Db, Trx, UsersTable } from '../database/index.js';
import type { Updateable } from '@a5/database';
import { UsersRepository, userScope, type UserListFilters } from './users.repository.js';

type UserDetail = identity.UserDetail;

interface CreateUserInput {
  email: string;
  firstName: string;
  lastName: string;
  employeeId?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  hiredAt?: string | null;
  locationId?: string | null;
  departmentId?: string | null;
  teamIds: string[];
  managerIds: string[];
  trainerIds: string[];
  roleIds: string[];
  sendInvitation: boolean;
}

type UpdateUserInput = Partial<Omit<CreateUserInput, 'roleIds' | 'sendInvitation'>>;

@Injectable()
export class UsersService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly repo: UsersRepository,
    private readonly events: EventBus,
    private readonly directory: DirectoryPublisher,
    private readonly cache: IamCache,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
  ) {}

  list(actor: Principal, filters: UserListFilters): Promise<Page<identity.UserSummary>> {
    return this.repo.list(
      userScope(actor.scopeFilter('users.view'), actor.organizationId),
      filters,
    );
  }

  async get(actor: Principal, id: string): Promise<UserDetail> {
    if (id !== actor.userId) await this.assertInScope(actor, 'users.view', id);
    const user = await this.repo.detail(this.db, id);
    if (!user) throw new NotFoundError('User');
    return user;
  }

  /** Throws NotFound (not Forbidden) for out-of-scope users so existence is not disclosed. */
  async assertInScope(actor: Principal, permission: PermissionKey, userId: string): Promise<void> {
    const target = await this.db
      .selectFrom('users')
      .select(['id', 'organization_id'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!target) throw new NotFoundError('User');
    const teamIds = await this.repo.teamIdsOf(this.db, userId);
    const filter = actor.scopeFilter(permission);
    const admitted =
      filter.kind === 'platform'
        ? target.organization_id === actor.organizationId
        : scopeAdmitsUser(filter, { userId, organizationId: target.organization_id, teamIds });
    if (!admitted) throw new NotFoundError('User');
  }

  /**
   * Changing or disabling someone is only allowed when you could hold their roles yourself, so an
   * administrator cannot edit (and then reset the password of) a more privileged account.
   */
  private async assertCanManageTarget(actor: Principal, targetId: string): Promise<void> {
    if (targetId === actor.userId) return;
    const roles = (await this.repo.rolesOf(this.db, [targetId])).get(targetId) ?? [];
    AccessPolicy.assertCanManageUser(
      actor,
      await this.rolesWithPermissions(
        this.db,
        roles.map((r) => r.id),
      ),
    );
  }

  private async rolesWithPermissions(trx: Db | Trx, roleIds: readonly string[]) {
    if (!roleIds.length) return [];
    const roles = await trx
      .selectFrom('roles')
      .select(['id', 'name', 'data_scope'])
      .where('id', 'in', [...roleIds])
      .execute();
    const grants = await trx
      .selectFrom('role_permissions')
      .select(['role_id', 'permission_key'])
      .where('role_id', 'in', [...roleIds])
      .execute();
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      data_scope: r.data_scope as DataScope,
      permissions: grants.filter((g) => g.role_id === r.id).map((g) => g.permission_key),
    }));
  }

  private activationUrl(token: string): string {
    return `${this.config.publicAppUrl}/activate?token=${encodeURIComponent(token)}`;
  }

  async create(
    actor: Principal,
    input: CreateUserInput,
  ): Promise<{ user: UserDetail; activationUrl: string | null }> {
    await assertOrgReferences(this.db, actor.organizationId, {
      locationId: input.locationId,
      departmentId: input.departmentId,
      teamIds: input.teamIds,
      supervisorIds: [...input.managerIds, ...input.trainerIds],
      roleIds: input.roleIds,
    });
    AccessPolicy.assertCanAssignRoles(
      actor,
      await this.rolesWithPermissions(this.db, input.roleIds),
    );

    const id = uuidv7();
    let activationUrl: string | null = null;
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('users')
          .values({
            id,
            organization_id: actor.organizationId,
            email: input.email,
            first_name: input.firstName,
            last_name: input.lastName,
            employee_id: input.employeeId ?? null,
            job_title: input.jobTitle ?? null,
            phone: input.phone ?? null,
            hired_at: input.hiredAt ?? null,
            location_id: input.locationId ?? null,
            department_id: input.departmentId ?? null,
            status: 'invited',
            activated_at: null,
            deactivated_at: null,
            deactivation_reason: null,
            last_login_at: null,
            locked_until: null,
            created_by: actor.userId,
            updated_by: actor.userId,
          })
          .execute();
        await this.writePlacement(trx, id, input);
        await trx
          .insertInto('user_roles')
          .values(
            input.roleIds.map((role_id) => ({ user_id: id, role_id, assigned_by: actor.userId })),
          )
          .execute();

        const roles = await this.repo.rolesOf(trx, [id]);
        await this.events.emit(
          trx,
          identityEvents.userCreated,
          {
            userId: id,
            email: input.email,
            displayName: `${input.firstName} ${input.lastName}`,
            roleKeys: (roles.get(id) ?? []).map((r) => r.key),
            createdBy: actor.userId,
          },
          { subject: { type: 'user', id } },
        );
        if (input.sendInvitation)
          activationUrl = await this.invite(
            trx,
            actor,
            id,
            input.email,
            `${input.firstName} ${input.lastName}`,
          );
        await this.directory.users(trx, [id]);
        await this.directory.teams(trx, input.teamIds);
        await this.events.audit(trx, {
          action: 'user.created',
          resourceType: 'user',
          resourceId: id,
          actorDisplay: actor.displayName,
          after: {
            email: input.email,
            name: `${input.firstName} ${input.lastName}`,
            roleIds: input.roleIds,
            teamIds: input.teamIds,
          },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_uq'))
        throw new ConflictError('EMAIL_TAKEN', 'Someone already uses this email address.');
      if (isUniqueViolation(err, 'users_org_employee_uq'))
        throw new ConflictError('EMPLOYEE_ID_TAKEN', 'This employee ID is already assigned.');
      throw err;
    }
    await this.cache.invalidateUsers([...input.managerIds, ...input.trainerIds]);
    const user = (await this.repo.detail(this.db, id))!;
    return { user, activationUrl: this.config.auth.exposeActivationLinks ? activationUrl : null };
  }

  private async invite(
    trx: Trx,
    actor: Principal,
    userId: string,
    email: string,
    displayName: string,
  ): Promise<string> {
    const { token, expiresAt } = await issueOneTimeToken(
      trx,
      userId,
      'activation',
      this.config.auth.activationTokenTtlHours * 3_600_000,
      actor.userId,
    );
    const url = this.activationUrl(token);
    await this.events.emit(
      trx,
      identityEvents.invitationCreated,
      {
        userId,
        email,
        displayName,
        // Sealed so the outbox, event stream and backups never hold a usable activation link.
        activationUrl: sealLink(this.config.internalAuthSecret, url),
        expiresAt: expiresAt.toISOString(),
        invitedByName: actor.displayName,
      },
      { subject: { type: 'user', id: userId } },
    );
    return url;
  }

  async resendInvitation(
    actor: Principal,
    id: string,
  ): Promise<{ user: UserDetail; activationUrl: string | null }> {
    await this.assertInScope(actor, 'users.view', id);
    await this.assertCanManageTarget(actor, id);
    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    if (user.status !== 'invited') {
      throw new PreconditionError(
        'ALREADY_ACTIVATED',
        'This person has already activated their account.',
      );
    }
    let url = '';
    await this.db.transaction().execute(async (trx) => {
      url = await this.invite(trx, actor, id, user.email, `${user.first_name} ${user.last_name}`);
      await this.events.audit(trx, {
        action: 'user.invitation_resent',
        resourceType: 'user',
        resourceId: id,
        actorDisplay: actor.displayName,
      });
    });
    return {
      user: (await this.repo.detail(this.db, id))!,
      activationUrl: this.config.auth.exposeActivationLinks ? url : null,
    };
  }

  private async writePlacement(
    trx: Trx,
    userId: string,
    input: { teamIds?: string[]; managerIds?: string[]; trainerIds?: string[] },
  ) {
    if (input.teamIds) {
      await trx.deleteFrom('team_members').where('user_id', '=', userId).execute();
      if (input.teamIds.length) {
        await trx
          .insertInto('team_members')
          .values([...new Set(input.teamIds)].map((team_id) => ({ team_id, user_id: userId })))
          .execute();
      }
    }
    for (const [kind, ids] of [
      ['manager', input.managerIds],
      ['trainer', input.trainerIds],
    ] as const) {
      if (!ids) continue;
      if (ids.includes(userId))
        throw new PreconditionError('SELF_SUPERVISION', 'A person cannot supervise themselves.');
      await trx
        .deleteFrom('user_relationships')
        .where('user_id', '=', userId)
        .where('kind', '=', kind)
        .execute();
      if (ids.length) {
        await trx
          .insertInto('user_relationships')
          .values(
            [...new Set(ids)].map((supervisor_id) => ({ user_id: userId, supervisor_id, kind })),
          )
          .execute();
      }
    }
  }

  async update(actor: Principal, id: string, input: UpdateUserInput): Promise<UserDetail> {
    await this.assertInScope(actor, 'users.update', id);
    await this.assertCanManageTarget(actor, id);
    await assertOrgReferences(this.db, actor.organizationId, {
      locationId: input.locationId,
      departmentId: input.departmentId,
      teamIds: input.teamIds,
      supervisorIds: [...(input.managerIds ?? []), ...(input.trainerIds ?? [])],
    });
    const before = (await this.repo.detail(this.db, id))!;
    const previousSupervisors = [...before.managers, ...before.trainers].map((p) => p.id);
    const previousTeams = before.teams.map((t) => t.id);

    try {
      await this.db.transaction().execute(async (trx) => {
        const patch: Updateable<UsersTable> = {};
        if (input.email !== undefined) patch.email = input.email;
        if (input.firstName !== undefined) patch.first_name = input.firstName;
        if (input.lastName !== undefined) patch.last_name = input.lastName;
        if (input.employeeId !== undefined) patch.employee_id = input.employeeId;
        if (input.jobTitle !== undefined) patch.job_title = input.jobTitle;
        if (input.phone !== undefined) patch.phone = input.phone;
        if (input.hiredAt !== undefined) patch.hired_at = input.hiredAt;
        if (input.locationId !== undefined) patch.location_id = input.locationId;
        if (input.departmentId !== undefined) patch.department_id = input.departmentId;
        await trx
          .updateTable('users')
          .set({ ...patch, updated_by: actor.userId })
          .where('id', '=', id)
          .execute();
        await this.writePlacement(trx, id, input);
        await this.directory.users(trx, [id]);
        if (input.teamIds) await this.directory.teams(trx, [...previousTeams, ...input.teamIds]);
        await this.events.audit(trx, {
          action: 'user.updated',
          resourceType: 'user',
          resourceId: id,
          actorDisplay: actor.displayName,
          before: pick(before, input),
          after: input,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_uq'))
        throw new ConflictError('EMAIL_TAKEN', 'Someone already uses this email address.');
      if (isUniqueViolation(err, 'users_org_employee_uq'))
        throw new ConflictError('EMPLOYEE_ID_TAKEN', 'This employee ID is already assigned.');
      throw err;
    }
    await this.cache.invalidateUsers([
      id,
      ...previousSupervisors,
      ...(input.managerIds ?? []),
      ...(input.trainerIds ?? []),
    ]);
    return (await this.repo.detail(this.db, id))!;
  }

  async setRoles(actor: Principal, id: string, roleIds: string[]): Promise<UserDetail> {
    if (id === actor.userId)
      throw new ForbiddenError('You cannot change your own roles. Ask another administrator.');
    await this.assertInScope(actor, 'users.view', id);
    await assertOrgReferences(this.db, actor.organizationId, { roleIds });
    const current = (await this.repo.rolesOf(this.db, [id])).get(id) ?? [];
    const currentIds = current.map((r) => r.id);
    const changed = [
      ...roleIds.filter((r) => !currentIds.includes(r)),
      ...currentIds.filter((r) => !roleIds.includes(r)),
    ];
    if (changed.length === 0) return (await this.repo.detail(this.db, id))!;
    AccessPolicy.assertCanAssignRoles(actor, await this.rolesWithPermissions(this.db, changed));

    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('user_roles').where('user_id', '=', id).execute();
      await trx
        .insertInto('user_roles')
        .values(
          [...new Set(roleIds)].map((role_id) => ({
            user_id: id,
            role_id,
            assigned_by: actor.userId,
          })),
        )
        .execute();
      await this.directory.users(trx, [id]);
      await this.events.audit(trx, {
        action: 'user.roles_changed',
        resourceType: 'user',
        resourceId: id,
        actorDisplay: actor.displayName,
        before: { roles: current.map((r) => r.key) },
        after: { roleIds },
      });
    });
    await this.cache.invalidateUsers([id]);
    return (await this.repo.detail(this.db, id))!;
  }

  async deactivate(actor: Principal, id: string, reason: string): Promise<UserDetail> {
    if (id === actor.userId) throw new ForbiddenError('You cannot deactivate your own account.');
    await this.assertInScope(actor, 'users.disable', id);
    await this.assertCanManageTarget(actor, id);
    const user = await this.db
      .selectFrom('users')
      .select(['status'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    if (user.status === 'deactivated') return (await this.repo.detail(this.db, id))!;
    const sessions = await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({
          status: 'deactivated',
          deactivated_at: new Date(),
          deactivation_reason: reason,
          updated_by: actor.userId,
        })
        .where('id', '=', id)
        .execute();
      const revoked = await trx
        .updateTable('sessions')
        .set({ revoked_at: new Date(), revoked_reason: 'account_deactivated' })
        .where('user_id', '=', id)
        .where('revoked_at', 'is', null)
        .returning('id')
        .execute();
      await this.events.emit(
        trx,
        identityEvents.userDeactivated,
        { userId: id, reason },
        { subject: { type: 'user', id } },
      );
      await this.directory.users(trx, [id]);
      await this.events.audit(trx, {
        action: 'user.deactivated',
        resourceType: 'user',
        resourceId: id,
        actorDisplay: actor.displayName,
        before: { status: user.status },
        after: { status: 'deactivated' },
        reason,
      });
      return revoked.map((s) => s.id);
    });
    await this.cache.revokeSessions(sessions);
    await this.cache.invalidateUsers([id]);
    return (await this.repo.detail(this.db, id))!;
  }

  async reactivate(actor: Principal, id: string): Promise<UserDetail> {
    await this.assertInScope(actor, 'users.disable', id);
    await this.assertCanManageTarget(actor, id);
    const user = await this.db
      .selectFrom('users')
      .select(['status', 'activated_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    if (user.status !== 'deactivated')
      throw new PreconditionError('NOT_DEACTIVATED', 'This account is not deactivated.');
    const nextStatus = user.activated_at ? 'active' : 'invited';
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({
          status: nextStatus,
          deactivated_at: null,
          deactivation_reason: null,
          failed_login_count: 0,
          locked_until: null,
          updated_by: actor.userId,
        })
        .where('id', '=', id)
        .execute();
      if (nextStatus === 'active')
        await this.events.emit(
          trx,
          identityEvents.userActivated,
          { userId: id },
          { subject: { type: 'user', id } },
        );
      await this.directory.users(trx, [id]);
      await this.events.audit(trx, {
        action: 'user.reactivated',
        resourceType: 'user',
        resourceId: id,
        actorDisplay: actor.displayName,
        before: { status: 'deactivated' },
        after: { status: nextStatus },
      });
    });
    await this.cache.invalidateUsers([id]);
    return (await this.repo.detail(this.db, id))!;
  }

  /** Only accounts that never activated can be deleted; everyone else is deactivated to keep history. */
  async delete(actor: Principal, id: string): Promise<void> {
    if (id === actor.userId) throw new ForbiddenError('You cannot delete your own account.');
    await this.assertInScope(actor, 'users.view', id);
    await this.assertCanManageTarget(actor, id);
    const user = await this.db
      .selectFrom('users')
      .select(['status', 'activated_at', 'email'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    if (user.activated_at) {
      throw new PreconditionError(
        'USER_HAS_HISTORY',
        'This person has signed in before. Deactivate the account instead to keep their training history.',
      );
    }
    const teams = await this.repo.teamIdsOf(this.db, id);
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('users').where('id', '=', id).execute();
      await this.directory.teams(trx, teams);
      await this.events.audit(trx, {
        action: 'user.deleted',
        resourceType: 'user',
        resourceId: id,
        actorDisplay: actor.displayName,
        before: { email: user.email, status: user.status },
      });
    });
  }

  async sessions(actor: Principal, id: string): Promise<identity.SessionInfo[]> {
    if (id !== actor.userId) await this.assertInScope(actor, 'sessions.view', id);
    const rows = await this.db
      .selectFrom('sessions')
      .selectAll()
      .where('user_id', '=', id)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .orderBy('last_seen_at', 'desc')
      .limit(50)
      .execute();
    return rows.map((s) => ({
      id: s.id,
      createdAt: s.created_at.toISOString(),
      lastSeenAt: s.last_seen_at.toISOString(),
      expiresAt: s.expires_at.toISOString(),
      ip: s.ip,
      userAgent: s.user_agent,
      current: s.id === actor.sessionId,
    }));
  }

  async loginHistory(actor: Principal, id: string): Promise<identity.LoginHistoryEntry[]> {
    if (id !== actor.userId) await this.assertInScope(actor, 'sessions.view', id);
    const rows = await this.db
      .selectFrom('login_attempts')
      .selectAll()
      .where('user_id', '=', id)
      .orderBy('occurred_at', 'desc')
      .limit(50)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at.toISOString(),
      success: r.success,
      reason: r.reason,
      ip: r.ip,
      userAgent: r.user_agent,
    }));
  }

  async revokeSessions(actor: Principal, id: string, sessionId?: string): Promise<number> {
    if (id !== actor.userId) {
      await this.assertInScope(actor, 'sessions.revoke', id);
      await this.assertCanManageTarget(actor, id);
    }
    const revoked = await this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .updateTable('sessions')
        .set({
          revoked_at: new Date(),
          revoked_reason: id === actor.userId ? 'signed_out' : 'revoked_by_admin',
        })
        .where('user_id', '=', id)
        .where('revoked_at', 'is', null)
        .$if(Boolean(sessionId), (q) => q.where('id', '=', sessionId!))
        .returning('id')
        .execute();
      if (id !== actor.userId && rows.length) {
        await this.events.audit(trx, {
          action: 'user.sessions_revoked',
          resourceType: 'user',
          resourceId: id,
          actorDisplay: actor.displayName,
          metadata: { count: rows.length },
        });
      }
      return rows.map((r) => r.id);
    });
    if (sessionId && revoked.length === 0) throw new NotFoundError('Session');
    await this.cache.revokeSessions(revoked);
    return revoked.length;
  }
}

function pick(before: UserDetail, input: UpdateUserInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const map: Record<string, unknown> = {
    email: before.email,
    firstName: before.firstName,
    lastName: before.lastName,
    employeeId: before.employeeId,
    jobTitle: before.jobTitle,
    phone: before.phone,
    hiredAt: before.hiredAt,
    locationId: before.location?.id ?? null,
    departmentId: before.department?.id ?? null,
    teamIds: before.teams.map((t) => t.id),
    managerIds: before.managers.map((m) => m.id),
    trainerIds: before.trainers.map((t) => t.id),
  };
  for (const key of Object.keys(input)) out[key] = map[key];
  return out;
}
