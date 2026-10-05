import { hash, Algorithm } from '@node-rs/argon2';
import { writeOutbox } from '@a5/database';
import { buildEvent, identityEvents, streamFor, type EventEnvelope } from '@a5/events';
import { uuidv7 } from '@a5/observability';
import {
  DEFAULT_SEED_PASSWORD,
  DEPARTMENTS,
  LOCATIONS,
  ORGANIZATION,
  PEOPLE,
  TEAMS,
  TRAINER_ASSIGNMENTS,
  directoryTeams,
  directoryUnits,
  directoryUsers,
  emailOf,
} from '@a5/seed-data';
import type { Db, Trx } from '../database/index.js';
import { provisionOrganization, syncPermissionCatalog } from '../access/provisioning.js';

export interface SeedOptions {
  password?: string;
  /** Use cheaper hashing in tests. */
  fastHash?: boolean;
  log?: (line: string) => void;
}

function event(def: Parameters<typeof buildEvent>[0], payload: unknown, subject: { type: string; id: string }): EventEnvelope {
  return buildEvent(def, payload as never, {
    id: uuidv7(),
    producer: 'identity-service',
    organizationId: ORGANIZATION.id,
    actor: { type: 'system', id: null },
    subject,
  });
}

async function emit(trx: Trx, events: EventEnvelope[]) {
  await writeOutbox(
    trx,
    events.map((e) => ({
      id: e.id,
      type: e.type,
      version: e.version,
      stream: streamFor('identity-service'),
      envelope: e,
      published_at: null,
      last_error: null,
    })),
  );
}

/**
 * Seed the A5 Roofing organization: locations, departments, teams, people, roles and
 * relationships. Idempotent: does nothing when the organization already exists.
 */
export async function seedIdentity(db: Db, options: SeedOptions = {}): Promise<{ created: boolean }> {
  const log = options.log ?? (() => undefined);
  await syncPermissionCatalog(db);
  const existing = await db.selectFrom('organizations').select('id').where('id', '=', ORGANIZATION.id).executeTakeFirst();
  if (existing) {
    log('identity: organization already seeded');
    return { created: false };
  }

  const password = options.password ?? DEFAULT_SEED_PASSWORD;
  const passwordHash = await hash(
    password,
    options.fastHash
      ? { algorithm: Algorithm.Argon2id, memoryCost: 1024, timeCost: 1, parallelism: 1 }
      : { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 },
  );

  await db.transaction().execute(async (trx) => {
    await provisionOrganization(trx, {
      id: ORGANIZATION.id,
      slug: ORGANIZATION.slug,
      name: ORGANIZATION.name,
      legalName: ORGANIZATION.legalName,
      timezone: ORGANIZATION.timezone,
    });
    await trx
      .updateTable('organizations')
      .set({ support_email: `sales-enablement@${ORGANIZATION.emailDomain}` })
      .where('id', '=', ORGANIZATION.id)
      .execute();

    for (const l of LOCATIONS) {
      await trx
        .insertInto('locations')
        .values({ id: l.id, organization_id: ORGANIZATION.id, name: l.name, code: l.code, city: l.city, state: l.state, timezone: l.timezone, archived_at: null })
        .execute();
    }
    for (const d of DEPARTMENTS) {
      await trx
        .insertInto('departments')
        .values({ id: d.id, organization_id: ORGANIZATION.id, name: d.name, code: d.code, archived_at: null })
        .execute();
    }
    for (const t of TEAMS) {
      await trx
        .insertInto('teams')
        .values({
          id: t.id,
          organization_id: ORGANIZATION.id,
          name: t.name,
          description: t.description,
          location_id: t.locationId,
          department_id: t.departmentId,
          archived_at: null,
          created_by: null,
        })
        .execute();
    }

    const roles = await trx.selectFrom('roles').select(['id', 'key']).where('organization_id', '=', ORGANIZATION.id).execute();
    const roleId = (key: string) => roles.find((r) => r.key === key)!.id;
    const activatedAt = new Date('2026-08-20T14:00:00Z');

    for (const p of Object.values(PEOPLE)) {
      await trx
        .insertInto('users')
        .values({
          id: p.id,
          organization_id: ORGANIZATION.id,
          email: emailOf(p),
          first_name: p.firstName,
          last_name: p.lastName,
          employee_id: p.employeeId,
          job_title: p.jobTitle,
          phone: p.phone,
          location_id: p.locationId,
          department_id: p.departmentId,
          hired_at: p.hiredAt,
          status: 'active',
          activated_at: activatedAt,
          deactivated_at: null,
          deactivation_reason: null,
          last_login_at: null,
          locked_until: null,
          created_by: null,
          updated_by: null,
        })
        .execute();
      await trx.insertInto('credentials').values({ user_id: p.id, password_hash: passwordHash }).execute();
      await trx
        .insertInto('user_roles')
        .values(p.roles.map((r) => ({ user_id: p.id, role_id: roleId(r), assigned_by: null })))
        .execute();
    }

    for (const t of TEAMS) {
      await trx.insertInto('team_managers').values(t.managers.map((m) => ({ team_id: t.id, user_id: PEOPLE[m].id }))).execute();
      await trx.insertInto('team_members').values(t.members.map((m) => ({ team_id: t.id, user_id: PEOPLE[m].id }))).execute();
      for (const member of t.members) {
        for (const manager of t.managers) {
          await trx
            .insertInto('user_relationships')
            .values({ user_id: PEOPLE[member].id, supervisor_id: PEOPLE[manager].id, kind: 'manager' })
            .execute();
        }
      }
    }
    for (const a of TRAINER_ASSIGNMENTS) {
      await trx
        .insertInto('user_relationships')
        .values(a.trainees.map((t) => ({ user_id: PEOPLE[t].id, supervisor_id: PEOPLE[a.trainer].id, kind: 'trainer' as const })))
        .execute();
    }

    // Directory events so other services build their projections when they run.
    const events: EventEnvelope[] = [
      ...directoryUnits().map((unit) =>
        event(identityEvents.directoryUnitUpserted, { unit, revision: 1 }, { type: unit.kind, id: unit.id }),
      ),
      ...directoryTeams().map((team) =>
        event(identityEvents.directoryTeamUpserted, { team, revision: 1 }, { type: 'team', id: team.id }),
      ),
      ...directoryUsers().map((user) =>
        event(identityEvents.directoryUserUpserted, { user, revision: 1 }, { type: 'user', id: user.id }),
      ),
    ];
    await emit(trx, events);
  });
  log(`identity: seeded ${Object.keys(PEOPLE).length} people, ${TEAMS.length} teams`);
  return { created: true };
}

