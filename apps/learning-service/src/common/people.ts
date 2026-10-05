import type { learning } from '@a5/contracts';
import type { DbOrTrx } from '../database/index.js';

export type LearnerRef = learning.EnrollmentSummary['learner'];

/** Learner references (name, email, title, teams) from the directory projection. */
export async function learnerRefs(db: DbOrTrx, userIds: readonly string[]): Promise<Map<string, LearnerRef>> {
  const ids = [...new Set(userIds)];
  const map = new Map<string, LearnerRef>();
  if (ids.length === 0) return map;
  const [users, teams] = await Promise.all([
    db.selectFrom('dir_users').select(['id', 'display_name', 'email', 'job_title']).where('id', 'in', ids).execute(),
    db
      .selectFrom('dir_user_teams as ut')
      .innerJoin('dir_teams as t', 't.id', 'ut.team_id')
      .select(['ut.user_id', 't.id', 't.name'])
      .where('ut.user_id', 'in', ids)
      .where('t.archived', '=', false)
      .orderBy('t.name')
      .execute(),
  ]);
  for (const id of ids) {
    const u = users.find((x) => x.id === id);
    map.set(id, {
      id,
      displayName: u?.display_name ?? 'Unknown learner',
      email: u?.email ?? null,
      jobTitle: u?.job_title ?? null,
      teams: teams.filter((t) => t.user_id === id).map((t) => ({ id: t.id, name: t.name })),
    });
  }
  return map;
}

/** Display names for people (approvers, assigners); unknown ids are omitted. */
export async function displayNames(db: DbOrTrx, userIds: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const rows = await db.selectFrom('dir_users').select(['id', 'display_name']).where('id', 'in', ids).execute();
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

export function personRef(id: string | null, names: Map<string, string>, fallback?: string | null): learning.ApprovalSummary['decidedBy'] {
  if (!id) return null;
  return { id, displayName: names.get(id) ?? fallback ?? 'Former employee' };
}
