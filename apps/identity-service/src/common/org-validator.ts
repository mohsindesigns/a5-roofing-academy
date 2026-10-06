import { ValidationError } from '@a5/nest-kit';
import type { DbOrTrx } from '../database/index.js';

/** Validates that referenced org units and people exist in the actor's organization. */
export async function assertOrgReferences(
  db: DbOrTrx,
  organizationId: string,
  refs: {
    locationId?: string | null;
    departmentId?: string | null;
    teamIds?: readonly string[];
    supervisorIds?: readonly string[];
    roleIds?: readonly string[];
  },
): Promise<void> {
  const problems: Array<{ path: string; message: string }> = [];
  if (refs.locationId) {
    const ok = await db
      .selectFrom('locations')
      .select('id')
      .where('id', '=', refs.locationId)
      .where('organization_id', '=', organizationId)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (!ok) problems.push({ path: 'locationId', message: 'Choose an active location.' });
  }
  if (refs.departmentId) {
    const ok = await db
      .selectFrom('departments')
      .select('id')
      .where('id', '=', refs.departmentId)
      .where('organization_id', '=', organizationId)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (!ok) problems.push({ path: 'departmentId', message: 'Choose an active department.' });
  }
  if (refs.teamIds?.length) {
    const found = await db
      .selectFrom('teams')
      .select('id')
      .where('id', 'in', [...refs.teamIds])
      .where('organization_id', '=', organizationId)
      .where('archived_at', 'is', null)
      .execute();
    if (found.length !== new Set(refs.teamIds).size)
      problems.push({
        path: 'teamIds',
        message: 'One or more teams do not exist or are archived.',
      });
  }
  if (refs.supervisorIds?.length) {
    const found = await db
      .selectFrom('users')
      .select('id')
      .where('id', 'in', [...refs.supervisorIds])
      .where('organization_id', '=', organizationId)
      .where('status', 'in', ['active', 'invited'])
      .execute();
    if (found.length !== new Set(refs.supervisorIds).size) {
      problems.push({
        path: 'managerIds',
        message: 'Managers and trainers must be active people in your organization.',
      });
    }
  }
  if (refs.roleIds?.length) {
    const found = await db
      .selectFrom('roles')
      .select('id')
      .where('id', 'in', [...refs.roleIds])
      .where('organization_id', '=', organizationId)
      .where('archived_at', 'is', null)
      .execute();
    if (found.length !== new Set(refs.roleIds).size)
      problems.push({
        path: 'roleIds',
        message: 'One or more roles do not exist or are archived.',
      });
  }
  if (problems.length) throw new ValidationError(problems);
}
