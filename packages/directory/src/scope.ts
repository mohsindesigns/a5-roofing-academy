import { sql, type Expression, type Kysely, type SqlBool } from '@a5/database';
import type { ScopeFilter } from '@a5/auth';
import type { DirectorySchema } from './schema.js';

/**
 * SQL condition restricting a user-id column to what a scope filter admits.
 *
 * - own:          column = self
 * - managed:      column = self, or a direct report / assigned trainee, or a member of a managed team
 * - organization: org column = principal org (when the table has one), else the directory org
 * - platform:     no restriction
 * - none:         nothing
 *
 * `userColumn` / `orgColumn` are raw SQL references such as `e.user_id`.
 */
export function userScopeCondition(
  filter: ScopeFilter,
  columns: { userColumn: string; orgColumn?: string },
): Expression<SqlBool> {
  const user = sql.ref(columns.userColumn);
  switch (filter.kind) {
    case 'none':
      return sql<SqlBool>`false`;
    case 'platform':
      return sql<SqlBool>`true`;
    case 'own':
      return sql<SqlBool>`${user} = ${filter.userId}`;
    case 'organization':
      return columns.orgColumn
        ? sql<SqlBool>`${sql.ref(columns.orgColumn)} = ${filter.organizationId}`
        : sql<SqlBool>`${user} in (select id from dir_users where organization_id = ${filter.organizationId})`;
    case 'managed': {
      const teamIds = filter.teamIds.length ? filter.teamIds : ['00000000-0000-0000-0000-000000000000'];
      const userIds = [filter.userId, ...filter.userIds];
      return sql<SqlBool>`(
        ${user} = any(${sql.val(userIds)}::uuid[])
        or ${user} in (select user_id from dir_user_teams where team_id = any(${sql.val(teamIds)}::uuid[]))
      )`;
    }
  }
}

export interface DirectoryUser {
  id: string;
  organizationId: string;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string;
  employeeId: string | null;
  jobTitle: string | null;
  status: string;
  locationId: string | null;
  departmentId: string | null;
  teamIds: string[];
}

/** Read helpers over the directory projection. */
export class DirectoryReader {
  constructor(private readonly db: Kysely<DirectorySchema>) {}

  async getUsers(ids: readonly string[]): Promise<Map<string, DirectoryUser>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('dir_users as u')
      .leftJoin('dir_user_teams as t', 't.user_id', 'u.id')
      .select([
        'u.id',
        'u.organization_id',
        'u.display_name',
        'u.first_name',
        'u.last_name',
        'u.email',
        'u.employee_id',
        'u.job_title',
        'u.status',
        'u.location_id',
        'u.department_id',
        sql<string[]>`coalesce(array_agg(t.team_id) filter (where t.team_id is not null), '{}')`.as('team_ids'),
      ])
      .where('u.id', 'in', unique)
      .groupBy('u.id')
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          organizationId: r.organization_id,
          displayName: r.display_name,
          firstName: r.first_name,
          lastName: r.last_name,
          email: r.email,
          employeeId: r.employee_id,
          jobTitle: r.job_title,
          status: r.status,
          locationId: r.location_id,
          departmentId: r.department_id,
          teamIds: r.team_ids,
        },
      ]),
    );
  }

  async getUser(id: string): Promise<DirectoryUser | null> {
    return (await this.getUsers([id])).get(id) ?? null;
  }

  /** Managers of the user's teams plus direct managers. */
  async managersOf(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('dir_team_managers as m')
      .innerJoin('dir_user_teams as t', 't.team_id', 'm.team_id')
      .select('m.user_id')
      .where('t.user_id', '=', userId)
      .union(
        this.db
          .selectFrom('dir_user_supervisors')
          .select('supervisor_id as user_id')
          .where('user_id', '=', userId)
          .where('kind', '=', 'manager'),
      )
      .execute();
    return [...new Set(rows.map((r) => r.user_id))].filter((id) => id !== userId);
  }

  async trainersOf(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('dir_user_supervisors')
      .select('supervisor_id')
      .where('user_id', '=', userId)
      .where('kind', '=', 'trainer')
      .execute();
    return rows.map((r) => r.supervisor_id);
  }

  async teamNames(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.selectFrom('dir_teams').select(['id', 'name']).where('id', 'in', [...new Set(ids)]).execute();
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}
