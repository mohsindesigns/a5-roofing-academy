import type { DirectoryTeamRecord, DirectoryUnitRecord, DirectoryUserRecord } from '@a5/events';
import {
  DEPARTMENTS,
  LOCATIONS,
  ORGANIZATION,
  PEOPLE,
  TEAMS,
  TRAINER_ASSIGNMENTS,
  emailOf,
  type PersonKey,
} from './organization.js';

/** Directory record for a seeded person, identical to what identity-service publishes. */
export function directoryUser(key: PersonKey): DirectoryUserRecord {
  const p = PEOPLE[key];
  const teams = TEAMS.filter((t) => (t.members as readonly string[]).includes(key));
  return {
    id: p.id,
    organizationId: ORGANIZATION.id,
    firstName: p.firstName,
    lastName: p.lastName,
    displayName: `${p.firstName} ${p.lastName}`,
    email: emailOf(p),
    employeeId: p.employeeId,
    jobTitle: p.jobTitle,
    status: 'active',
    locationId: p.locationId,
    departmentId: p.departmentId,
    teamIds: teams.map((t) => t.id),
    managerIds: teams.flatMap((t) => t.managers.map((m) => PEOPLE[m].id)),
    trainerIds: TRAINER_ASSIGNMENTS.filter((a) => a.trainees.includes(key)).map(
      (a) => PEOPLE[a.trainer].id,
    ),
    roleKeys: [...p.roles],
    hiredAt: new Date(`${p.hiredAt}T00:00:00Z`).toISOString(),
  };
}

export function directoryUsers(): DirectoryUserRecord[] {
  return (Object.keys(PEOPLE) as PersonKey[]).map(directoryUser);
}

export function directoryTeams(): DirectoryTeamRecord[] {
  return TEAMS.map((t) => ({
    id: t.id,
    organizationId: ORGANIZATION.id,
    name: t.name,
    locationId: t.locationId,
    departmentId: t.departmentId,
    managerIds: t.managers.map((m) => PEOPLE[m].id),
    memberIds: t.members.map((m) => PEOPLE[m].id),
    archived: false,
  }));
}

export function directoryUnits(): DirectoryUnitRecord[] {
  return [
    ...LOCATIONS.map((l) => ({
      id: l.id,
      organizationId: ORGANIZATION.id,
      kind: 'location' as const,
      name: l.name,
      archived: false,
    })),
    ...DEPARTMENTS.map((d) => ({
      id: d.id,
      organizationId: ORGANIZATION.id,
      kind: 'department' as const,
      name: d.name,
      archived: false,
    })),
  ];
}
