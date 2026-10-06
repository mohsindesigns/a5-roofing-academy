import { Injectable } from '@nestjs/common';
import { sql } from '@a5/database';
import { DirectoryReader, type DirectoryUser } from '@a5/directory';
import { InjectDb } from '@a5/nest-kit';
import type { Db } from '../database/index.js';

/** Upper bound for broadcast recipients (role:<key>, enrolled_learners) of a single event. */
export const MAX_BROADCAST_RECIPIENTS = 2_000;

export interface ResolvedRecipient {
  userId: string;
  email: string | null;
  firstName: string;
  displayName: string;
}

export interface SubjectFallback {
  email: string | null;
  displayName: string | null;
}

export interface ResolveInput {
  organizationId: string;
  subjectId: string | null;
  programId: string | null;
  /** The person who caused the event; never notified about their own action (except as subject). */
  actorUserId: string | null;
  /** Contact details from the event payload, used when the directory has not caught up yet. */
  subjectFallback: SubjectFallback | null;
}

function firstNameOf(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

/** Turns rule recipient kinds into people, using the local directory projection. */
@Injectable()
export class RecipientResolver {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly directory: DirectoryReader,
  ) {}

  async resolve(kinds: readonly string[], input: ResolveInput): Promise<ResolvedRecipient[]> {
    const ids = new Set<string>();
    const includeSubject = Boolean(input.subjectId && kinds.includes('subject'));
    const others = new Set<string>();

    for (const kind of kinds) {
      if (kind === 'subject') continue;
      for (const id of await this.idsFor(kind, input)) others.add(id);
    }
    if (input.actorUserId) others.delete(input.actorUserId);
    if (includeSubject) ids.add(input.subjectId!);
    for (const id of others) ids.add(id);
    if (ids.size === 0) return [];

    const users = await this.directory.getUsers([...ids]);
    const out: ResolvedRecipient[] = [];
    for (const id of ids) {
      const user = users.get(id);
      if (user) {
        if (!this.reachable(user, input.organizationId)) continue;
        out.push({
          userId: id,
          email: user.email || null,
          firstName: user.firstName,
          displayName: user.displayName,
        });
      } else if (id === input.subjectId) {
        // The directory has not caught up with a brand-new person yet: use the event's details.
        const name = input.subjectFallback?.displayName ?? null;
        out.push({
          userId: id,
          email: input.subjectFallback?.email ?? null,
          firstName: name ? firstNameOf(name) : 'there',
          displayName: name ?? 'A5 team member',
        });
      }
    }
    return out;
  }

  private reachable(user: DirectoryUser, organizationId: string): boolean {
    return user.organizationId === organizationId && user.status !== 'deactivated';
  }

  private async idsFor(kind: string, input: ResolveInput): Promise<string[]> {
    const subject = input.subjectId;
    switch (kind) {
      case 'managers':
        return subject ? this.directory.managersOf(subject) : [];
      case 'trainers':
        return subject ? this.directory.trainersOf(subject) : [];
      case 'team_managers': {
        if (!subject) return [];
        const rows = await this.db
          .selectFrom('dir_team_managers as m')
          .innerJoin('dir_user_teams as t', 't.team_id', 'm.team_id')
          .innerJoin('dir_teams as team', 'team.id', 'm.team_id')
          .select('m.user_id')
          .distinct()
          .where('t.user_id', '=', subject)
          .where('team.archived', '=', false)
          .where('m.user_id', '<>', subject)
          .execute();
        return rows.map((r) => r.user_id);
      }
      case 'enrolled_learners': {
        if (!input.programId) return [];
        const rows = await this.db
          .selectFrom('program_learners')
          .select('user_id')
          .where('program_id', '=', input.programId)
          .where('organization_id', '=', input.organizationId)
          .where('withdrawn_at', 'is', null)
          .limit(MAX_BROADCAST_RECIPIENTS)
          .execute();
        return rows.map((r) => r.user_id);
      }
      default: {
        if (!kind.startsWith('role:')) return [];
        const role = kind.slice('role:'.length);
        const rows = await this.db
          .selectFrom('dir_users')
          .select('id')
          .where('organization_id', '=', input.organizationId)
          .where(sql<boolean>`${role} = any(role_keys)`)
          .where('status', '<>', 'deactivated')
          .orderBy('id')
          .limit(MAX_BROADCAST_RECIPIENTS)
          .execute();
        return rows.map((r) => r.id);
      }
    }
  }
}
