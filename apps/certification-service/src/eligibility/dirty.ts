import { sql } from '@a5/database';
import type { DbOrTrx } from '../database/index.js';

/**
 * Mark (definition, user) pairs for re-evaluation inside the caller's transaction. The mark commits
 * with the fact that caused it, so a crash between the projection update and the evaluation never
 * loses work: the sweeper picks up whatever is still marked.
 *
 * A pair is relevant when the certification is active and either has no associated programs, the
 * user is enrolled in one of them, or the user is already a candidate.
 */
export async function markDirty(
  db: DbOrTrx,
  input: {
    organizationId: string;
    userIds: readonly string[];
    definitionIds?: readonly string[];
    learnerActivity: boolean;
  },
): Promise<void> {
  const userIds = [...new Set(input.userIds)];
  if (userIds.length === 0) return;
  const definitionFilter = input.definitionIds
    ? sql`and d.id = any(${sql.val([...input.definitionIds])}::uuid[])`
    : sql``;
  await sql`
    insert into eligibility_dirty (definition_id, user_id, organization_id, marked_at, learner_activity)
    select d.id, u.user_id, d.organization_id, clock_timestamp(), ${input.learnerActivity}
    from certification_definitions d
    cross join unnest(${sql.val(userIds)}::uuid[]) as u(user_id)
    where d.organization_id = ${input.organizationId}
      and d.status = 'active'
      ${definitionFilter}
      and (
        not exists (select 1 from certification_programs cp where cp.definition_id = d.id)
        or exists (
          select 1 from certification_programs cp
          join learner_program_status s on s.program_id = cp.program_id and s.user_id = u.user_id
          where cp.definition_id = d.id
        )
        or exists (select 1 from certification_candidates c where c.definition_id = d.id and c.user_id = u.user_id)
      )
    on conflict (definition_id, user_id) do update
      set marked_at = excluded.marked_at,
          learner_activity = eligibility_dirty.learner_activity or excluded.learner_activity
  `.execute(db);
}

/** Mark every candidate (and enrolled learner) of the given certifications, e.g. after a rule change. */
export async function markDefinitionsDirty(
  db: DbOrTrx,
  definitionIds: readonly string[],
  learnerActivity = false,
): Promise<void> {
  if (definitionIds.length === 0) return;
  await sql`
    insert into eligibility_dirty (definition_id, user_id, organization_id, marked_at, learner_activity)
    select d.id, x.user_id, d.organization_id, clock_timestamp(), ${learnerActivity}
    from certification_definitions d
    join lateral (
      select c.user_id from certification_candidates c where c.definition_id = d.id
      union
      select s.user_id from certification_programs cp
      join learner_program_status s on s.program_id = cp.program_id
      where cp.definition_id = d.id and s.organization_id = d.organization_id
    ) x on true
    where d.id = any(${sql.val([...definitionIds])}::uuid[]) and d.status = 'active'
    on conflict (definition_id, user_id) do update
      set marked_at = excluded.marked_at,
          learner_activity = eligibility_dirty.learner_activity or excluded.learner_activity
  `.execute(db);
}
