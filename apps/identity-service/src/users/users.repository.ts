import { Injectable } from '@nestjs/common';
import type { ScopeFilter } from '@a5/auth';
import type { identity } from '@a5/contracts';
import { likePattern, paginate, sql, type Expression, type SqlBool, type Page } from '@a5/database';
import { InjectDb } from '@a5/nest-kit';
import type { Db, DbOrTrx } from '../database/index.js';

type UserSummary = identity.UserSummary;
type UserDetail = identity.UserDetail;

const SORTS = {
  name: ['u.last_name', 'u.first_name'],
  email: ['u.email'],
  status: ['u.status'],
  createdAt: ['u.created_at'],
  lastLoginAt: ['u.last_login_at'],
} as const;

export interface UserListFilters {
  q?: string;
  status?: string[];
  roleId?: string;
  teamId?: string;
  locationId?: string;
  departmentId?: string;
  ids?: string[];
  sort?: string;
  page: number;
  pageSize: number;
}

/** SQL condition restricting `u.id` to users admitted by a scope filter (identity owns the org graph). */
export function userScope(filter: ScopeFilter, organizationId: string): Expression<SqlBool> {
  switch (filter.kind) {
    case 'none':
      return sql<SqlBool>`false`;
    case 'own':
      return sql<SqlBool>`u.id = ${filter.userId}`;
    case 'organization':
    case 'platform':
      return sql<SqlBool>`u.organization_id = ${organizationId}`;
    case 'managed': {
      const users = [filter.userId, ...filter.userIds];
      const teams = filter.teamIds.length ? filter.teamIds : ['00000000-0000-0000-0000-000000000000'];
      return sql<SqlBool>`(u.organization_id = ${organizationId} and (
        u.id = any(${sql.val(users)}::uuid[])
        or u.id in (select user_id from team_members where team_id = any(${sql.val(teams)}::uuid[]))
      ))`;
    }
  }
}

@Injectable()
export class UsersRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  async list(scope: Expression<SqlBool>, f: UserListFilters): Promise<Page<UserSummary>> {
    let query = this.db
      .selectFrom('users as u')
      .leftJoin('locations as l', 'l.id', 'u.location_id')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .select([
        'u.id',
        'u.email',
        'u.first_name',
        'u.last_name',
        'u.employee_id',
        'u.job_title',
        'u.status',
        'u.last_login_at',
        'u.created_at',
        'l.id as location_id',
        'l.name as location_name',
        'd.id as department_id',
        'd.name as department_name',
      ])
      .where(scope);

    if (f.q) {
      const pattern = likePattern(f.q);
      query = query.where((eb) =>
        eb.or([
          eb(sql`u.first_name || ' ' || u.last_name`, 'ilike', pattern),
          eb('u.email', 'ilike', pattern),
          eb('u.employee_id', 'ilike', pattern),
        ]),
      );
    }
    if (f.status?.length) query = query.where('u.status', 'in', f.status as never[]);
    if (f.locationId) query = query.where('u.location_id', '=', f.locationId);
    if (f.departmentId) query = query.where('u.department_id', '=', f.departmentId);
    if (f.ids?.length) query = query.where('u.id', 'in', f.ids);
    if (f.teamId) {
      query = query.where('u.id', 'in', this.db.selectFrom('team_members').select('user_id').where('team_id', '=', f.teamId));
    }
    if (f.roleId) {
      query = query.where('u.id', 'in', this.db.selectFrom('user_roles').select('user_id').where('role_id', '=', f.roleId));
    }

    const desc = f.sort?.startsWith('-') ?? false;
    const key = (f.sort?.replace(/^-/, '') ?? 'name') as keyof typeof SORTS;
    for (const column of SORTS[key] ?? SORTS.name) {
      query = query.orderBy(column, desc ? 'desc' : 'asc');
    }
    query = query.orderBy('u.id');

