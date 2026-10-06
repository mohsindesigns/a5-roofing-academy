import { sql } from '@a5/database';
import { defaultFeatureFlags } from '@a5/contracts';
import { uuidv7 } from '@a5/observability';
import { DEFAULT_ROLES, PERMISSIONS } from '@a5/permissions';
import type { Db, Trx } from '../database/index.js';

export const DEFAULT_SECURITY_SETTINGS = {
  passwordMinLength: 12,
  lockoutThreshold: 5,
  lockoutMinutes: 15,
  sessionIdleMinutes: 7 * 24 * 60,
  sessionMaxHours: 30 * 24,
};

/**
 * Upsert the code-defined permission catalog. Keys removed from code are deleted (cascading to
 * role grants), because a permission that nothing enforces must not appear grantable.
 */
export async function syncPermissionCatalog(db: Db): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext('a5-permission-catalog'))`.execute(trx);
    for (const p of PERMISSIONS) {
      await trx
        .insertInto('permissions')
        .values({
          key: p.key,
          module: p.module,
          label: p.label,
          description: p.description,
          scoped: p.scoped ?? false,
          platform: p.platform ?? false,
        })
        .onConflict((oc) =>
          oc.column('key').doUpdateSet((eb) => ({
            module: eb.ref('excluded.module'),
            label: eb.ref('excluded.label'),
            description: eb.ref('excluded.description'),
            scoped: eb.ref('excluded.scoped'),
            platform: eb.ref('excluded.platform'),
            updated_at: sql<Date>`now()`,
          })),
        )
        .execute();
    }
    await trx
      .deleteFrom('permissions')
      .where(
        'key',
        'not in',
        PERMISSIONS.map((p) => p.key),
      )
      .execute();
    const orgs = await trx.selectFrom('organizations').select('id').execute();
    for (const org of orgs) await ensureSystemRoles(trx, org.id);
  });
}

/** Create any built-in roles an organization is missing (new roles shipped in code). */
export async function ensureSystemRoles(trx: Trx, organizationId: string): Promise<void> {
  const existing = await trx
    .selectFrom('roles')
    .select('key')
    .where('organization_id', '=', organizationId)
    .execute();
  const have = new Set(existing.map((r) => r.key));
  for (const role of DEFAULT_ROLES) {
    if (have.has(role.key)) continue;
    const id = uuidv7();
    await trx
      .insertInto('roles')
      .values({
        id,
        organization_id: organizationId,
        key: role.key,
        name: role.name,
        description: role.description,
        is_system: true,
        locked: role.locked,
        data_scope: role.dataScope,
        archived_at: null,
        created_by: null,
        updated_by: null,
      })
      .execute();
    await trx
      .insertInto('role_permissions')
      .values(role.permissions.map((p) => ({ role_id: id, permission_key: p, granted_by: null })))
      .execute();
  }
  // The super administrator role always mirrors the full catalog.
  const superAdmin = await trx
    .selectFrom('roles')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('key', '=', 'super_admin')
    .executeTakeFirst();
  if (superAdmin) {
    await trx
      .insertInto('role_permissions')
      .values(
        PERMISSIONS.map((p) => ({
          role_id: superAdmin.id,
          permission_key: p.key,
          granted_by: null,
        })),
      )
      .onConflict((oc) => oc.columns(['role_id', 'permission_key']).doNothing())
      .execute();
  }
}

export interface NewOrganization {
  id?: string;
  slug: string;
  name: string;
  legalName?: string | null;
  timezone?: string;
}

export async function provisionOrganization(trx: Trx, input: NewOrganization): Promise<string> {
  const id = input.id ?? uuidv7();
  await trx
    .insertInto('organizations')
    .values({
      id,
      slug: input.slug,
      name: input.name,
      legal_name: input.legalName ?? null,
      timezone: input.timezone ?? 'America/Chicago',
      support_email: null,
      branding: { primaryColor: null, accentColor: null, logoUrl: null },
      security: DEFAULT_SECURITY_SETTINGS,
    })
    .execute();
  await ensureSystemRoles(trx, id);
  const flags = defaultFeatureFlags();
  await trx
    .insertInto('feature_flags')
    .values(
      Object.entries(flags).map(([key, enabled]) => ({
        organization_id: id,
        key,
        enabled,
        updated_by: null,
      })),
    )
    .execute();
  return id;
}
