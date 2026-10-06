import { Injectable } from '@nestjs/common';
import { sql } from '@a5/database';
import { identityEvents, type DirectoryTeamRecord, type DirectoryUserRecord } from '@a5/events';
import { EventBus } from '@a5/nest-kit';
import type { Trx } from '../database/index.js';

/**
 * Emits full-state directory events for users, teams and units inside the caller's transaction.
 * Each call bumps the entity revision so consumers can discard out-of-order updates.
 */
@Injectable()
export class DirectoryPublisher {
  constructor(private readonly events: EventBus) {}

  async users(trx: Trx, userIds: readonly string[]): Promise<void> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return;
    const rows = await trx
      .updateTable('users')
      .set((eb) => ({ revision: eb('revision', '+', 1) }))
      .where('id', 'in', ids)
      .returning([
        'id',
        'organization_id',
        'first_name',
        'last_name',
        'email',
        'employee_id',
        'job_title',
        'status',
        'location_id',
        'department_id',
        'hired_at',
        'revision',
      ])
      .execute();
    const teams = await trx
      .selectFrom('team_members')
      .select(['user_id', 'team_id'])
      .where('user_id', 'in', ids)
      .execute();
    const supervisors = await trx
      .selectFrom('user_relationships')
      .select(['user_id', 'supervisor_id', 'kind'])
      .where('user_id', 'in', ids)
      .execute();
    const roles = await trx
      .selectFrom('user_roles')
      .innerJoin('roles', 'roles.id', 'user_roles.role_id')
      .select(['user_roles.user_id', 'roles.key'])
      .where('user_roles.user_id', 'in', ids)
      .execute();

    for (const u of rows) {
      const record: DirectoryUserRecord = {
        id: u.id,
        organizationId: u.organization_id,
        firstName: u.first_name,
        lastName: u.last_name,
        displayName: `${u.first_name} ${u.last_name}`,
        email: u.email,
        employeeId: u.employee_id,
        jobTitle: u.job_title,
        status: u.status,
        locationId: u.location_id,
        departmentId: u.department_id,
        teamIds: teams.filter((t) => t.user_id === u.id).map((t) => t.team_id),
        managerIds: supervisors
          .filter((s) => s.user_id === u.id && s.kind === 'manager')
          .map((s) => s.supervisor_id),
        trainerIds: supervisors
          .filter((s) => s.user_id === u.id && s.kind === 'trainer')
          .map((s) => s.supervisor_id),
        roleKeys: roles.filter((r) => r.user_id === u.id).map((r) => r.key),
        hiredAt: u.hired_at ? new Date(`${u.hired_at}T00:00:00Z`).toISOString() : null,
      };
      await this.events.emit(
        trx,
        identityEvents.directoryUserUpserted,
        { user: record, revision: Number(u.revision) },
        { organizationId: u.organization_id, subject: { type: 'user', id: u.id } },
      );
    }
  }

  async teams(trx: Trx, teamIds: readonly string[]): Promise<void> {
    const ids = [...new Set(teamIds)];
    if (ids.length === 0) return;
    const rows = await trx
      .updateTable('teams')
      .set((eb) => ({ revision: eb('revision', '+', 1) }))
      .where('id', 'in', ids)
      .returning([
        'id',
        'organization_id',
        'name',
        'location_id',
        'department_id',
        'archived_at',
        'revision',
      ])
      .execute();
    const managers = await trx
      .selectFrom('team_managers')
      .select(['team_id', 'user_id'])
      .where('team_id', 'in', ids)
      .execute();
    const members = await trx
      .selectFrom('team_members')
      .select(['team_id', 'user_id'])
      .where('team_id', 'in', ids)
      .execute();
    for (const t of rows) {
      const record: DirectoryTeamRecord = {
        id: t.id,
        organizationId: t.organization_id,
        name: t.name,
        locationId: t.location_id,
        departmentId: t.department_id,
        managerIds: managers.filter((m) => m.team_id === t.id).map((m) => m.user_id),
        memberIds: members.filter((m) => m.team_id === t.id).map((m) => m.user_id),
        archived: t.archived_at !== null,
      };
      await this.events.emit(
        trx,
        identityEvents.directoryTeamUpserted,
        { team: record, revision: Number(t.revision) },
        { organizationId: t.organization_id, subject: { type: 'team', id: t.id } },
      );
    }
  }

  async unit(trx: Trx, kind: 'location' | 'department', id: string): Promise<void> {
    const table = kind === 'location' ? 'locations' : 'departments';
    const row = await trx
      .updateTable(table)
      .set({ revision: sql`revision + 1` })
      .where('id', '=', id)
      .returning(['id', 'organization_id', 'name', 'archived_at', 'revision'])
      .executeTakeFirstOrThrow();
    await this.events.emit(
      trx,
      identityEvents.directoryUnitUpserted,
      {
        unit: {
          id: row.id,
          organizationId: row.organization_id,
          kind,
          name: row.name,
          archived: row.archived_at !== null,
        },
        revision: Number(row.revision),
      },
      { organizationId: row.organization_id, subject: { type: kind, id: row.id } },
    );
  }
}
