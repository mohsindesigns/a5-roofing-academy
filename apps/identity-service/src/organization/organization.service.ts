import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { FEATURE_FLAGS, type identity } from '@a5/contracts';
import { isUniqueViolation, likePattern, sql } from '@a5/database';
import { ConflictError, EventBus, InjectDb, NotFoundError, PreconditionError, ValidationError } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import { DirectoryPublisher } from '../common/directory-publisher.js';
import { IamCache } from '../common/iam-cache.js';
import { assertOrgReferences } from '../common/org-validator.js';
import type { Db } from '../database/index.js';

type UnitKind = 'location' | 'department';

@Injectable()
export class OrganizationService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    private readonly directory: DirectoryPublisher,
    private readonly cache: IamCache,
  ) {}

  // ---------------------------------------------------------------- locations & departments

  async locations(organizationId: string, includeArchived = false): Promise<identity.Location[]> {
    const rows = await this.db
      .selectFrom('locations as l')
      .select((eb) => [
        'l.id',
        'l.name',
        'l.code',
        'l.city',
        'l.state',
        'l.timezone',
        'l.archived_at',
        eb
          .selectFrom('users')
          .select((e) => e.fn.countAll<number>().as('c'))
          .whereRef('users.location_id', '=', 'l.id')
          .where('users.status', '!=', 'deactivated')
          .as('user_count'),
      ])
      .where('l.organization_id', '=', organizationId)
      .$if(!includeArchived, (q) => q.where('l.archived_at', 'is', null))
      .orderBy('l.name')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      city: r.city,
      state: r.state,
      timezone: r.timezone,
      archived: r.archived_at !== null,
      userCount: Number(r.user_count ?? 0),
    }));
  }

  async departments(organizationId: string, includeArchived = false): Promise<identity.Department[]> {
    const rows = await this.db
      .selectFrom('departments as d')
      .select((eb) => [
        'd.id',
        'd.name',
        'd.code',
        'd.archived_at',
        eb
          .selectFrom('users')
          .select((e) => e.fn.countAll<number>().as('c'))
          .whereRef('users.department_id', '=', 'd.id')
          .where('users.status', '!=', 'deactivated')
          .as('user_count'),
      ])
      .where('d.organization_id', '=', organizationId)
      .$if(!includeArchived, (q) => q.where('d.archived_at', 'is', null))
      .orderBy('d.name')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      archived: r.archived_at !== null,
      userCount: Number(r.user_count ?? 0),
    }));
  }

  async upsertUnit(
    actor: Principal,
    kind: UnitKind,
    id: string | null,
    input: { name: string; code?: string | null; city?: string | null; state?: string | null; timezone?: string },
  ): Promise<string> {
    const table = kind === 'location' ? 'locations' : 'departments';
    const unitId = id ?? uuidv7();
    try {
      await this.db.transaction().execute(async (trx) => {
        if (id) {
          const existing = await trx
            .selectFrom(table)
            .select(['id', 'name'])
            .where('id', '=', id)
            .where('organization_id', '=', actor.organizationId)
            .executeTakeFirst();
          if (!existing) throw new NotFoundError(kind === 'location' ? 'Location' : 'Department');
          await trx
            .updateTable(table)
            .set(
              kind === 'location'
                ? { name: input.name, code: input.code ?? null, city: input.city ?? null, state: input.state ?? null, timezone: input.timezone }
                : { name: input.name, code: input.code ?? null },
            )
            .where('id', '=', id)
            .execute();
        } else if (kind === 'location') {
          await trx
            .insertInto('locations')
            .values({
              id: unitId,
              organization_id: actor.organizationId,
              name: input.name,
              code: input.code ?? null,
              city: input.city ?? null,
              state: input.state ?? null,
              timezone: input.timezone ?? 'America/Chicago',
              archived_at: null,
            })
            .execute();
        } else {
          await trx
            .insertInto('departments')
            .values({ id: unitId, organization_id: actor.organizationId, name: input.name, code: input.code ?? null, archived_at: null })
            .execute();
        }
        await this.directory.unit(trx, kind, unitId);
        await this.events.audit(trx, {
          action: `${kind}.${id ? 'updated' : 'created'}`,
          resourceType: kind,
          resourceId: unitId,
          actorDisplay: actor.displayName,
          after: input,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('NAME_TAKEN', `A ${kind} with this name already exists.`);
      throw err;
    }
    return unitId;
  }

  async setUnitArchived(actor: Principal, kind: UnitKind, id: string, archived: boolean): Promise<void> {
    const table = kind === 'location' ? 'locations' : 'departments';
    await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable(table)
        .set({ archived_at: archived ? new Date() : null })
        .where('id', '=', id)
        .where('organization_id', '=', actor.organizationId)
        .returning('id')
        .executeTakeFirst();
      if (!row) throw new NotFoundError(kind === 'location' ? 'Location' : 'Department');
      await this.directory.unit(trx, kind, id);
      await this.events.audit(trx, {
        action: `${kind}.${archived ? 'archived' : 'restored'}`,
        resourceType: kind,
        resourceId: id,
        actorDisplay: actor.displayName,
      });
    });
  }

  // ---------------------------------------------------------------- teams

  async teams(
    actor: Principal,
    filters: { q?: string; locationId?: string; departmentId?: string; includeArchived?: boolean },
  ): Promise<identity.TeamSummary[]> {
    const scope = actor.scopeFilter('teams.view');
    let query = this.db
      .selectFrom('teams as t')
      .leftJoin('locations as l', 'l.id', 't.location_id')
      .leftJoin('departments as d', 'd.id', 't.department_id')
      .select((eb) => [
        't.id',
        't.name',
        't.description',
        't.archived_at',
        'l.id as location_id',
        'l.name as location_name',
        'd.id as department_id',
        'd.name as department_name',
        eb
          .selectFrom('team_members as tm')
          .innerJoin('users as u', 'u.id', 'tm.user_id')
          .select((e) => e.fn.countAll<number>().as('c'))
          .whereRef('tm.team_id', '=', 't.id')
          .where('u.status', '!=', 'deactivated')
          .as('member_count'),
      ])
      .where('t.organization_id', '=', actor.organizationId);
    if (scope.kind === 'none') return [];
    if (scope.kind === 'managed' || scope.kind === 'own') {
      const teamIds = scope.kind === 'managed' ? scope.teamIds : [];
      // Members see the teams they belong to; managers see the teams they manage.
      query = query.where((eb) =>
        eb.or([
          eb('t.id', 'in', teamIds.length ? teamIds : ['00000000-0000-0000-0000-000000000000']),
          eb('t.id', 'in', this.db.selectFrom('team_members').select('team_id').where('user_id', '=', actor.userId)),
        ]),
      );
    }
    if (!filters.includeArchived) query = query.where('t.archived_at', 'is', null);
    if (filters.q) query = query.where('t.name', 'ilike', likePattern(filters.q));
    if (filters.locationId) query = query.where('t.location_id', '=', filters.locationId);
    if (filters.departmentId) query = query.where('t.department_id', '=', filters.departmentId);
    const rows = await query.orderBy('t.name').execute();
    const managers = await this.managersOf(rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      location: r.location_id ? { id: r.location_id, name: r.location_name! } : null,
      department: r.department_id ? { id: r.department_id, name: r.department_name! } : null,
      managers: managers.get(r.id) ?? [],
      memberCount: Number(r.member_count ?? 0),
      archived: r.archived_at !== null,
    }));
  }

  private async managersOf(teamIds: string[]): Promise<Map<string, Array<{ id: string; displayName: string }>>> {
    if (!teamIds.length) return new Map();
    const rows = await this.db
      .selectFrom('team_managers as tm')
      .innerJoin('users as u', 'u.id', 'tm.user_id')
      .select(['tm.team_id', 'u.id', 'u.first_name', 'u.last_name'])
      .where('tm.team_id', 'in', teamIds)
      .orderBy('u.last_name')
      .execute();
    const map = new Map<string, Array<{ id: string; displayName: string }>>();
    for (const r of rows) {
      map.set(r.team_id, [...(map.get(r.team_id) ?? []), { id: r.id, displayName: `${r.first_name} ${r.last_name}` }]);
    }
    return map;
  }

  async team(actor: Principal, id: string): Promise<identity.TeamDetail> {
    const summary = (await this.teams(actor, { includeArchived: true })).find((t) => t.id === id);
    if (!summary) throw new NotFoundError('Team');
    const members = await this.db
      .selectFrom('team_members as tm')
      .innerJoin('users as u', 'u.id', 'tm.user_id')
      .select(['u.id', 'u.first_name', 'u.last_name', 'u.email', 'u.job_title', 'u.status'])
      .where('tm.team_id', '=', id)
      .orderBy('u.last_name')
      .orderBy('u.first_name')
      .execute();
    return {
      ...summary,
      members: members.map((m) => ({
        id: m.id,
        displayName: `${m.first_name} ${m.last_name}`,
        email: m.email,
        jobTitle: m.job_title,
        status: m.status,
      })),
    };
  }

  async upsertTeam(
    actor: Principal,
    id: string | null,
    input: { name: string; description?: string | null; locationId?: string | null; departmentId?: string | null; managerIds: string[] },
  ): Promise<string> {
    await assertOrgReferences(this.db, actor.organizationId, {
      locationId: input.locationId,
      departmentId: input.departmentId,
      supervisorIds: input.managerIds,
    });
    const teamId = id ?? uuidv7();
    let previousManagers: string[] = [];
    try {
      await this.db.transaction().execute(async (trx) => {
        if (id) {
          const existing = await trx
            .selectFrom('teams')
            .select(['id', 'name', 'description', 'location_id', 'department_id'])
            .where('id', '=', id)
            .where('organization_id', '=', actor.organizationId)
            .executeTakeFirst();
          if (!existing) throw new NotFoundError('Team');
          previousManagers = (await trx.selectFrom('team_managers').select('user_id').where('team_id', '=', id).execute()).map(
            (r) => r.user_id,
          );
          await trx
            .updateTable('teams')
            .set({
              name: input.name,
              description: input.description ?? null,
              location_id: input.locationId ?? null,
              department_id: input.departmentId ?? null,
            })
            .where('id', '=', id)
            .execute();
          await this.events.audit(trx, {
            action: 'team.updated',
            resourceType: 'team',
            resourceId: id,
            actorDisplay: actor.displayName,
            before: { ...existing, managerIds: previousManagers },
            after: input,
          });
        } else {
          await trx
            .insertInto('teams')
            .values({
              id: teamId,
              organization_id: actor.organizationId,
              name: input.name,
              description: input.description ?? null,
              location_id: input.locationId ?? null,
              department_id: input.departmentId ?? null,
              archived_at: null,
              created_by: actor.userId,
            })
            .execute();
          await this.events.audit(trx, {
            action: 'team.created',
            resourceType: 'team',
            resourceId: teamId,
            actorDisplay: actor.displayName,
            after: input,
          });
        }
        await trx.deleteFrom('team_managers').where('team_id', '=', teamId).execute();
        if (input.managerIds.length) {
          await trx
            .insertInto('team_managers')
            .values([...new Set(input.managerIds)].map((user_id) => ({ team_id: teamId, user_id })))
            .execute();
        }
        await this.directory.teams(trx, [teamId]);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('NAME_TAKEN', 'A team with this name already exists.');
      throw err;
    }
    await this.cache.invalidateUsers([...previousManagers, ...input.managerIds]);
    return teamId;
  }

  async setTeamMembers(actor: Principal, id: string, memberIds: string[]): Promise<void> {
    await assertOrgReferences(this.db, actor.organizationId, { supervisorIds: memberIds });
    const team = await this.db
      .selectFrom('teams')
      .select(['id', 'archived_at'])
      .where('id', '=', id)
      .where('organization_id', '=', actor.organizationId)
      .executeTakeFirst();
    if (!team) throw new NotFoundError('Team');
    if (team.archived_at) throw new PreconditionError('TEAM_ARCHIVED', 'Restore the team before changing its members.');
    await this.db.transaction().execute(async (trx) => {
      const current = (await trx.selectFrom('team_members').select('user_id').where('team_id', '=', id).execute()).map((r) => r.user_id);
      const next = [...new Set(memberIds)];
      const added = next.filter((m) => !current.includes(m));
      const removed = current.filter((m) => !next.includes(m));
      if (!added.length && !removed.length) return;
      if (removed.length) await trx.deleteFrom('team_members').where('team_id', '=', id).where('user_id', 'in', removed).execute();
      if (added.length) await trx.insertInto('team_members').values(added.map((user_id) => ({ team_id: id, user_id }))).execute();
      await this.directory.users(trx, [...added, ...removed]);
      await this.directory.teams(trx, [id]);
      await this.events.audit(trx, {
        action: 'team.members_changed',
        resourceType: 'team',
        resourceId: id,
        actorDisplay: actor.displayName,
        metadata: { added, removed },
      });
    });
  }

  async setTeamArchived(actor: Principal, id: string, archived: boolean): Promise<void> {
    const managers = await this.db.selectFrom('team_managers').select('user_id').where('team_id', '=', id).execute();
    await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('teams')
        .set({ archived_at: archived ? new Date() : null })
        .where('id', '=', id)
        .where('organization_id', '=', actor.organizationId)
        .returning('id')
        .executeTakeFirst();
      if (!row) throw new NotFoundError('Team');
      await this.directory.teams(trx, [id]);
      await this.events.audit(trx, {
        action: archived ? 'team.archived' : 'team.restored',
        resourceType: 'team',
        resourceId: id,
        actorDisplay: actor.displayName,
      });
    });
    await this.cache.invalidateUsers(managers.map((m) => m.user_id));
  }

  async structure(actor: Principal): Promise<identity.OrgStructure> {
    const org = await this.db
      .selectFrom('organizations')
      .select(['id', 'name'])
      .where('id', '=', actor.organizationId)
      .executeTakeFirstOrThrow();
    const [locations, departments, teams] = await Promise.all([
      this.locations(actor.organizationId),
      this.departments(actor.organizationId),
      this.teams(actor, {}),
    ]);
    return { organization: org, locations, departments, teams };
  }

  // ---------------------------------------------------------------- settings

  async settings(organizationId: string): Promise<identity.OrganizationSettings> {
    const org = await this.db.selectFrom('organizations').selectAll().where('id', '=', organizationId).executeTakeFirstOrThrow();
    return {
      name: org.name,
      legalName: org.legal_name,
      timezone: org.timezone,
      supportEmail: org.support_email,
      branding: org.branding,
    };
  }

  async updateSettings(actor: Principal, input: identity.OrganizationSettings): Promise<identity.OrganizationSettings> {
    const before = await this.settings(actor.organizationId);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('organizations')
        .set({
          name: input.name,
          legal_name: input.legalName ?? null,
          timezone: input.timezone,
          support_email: input.supportEmail ?? null,
          branding: input.branding,
        })
        .where('id', '=', actor.organizationId)
        .execute();
      await this.events.audit(trx, {
        action: 'organization.settings_changed',
        resourceType: 'organization',
        resourceId: actor.organizationId,
        actorDisplay: actor.displayName,
        before,
        after: input,
      });
    });
    return this.settings(actor.organizationId);
  }

  async security(organizationId: string): Promise<identity.SecuritySettings> {
    const org = await this.db.selectFrom('organizations').select('security').where('id', '=', organizationId).executeTakeFirstOrThrow();
    return org.security;
  }

  async updateSecurity(actor: Principal, input: identity.SecuritySettings): Promise<identity.SecuritySettings> {
    if (input.sessionIdleMinutes > input.sessionMaxHours * 60) {
      throw new ValidationError([{ path: 'sessionIdleMinutes', message: 'Idle timeout cannot exceed the maximum session length.' }]);
    }
    const before = await this.security(actor.organizationId);
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('organizations').set({ security: input }).where('id', '=', actor.organizationId).execute();
      await this.events.audit(trx, {
        action: 'organization.security_changed',
        resourceType: 'organization',
        resourceId: actor.organizationId,
        actorDisplay: actor.displayName,
        before,
        after: input,
      });
    });
    return input;
  }

  async featureFlags(organizationId: string): Promise<identity.FeatureFlagEntry[]> {
    const rows = await this.db
      .selectFrom('feature_flags')
      .select(['key', 'enabled', 'updated_at'])
      .where('organization_id', '=', organizationId)
      .execute();
    return FEATURE_FLAGS.map((f) => {
      const row = rows.find((r) => r.key === f.key);
      return {
        key: f.key,
        label: f.label,
        description: f.description,
        enabled: row?.enabled ?? f.default,
        updatedAt: row?.updated_at.toISOString() ?? null,
      };
    });
  }

  async setFeatureFlag(actor: Principal, key: string, enabled: boolean): Promise<identity.FeatureFlagEntry[]> {
    if (!FEATURE_FLAGS.some((f) => f.key === key)) throw new NotFoundError('Feature flag');
    await this.db.transaction().execute(async (trx) => {
      const previous = await trx
        .selectFrom('feature_flags')
        .select('enabled')
        .where('organization_id', '=', actor.organizationId)
        .where('key', '=', key)
        .executeTakeFirst();
      await trx
        .insertInto('feature_flags')
        .values({ organization_id: actor.organizationId, key, enabled, updated_by: actor.userId })
        .onConflict((oc) =>
          oc.columns(['organization_id', 'key']).doUpdateSet({ enabled, updated_by: actor.userId, updated_at: sql<Date>`now()` }),
        )
        .execute();
      await this.events.audit(trx, {
        action: 'feature_flag.changed',
        resourceType: 'feature_flag',
        resourceId: key,
        actorDisplay: actor.displayName,
        before: { enabled: previous?.enabled ?? null },
        after: { enabled },
      });
    });
    await this.cache.invalidateFeatureFlags(actor.organizationId);
    return this.featureFlags(actor.organizationId);
  }
}
