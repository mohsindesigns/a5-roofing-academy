import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from '@a5/database';
import {
  identityEvents,
  type DirectoryTeamRecord,
  type DirectoryUnitRecord,
  type DirectoryUserRecord,
  type EventEnvelope,
} from '@a5/events';
import { processOnce } from '@a5/messaging';
import { InjectDb, OnEvent } from '@a5/nest-kit';
import type { InboxSchema } from '@a5/database';
import type { DirectorySchema } from './schema.js';

type Db = Kysely<DirectorySchema & InboxSchema>;
type Trx = Transaction<DirectorySchema & InboxSchema>;

/**
 * Applies a full user record. Older revisions are ignored, so out-of-order delivery is harmless.
 * Returns false when the stored revision is newer.
 */
export async function applyDirectoryUser(trx: Trx, user: DirectoryUserRecord, revision: number): Promise<boolean> {
  const result = await trx
    .insertInto('dir_users')
    .values({
      id: user.id,
      organization_id: user.organizationId,
      first_name: user.firstName,
      last_name: user.lastName,
      display_name: user.displayName,
      email: user.email,
      employee_id: user.employeeId,
      job_title: user.jobTitle,
      status: user.status,
      location_id: user.locationId,
      department_id: user.departmentId,
      role_keys: user.roleKeys,
      hired_at: user.hiredAt ? new Date(user.hiredAt) : null,
      revision,
    })
    .onConflict((oc) =>
      oc
        .column('id')
        .doUpdateSet((eb) => ({
          organization_id: eb.ref('excluded.organization_id'),
          first_name: eb.ref('excluded.first_name'),
          last_name: eb.ref('excluded.last_name'),
          display_name: eb.ref('excluded.display_name'),
          email: eb.ref('excluded.email'),
          employee_id: eb.ref('excluded.employee_id'),
          job_title: eb.ref('excluded.job_title'),
          status: eb.ref('excluded.status'),
          location_id: eb.ref('excluded.location_id'),
          department_id: eb.ref('excluded.department_id'),
          role_keys: eb.ref('excluded.role_keys'),
          hired_at: eb.ref('excluded.hired_at'),
          revision: eb.ref('excluded.revision'),
          updated_at: sql<Date>`now()`,
        }))
        .where('dir_users.revision', '<', revision),
    )
    .executeTakeFirst();
  if ((result.numInsertedOrUpdatedRows ?? 0n) === 0n) return false;

  await trx.deleteFrom('dir_user_teams').where('user_id', '=', user.id).execute();
  if (user.teamIds.length) {
    await trx.insertInto('dir_user_teams').values(user.teamIds.map((team_id) => ({ user_id: user.id, team_id }))).execute();
  }
  await trx.deleteFrom('dir_user_supervisors').where('user_id', '=', user.id).execute();
  const supervisors = [
    ...user.managerIds.map((id) => ({ user_id: user.id, supervisor_id: id, kind: 'manager' as const })),
    ...user.trainerIds.map((id) => ({ user_id: user.id, supervisor_id: id, kind: 'trainer' as const })),
  ];
  if (supervisors.length) await trx.insertInto('dir_user_supervisors').values(supervisors).execute();
  return true;
}

export async function applyDirectoryTeam(trx: Trx, team: DirectoryTeamRecord, revision: number): Promise<boolean> {
  const result = await trx
    .insertInto('dir_teams')
    .values({
      id: team.id,
      organization_id: team.organizationId,
      name: team.name,
      location_id: team.locationId,
      department_id: team.departmentId,
      archived: team.archived,
      revision,
    })
    .onConflict((oc) =>
      oc
        .column('id')
        .doUpdateSet((eb) => ({
          name: eb.ref('excluded.name'),
          location_id: eb.ref('excluded.location_id'),
          department_id: eb.ref('excluded.department_id'),
          archived: eb.ref('excluded.archived'),
          revision: eb.ref('excluded.revision'),
        }))
        .where('dir_teams.revision', '<', revision),
    )
    .executeTakeFirst();
  if ((result.numInsertedOrUpdatedRows ?? 0n) === 0n) return false;
  await trx.deleteFrom('dir_team_managers').where('team_id', '=', team.id).execute();
  if (team.managerIds.length) {
    await trx.insertInto('dir_team_managers').values(team.managerIds.map((user_id) => ({ team_id: team.id, user_id }))).execute();
  }
  return true;
}

export async function applyDirectoryUnit(trx: Trx, unit: DirectoryUnitRecord, revision: number): Promise<boolean> {
  const result = await trx
    .insertInto('dir_units')
    .values({
      id: unit.id,
      organization_id: unit.organizationId,
      kind: unit.kind,
      name: unit.name,
      archived: unit.archived,
      revision,
    })
    .onConflict((oc) =>
      oc
        .column('id')
        .doUpdateSet((eb) => ({
          name: eb.ref('excluded.name'),
          archived: eb.ref('excluded.archived'),
          revision: eb.ref('excluded.revision'),
        }))
        .where('dir_units.revision', '<', revision),
    )
    .executeTakeFirst();
  return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
}

/** Event handlers that keep the local directory projection current. */
@Injectable()
export class DirectoryProjection {
  constructor(@InjectDb() private readonly db: Db) {}

  @OnEvent(identityEvents.directoryUserUpserted)
  async onUser(event: EventEnvelope) {
    const { user, revision } = event.payload as { user: DirectoryUserRecord; revision: number };
    await processOnce(this.db, 'directory.user', event, (trx) => applyDirectoryUser(trx, user, revision).then(() => undefined));
  }

  @OnEvent(identityEvents.directoryTeamUpserted)
  async onTeam(event: EventEnvelope) {
    const { team, revision } = event.payload as { team: DirectoryTeamRecord; revision: number };
    await processOnce(this.db, 'directory.team', event, (trx) => applyDirectoryTeam(trx, team, revision).then(() => undefined));
  }

  @OnEvent(identityEvents.directoryUnitUpserted)
  async onUnit(event: EventEnvelope) {
    const { unit, revision } = event.payload as { unit: DirectoryUnitRecord; revision: number };
    await processOnce(this.db, 'directory.unit', event, (trx) => applyDirectoryUnit(trx, unit, revision).then(() => undefined));
  }
}
