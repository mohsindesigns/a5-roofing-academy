import { learningEvents } from '@a5/events';
import type { EventBus } from '@a5/nest-kit';
import { NotFoundError, PreconditionError } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import type { Trx } from '../database/index.js';
import { loadWorkingTree } from '../engine/tree-loader.js';
import type { ProgressService } from '../engine/progress.service.js';
import { orderedLessons, requirementMap, treeStats, type ProgramTree } from '../engine/tree.js';
import { publishIssues } from './publish-validation.js';

export interface PublishActor {
  userId: string | null;
  displayName: string;
}

/**
 * The publish transaction, free of Nest so the seed runs exactly the same code path as the API:
 * validates the working copy, publishes every draft node atomically, writes an immutable snapshot
 * (program_versions), emits program.published with the requirement map other services need and
 * re-evaluates every enrollment against the new version.
 */
export class PublishCore {
  constructor(
    private readonly events: EventBus,
    private readonly progress: ProgressService,
  ) {}

  async publish(
    trx: Trx,
    input: {
      organizationId: string;
      programId: string;
      changeNote: string;
      actor: PublishActor;
      at?: Date;
    },
  ): Promise<number> {
    const at = input.at ?? new Date();
    const program = await trx
      .selectFrom('programs')
      .selectAll()
      .where('id', '=', input.programId)
      .where('organization_id', '=', input.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!program) throw new NotFoundError('Program');
    if (program.status === 'archived')
      throw new PreconditionError('PROGRAM_ARCHIVED', 'Restore the program before publishing it.');
    if (
      program.published_version > 0 &&
      Number(program.published_revision) === Number(program.revision)
    ) {
      throw new PreconditionError('NO_CHANGES', 'There are no unpublished changes to publish.');
    }

    const tree = (await loadWorkingTree(trx, input.programId))!;
    const issues = publishIssues(tree);
    if (issues.length) {
      throw new PreconditionError(
        'PUBLISH_BLOCKED',
        `Fix ${issues.length === 1 ? 'this issue' : `these ${issues.length} issues`} before publishing: ${issues.map((i) => i.message).join(' ')}`,
        { issues },
      );
    }
    const version = program.published_version + 1;
    const snapshot: ProgramTree = { ...tree, version };

    const phaseIds = snapshot.phases.map((ph) => ph.id);
    const moduleIds = snapshot.phases.flatMap((ph) => ph.modules.map((m) => m.id));
    const lessonIds = orderedLessons(snapshot).map((l) => l.lesson.id);
    const publishNodes = async (
      table: 'program_phases' | 'program_modules' | 'lessons',
      ids: string[],
    ) => {
      if (ids.length) {
        await trx
          .updateTable(table)
          .set((eb) => ({
            status: eb
              .case()
              .when('status', '=', 'draft')
              .then('published' as const)
              .else(eb.ref('status'))
              .end(),
            first_published_at: eb.fn.coalesce('first_published_at', eb.val(at)),
            unpublished_changes: false,
          }))
          .where('id', 'in', ids)
          .execute();
      }
      // Archivals go live with this version as well.
      await trx
        .updateTable(table)
        .set({ unpublished_changes: false })
        .where('program_id', '=', input.programId)
        .where('status', '=', 'archived')
        .execute();
    };
    await publishNodes('program_phases', phaseIds);
    await publishNodes('program_modules', moduleIds);
    await publishNodes('lessons', lessonIds);

    const stats = treeStats(snapshot);
    await trx
      .insertInto('program_versions')
      .values({
        id: uuidv7(),
        program_id: input.programId,
        version,
        change_note: input.changeNote,
        snapshot: snapshot as unknown as Record<string, unknown>,
        stats,
        published_by: input.actor.userId,
        published_by_name: input.actor.displayName,
        published_at: at,
      })
      .execute();
    await trx
      .updateTable('programs')
      .set({
        status: 'published',
        published_version: version,
        published_revision: program.revision,
        published_at: at,
        archived_at: null,
        ...(input.actor.userId && { updated_by: input.actor.userId }),
      })
      .where('id', '=', input.programId)
      .execute();

    const map = requirementMap(snapshot);
    await this.events.emit(
      trx,
      learningEvents.programPublished,
      {
        programId: input.programId,
        title: snapshot.title,
        version,
        phases: map.phases.map((ph) => ({
          phaseId: ph.phaseId,
          title: ph.title,
          position: ph.position,
        })),
        requiredLessonIds: map.requiredLessonIds,
        assessments: map.assessments,
        aiScenarios: map.aiScenarios,
      },
      { organizationId: input.organizationId, subject: { type: 'program', id: input.programId } },
    );
    await this.events.audit(
      trx,
      {
        action: 'program.published',
        resourceType: 'program',
        resourceId: input.programId,
        actorDisplay: input.actor.displayName,
        before: { version: program.published_version },
        after: { version, changeNote: input.changeNote, ...stats },
      },
      { organizationId: input.organizationId },
    );

    // Everyone enrolled is now on the new version: refresh their denormalised progress.
    const enrollments = await trx
      .selectFrom('enrollments')
      .selectAll()
      .where('program_id', '=', input.programId)
      .where('status', 'in', ['active', 'completed'])
      .orderBy('id')
      .forUpdate()
      .execute();
    for (const enrollment of enrollments)
      await this.progress.sync(trx, enrollment, snapshot, { at });
    return version;
  }
}