    const page = await paginate(query, { page: f.page, pageSize: f.pageSize });
    const ids = page.items.map((r) => r.id);
    const [teams, roles] = await Promise.all([this.teamsOf(this.db, ids), this.rolesOf(this.db, ids)]);
    return {
      ...page,
      items: page.items.map((r) => ({
        id: r.id,
        email: r.email,
        firstName: r.first_name,
        lastName: r.last_name,
        displayName: `${r.first_name} ${r.last_name}`,
        employeeId: r.employee_id,
        jobTitle: r.job_title,
        status: r.status,
        location: r.location_id ? { id: r.location_id, name: r.location_name! } : null,
        department: r.department_id ? { id: r.department_id, name: r.department_name! } : null,
        teams: teams.get(r.id) ?? [],
        roles: roles.get(r.id) ?? [],
        lastLoginAt: r.last_login_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  async detail(db: DbOrTrx, id: string): Promise<UserDetail | null> {
    const r = await db
      .selectFrom('users as u')
      .leftJoin('locations as l', 'l.id', 'u.location_id')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .selectAll('u')
      .select(['l.name as location_name', 'd.name as department_name'])
      .where('u.id', '=', id)
      .executeTakeFirst();
    if (!r) return null;
    const [teams, roles, supervisors, reports, managedTeams] = await Promise.all([
      this.teamsOf(db, [id]),
      this.rolesOf(db, [id]),
      db
        .selectFrom('user_relationships as ur')
        .innerJoin('users as s', 's.id', 'ur.supervisor_id')
        .select(['ur.kind', 's.id', 's.first_name', 's.last_name'])
        .where('ur.user_id', '=', id)
        .orderBy('s.last_name')
        .execute(),
      db
        .selectFrom('user_relationships as ur')
        .innerJoin('users as s', 's.id', 'ur.user_id')
        .select(['s.id', 's.first_name', 's.last_name'])
        .where('ur.supervisor_id', '=', id)
        .orderBy('s.last_name')
        .execute(),
      db
        .selectFrom('team_managers as tm')
        .innerJoin('teams as t', 't.id', 'tm.team_id')
        .select(['t.id', 't.name'])
        .where('tm.user_id', '=', id)
        .where('t.archived_at', 'is', null)
        .orderBy('t.name')
        .execute(),
    ]);
    const person = (s: { id: string; first_name: string; last_name: string }) => ({
      id: s.id,
      displayName: `${s.first_name} ${s.last_name}`,
    });
    return {
      id: r.id,
      email: r.email,
      firstName: r.first_name,
      lastName: r.last_name,
      displayName: `${r.first_name} ${r.last_name}`,
      employeeId: r.employee_id,
      jobTitle: r.job_title,
      status: r.status,
      location: r.location_id ? { id: r.location_id, name: r.location_name! } : null,
      department: r.department_id ? { id: r.department_id, name: r.department_name! } : null,
      teams: teams.get(id) ?? [],
      roles: roles.get(id) ?? [],
      lastLoginAt: r.last_login_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
      phone: r.phone,
      hiredAt: r.hired_at ? String(r.hired_at).slice(0, 10) : null,
      managers: supervisors.filter((s) => s.kind === 'manager').map(person),
      trainers: supervisors.filter((s) => s.kind === 'trainer').map(person),
      directReports: reports.map(person),
      managedTeams,
      activatedAt: r.activated_at?.toISOString() ?? null,
      deactivatedAt: r.deactivated_at?.toISOString() ?? null,
      deactivationReason: r.deactivation_reason,
    };
  }

  async teamsOf(db: DbOrTrx, userIds: string[]): Promise<Map<string, Array<{ id: string; name: string }>>> {
    if (!userIds.length) return new Map();
    const rows = await db
      .selectFrom('team_members as tm')
      .innerJoin('teams as t', 't.id', 'tm.team_id')
      .select(['tm.user_id', 't.id', 't.name'])
      .where('tm.user_id', 'in', userIds)
      .where('t.archived_at', 'is', null)
      .orderBy('t.name')
      .execute();
    const map = new Map<string, Array<{ id: string; name: string }>>();
    for (const r of rows) map.set(r.user_id, [...(map.get(r.user_id) ?? []), { id: r.id, name: r.name }]);
    return map;
  }

  async rolesOf(db: DbOrTrx, userIds: string[]): Promise<Map<string, Array<{ id: string; key: string; name: string }>>> {
    if (!userIds.length) return new Map();
    const rows = await db
      .selectFrom('user_roles as ur')
      .innerJoin('roles as r', 'r.id', 'ur.role_id')
      .select(['ur.user_id', 'r.id', 'r.key', 'r.name'])
      .where('ur.user_id', 'in', userIds)
      .orderBy('r.name')
      .execute();
    const map = new Map<string, Array<{ id: string; key: string; name: string }>>();
    for (const r of rows) map.set(r.user_id, [...(map.get(r.user_id) ?? []), { id: r.id, key: r.key, name: r.name }]);
    return map;
  }

  /** Team ids of a user (for single-record scope checks). */
  async teamIdsOf(db: DbOrTrx, userId: string): Promise<string[]> {
    const rows = await db.selectFrom('team_members').select('team_id').where('user_id', '=', userId).execute();
    return rows.map((r) => r.team_id);
  }
}
