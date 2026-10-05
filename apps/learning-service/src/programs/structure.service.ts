import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { Principal } from '@a5/auth';
import { learning } from '@a5/contracts';
import { sql, type Selectable } from '@a5/database';
import { EventBus, InjectDb, NotFoundError, PreconditionError, ValidationError } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import type { Rule } from '@a5/rules';
import type { Db, LessonsTable, ProgramModulesTable, ProgramPhasesTable, ProgramsTable, Trx } from '../database/index.js';
import { ruleReferences } from '../engine/tree.js';
import { TreeService } from '../engine/tree.service.js';
import { lessonTypes } from '../lesson-types/registry.js';
import { ProgramsRepository, resourceDto } from './programs.repository.js';
import { ProgramsService } from './programs.service.js';

type NodeTable = 'program_phases' | 'program_modules' | 'lessons';
const PARENT: Record<NodeTable, 'program_id' | 'phase_id' | 'module_id'> = {
  program_phases: 'program_id',
  program_modules: 'phase_id',
  lessons: 'module_id',
};

type ProgramRow = Selectable<ProgramsTable>;
type PhaseRow = Selectable<ProgramPhasesTable>;
type ModuleRow = Selectable<ProgramModulesTable>;
type LessonRow = Selectable<LessonsTable>;

type CreateLessonInput = z.output<typeof learning.createLessonRequestSchema>;
type UpdateLessonInput = z.output<typeof learning.updateLessonRequestSchema>;
type ResourceInput = z.output<typeof learning.lessonResourceRequestSchema>;
type ResourcePatch = z.output<typeof learning.updateLessonResourceRequestSchema>;

interface NodeInput {
  title?: string;
  summary?: string | null;
  unlockRule?: Rule | null;
}

/**
 * Editing the working copy of a program: phases, modules, lessons and lesson resources.
 * Every change marks the node (and the program) as having unpublished changes; learners see
 * nothing until "Publish changes".
 */
@Injectable()
export class StructureService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly repo: ProgramsRepository,
    private readonly programs: ProgramsService,
    private readonly events: EventBus,
    private readonly trees: TreeService,
  ) {}

  // ---------------------------------------------------------------- helpers

  private async editableProgram(trx: Trx, p: Principal, programId: string): Promise<ProgramRow> {
    const program = await trx
      .selectFrom('programs')
      .selectAll()
      .where('id', '=', programId)
      .where('organization_id', '=', p.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!program) throw new NotFoundError('Program');
    if (program.status === 'archived') throw new PreconditionError('PROGRAM_ARCHIVED', 'Restore the program before editing it.');
    return program;
  }

  /** Record a working-copy change on the program. */
  private async touch(trx: Trx, programId: string, actorId: string): Promise<void> {
    await trx
      .updateTable('programs')
      .set((eb) => ({ revision: eb('revision', '+', 1), updated_by: actorId }))
      .where('id', '=', programId)
      .execute();
  }

  private async phaseOf(trx: Trx, p: Principal, programId: string, phaseId: string): Promise<PhaseRow> {
    const phase = await trx.selectFrom('program_phases').selectAll().where('id', '=', phaseId).where('program_id', '=', programId).executeTakeFirst();
    if (!phase) throw new NotFoundError('Phase');
    return phase;
  }

  private async moduleOf(trx: Trx, programId: string, moduleId: string): Promise<ModuleRow> {
    const module = await trx.selectFrom('program_modules').selectAll().where('id', '=', moduleId).where('program_id', '=', programId).executeTakeFirst();
    if (!module) throw new NotFoundError('Module');
    return module;
  }

  /** Lesson plus its (locked) program, scoped to the caller's organization. */
  private async lessonForEdit(trx: Trx, p: Principal, lessonId: string): Promise<{ lesson: LessonRow; program: ProgramRow }> {
    const found = await trx
      .selectFrom('lessons')
      .select('program_id')
      .where('id', '=', lessonId)
      .where('organization_id', '=', p.organizationId)
      .executeTakeFirst();
    if (!found) throw new NotFoundError('Lesson');
    const program = await this.editableProgram(trx, p, found.program_id);
    const lesson = await trx.selectFrom('lessons').selectAll().where('id', '=', lessonId).forUpdate().executeTakeFirstOrThrow();
    return { lesson, program };
  }

  /** Unlock rules may only point at live nodes of the same program and never at the node itself. */
  private async validateRule(trx: Trx, p: Principal, programId: string, rule: Rule | null | undefined, selfId?: string): Promise<void> {
    if (!rule) return;
    const refs = ruleReferences([rule]);
    const errors: string[] = [];
    if (selfId && [...refs.lessonIds, ...refs.moduleIds, ...refs.phaseIds].includes(selfId)) {
      errors.push('An unlock rule cannot depend on the item itself.');
    }
    const check = async (table: NodeTable, ids: string[], noun: string) => {
      const unique = [...new Set(ids)];
      if (!unique.length) return;
      const rows = await trx
        .selectFrom(table)
        .select('id')
        .where('id', 'in', unique)
        .where('program_id', '=', programId)
        .where('status', '!=', 'archived')
        .execute();
      if (rows.length !== unique.length) errors.push(`The rule refers to a ${noun} that is not part of this program (or is archived).`);
    };
    await check('lessons', refs.lessonIds, 'lesson');
    await check('program_modules', refs.moduleIds, 'module');
    await check('program_phases', refs.phaseIds, 'phase');
    const programs = [...new Set(refs.programIds)];
    if (programs.length) {
      const rows = await trx.selectFrom('programs').select('id').where('id', 'in', programs).where('organization_id', '=', p.organizationId).execute();
      if (rows.length !== programs.length) errors.push('The rule refers to a program that does not exist.');
    }
    if (errors.length) throw new ValidationError(errors.map((message) => ({ path: 'unlockRule', message })));
  }

  /**
   * Put `nodeId` at a 1-based position among its siblings (append when omitted) and renumber the
   * siblings densely. Pass `nodeId = null` to only renumber.
   */
  private async place(trx: Trx, table: NodeTable, parentId: string, nodeId: string | null, position?: number): Promise<void> {
    const siblings = await sql<{ id: string; position: number }>`
      select id, position from ${sql.table(table)}
      where ${sql.ref(PARENT[table])} = ${parentId}
      order by position, created_at, id
    `.execute(trx);
    const current = new Map(siblings.rows.map((r) => [r.id, r.position]));
    const order = siblings.rows.map((r) => r.id).filter((id) => id !== nodeId);
    if (nodeId) {
      const index = position === undefined ? order.length : Math.min(Math.max(position - 1, 0), order.length);
      order.splice(index, 0, nodeId);
    }
    for (let i = 0; i < order.length; i++) {
      const id = order[i]!;
      if (current.get(id) === i + 1) continue;
      await sql`update ${sql.table(table)} set position = ${i + 1}, unpublished_changes = true where id = ${id}`.execute(trx);
    }
  }

  private async nextPosition(trx: Trx, table: NodeTable, parentId: string): Promise<number> {
    const row = await sql<{ max: number | null }>`
      select max(position) as max from ${sql.table(table)} where ${sql.ref(PARENT[table])} = ${parentId}
    `.execute(trx);
    return Number(row.rows[0]?.max ?? 0) + 1;
  }

  /** Any learner activity on these lessons (progress, notes, approvals, acknowledgments, submissions)? */
  private async hasActivity(trx: Trx, lessonIds: string[]): Promise<boolean> {
    if (lessonIds.length === 0) return false;
    const ids = sql.val(lessonIds);
    const result = await sql<{ active: boolean }>`
      select (
        exists (select 1 from lesson_progress where lesson_id = any(${ids}::uuid[]))
        or exists (select 1 from lesson_notes where lesson_id = any(${ids}::uuid[]))
        or exists (select 1 from approval_requests where lesson_id = any(${ids}::uuid[]))
        or exists (select 1 from acknowledgments where lesson_id = any(${ids}::uuid[]))
        or exists (select 1 from assignment_submissions where lesson_id = any(${ids}::uuid[]))
      ) as active
    `.execute(trx);
    return Boolean(result.rows[0]?.active);
  }

  private nodePatch(input: NodeInput) {
    return {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.summary !== undefined && { summary: input.summary }),
      ...(input.unlockRule !== undefined && { unlock_rule: input.unlockRule }),
    };
  }

  private async audit(trx: Trx, p: Principal, action: string, resourceType: string, resourceId: string, extra: { before?: unknown; after?: unknown; metadata?: Record<string, unknown> } = {}) {
    await this.events.audit(trx, { action, resourceType, resourceId, actorDisplay: p.displayName, ...extra });
  }

  private async done(p: Principal, programId: string): Promise<learning.ProgramDetail> {
    await this.trees.bump(programId);
    return this.programs.get(p, programId);
  }

  // ---------------------------------------------------------------- phases

  async createPhase(p: Principal, programId: string, input: NodeInput & { title: string; position?: number }): Promise<learning.ProgramDetail> {
    await this.db.transaction().execute(async (trx) => {
      await this.editableProgram(trx, p, programId);
      await this.validateRule(trx, p, programId, input.unlockRule);
      const id = uuidv7();
      await trx
        .insertInto('program_phases')
        .values({
          id,
          program_id: programId,
          position: await this.nextPosition(trx, 'program_phases', programId),
          title: input.title,
          summary: input.summary ?? null,
          unlock_rule: input.unlockRule ?? null,
          status: 'draft',
          first_published_at: null,
          archived_at: null,
          created_by: p.userId,
          updated_by: p.userId,
        })
        .execute();
      if (input.position !== undefined) await this.place(trx, 'program_phases', programId, id, input.position);
      await this.touch(trx, programId, p.userId);
      await this.audit(trx, p, 'phase.created', 'program_phase', id, { after: { programId, title: input.title } });
    });
    return this.done(p, programId);
  }

  async updatePhase(p: Principal, programId: string, phaseId: string, input: NodeInput): Promise<learning.ProgramDetail> {
    await this.db.transaction().execute(async (trx) => {
      await this.editableProgram(trx, p, programId);
      const phase = await this.phaseOf(trx, p, programId, phaseId);
      await this.validateRule(trx, p, programId, input.unlockRule, phaseId);
      await trx
        .updateTable('program_phases')
        .set({ ...this.nodePatch(input), unpublished_changes: true, updated_by: p.userId })
        .where('id', '=', phaseId)
        .execute();
      await this.touch(trx, programId, p.userId);
      await this.audit(trx, p, 'phase.updated', 'program_phase', phaseId, {
        before: { title: phase.title, summary: phase.summary, unlockRule: phase.unlock_rule },
        after: input,
      });
    });
    return this.done(p, programId);
  }

  async movePhase(p: Principal, programId: string, phaseId: string, position: number): Promise<learning.ProgramDetail> {
    await this.db.transaction().execute(async (trx) => {
      await this.editableProgram(trx, p, programId);
      const phase = await this.phaseOf(trx, p, programId, phaseId);
      await this.place(trx, 'program_phases', programId, phaseId, position);
      await this.touch(trx, programId, p.userId);
      await this.audit(trx, p, 'phase.moved', 'program_phase', phaseId, { before: { position: phase.position }, after: { position } });
    });
    return this.done(p, programId);
  }

  async setPhaseArchived(p: Principal, programId: string, phaseId: string, archived: boolean): Promise<learning.ProgramDetail> {
    await this.db.transaction().execute(async (trx) => {
      await this.editableProgram(trx, p, programId);
      const phase = await this.phaseOf(trx, p, programId, phaseId);
      await this.archiveNode(trx, 'program_phases', phase, archived, p.userId);
      await this.touch(trx, programId, p.userId);
      await this.audit(trx, p, archived ? 'phase.archived' : 'phase.restored', 'program_phase', phaseId, { before: { status: phase.status } });
    });
    return this.done(p, programId);
  }

  /** Hard delete when the phase and everything in it was never published and has no learner activity; otherwise archive. */
  async deletePhase(p: Principal, programId: string, phaseId: string): Promise<learning.DeleteResult> {
    const outcome = await this.db.transaction().execute(async (trx) => {
      await this.editableProgram(trx, p, programId);
      const phase = await this.phaseOf(trx, p, programId, phaseId);
      const modules = await trx.selectFrom('program_modules').select(['id', 'first_published_at']).where('phase_id', '=', phaseId).execute();
      const lessons = modules.length
        ? await trx
            .selectFrom('lessons')
            .select(['id', 'first_published_at'])
            .where(
              'module_id',
              'in',
              modules.map((m) => m.id),
            )
            .execute()
        : [];
      const neverPublished = !phase.first_published_at && [...modules, ...lessons].every((n) => !n.first_published_at);
      if (neverPublished && !(await this.hasActivity(trx, lessons.map((l) => l.id)))) {
        await trx.deleteFrom('program_phases').where('id', '=', phaseId).execute();
        await this.place(trx, 'program_phases', programId, null);
        await this.touch(trx, programId, p.userId);
        await this.audit(trx, p, 'phase.deleted', 'program_phase', phaseId, { before: { title: phase.title, modules: modules.length, lessons: lessons.length } });
        return 'deleted' as const;
      }
      await this.archiveNode(trx, 'program_phases', phase, true, p.userId);
      await this.touch(trx, programId, p.userId);
      await this.audit(trx, p, 'phase.archived', 'program_phase', phaseId, { before: { status: phase.status }, metadata: { requestedDelete: true } });
      return 'archived' as const;
    });
    await this.trees.bump(programId);
    return deleteResult(outcome, 'week or phase');
  }

  // ---------------------------------------------------------------- modules

  async createModule(p: Principal, programId: string, input: NodeInput & { phaseId: string; title: string; position?: number }): Promise<learning.ProgramDetail> {
    await this.db.transaction().execute(async (trx) => {
      await this.editableProgram(trx, p, programId);
      await this.phaseOf(trx, p, programId, input.phaseId);
      await this.validateRule(trx, p, programId, input.unlockRule);
      const id = uuidv7();
      await trx
        .insertInto('program_modules')
        .values({
          id,
          program_id: programId,
          phase_id: input.phaseId,
          position: await this.nextPosition(trx, 'program_modules', input.phaseId),
          title: input.title,
          summary: input.summary ?? null,
          unlock_rule: input.unlockRule ?? null,
          status: 'draft',
          first_published_at: null,
          archived_at: null,
          created_by: p.userId,
          updated_by: p.userId,
        })
        .execute();
      if (input.position !== undefined) await this.place(trx, 'program_modules', input.phaseId, id, input.position);
      await this.touch(trx, programId, p.userId);
      await this.audit(trx, p, 'module.created', 'program_module', id, { after: { programId, phaseId: input.phaseId, title: input.title } });
    });
    return this.done(p, programId);
  }

  async updateModule(p: Principal, programId: string, moduleId: string, input: NodeInput): Promise<learning.ProgramDetail> {
    await this.db.transaction().execute(async (trx) => {
      await this.editableProgram(trx, p, programId);
      const module = await this.moduleOf(trx, programId, moduleId);
      await this.validateRule(trx, p, programId, input.unlockRule, moduleId);
      await trx
        .updateTable('program_modules')
        .set({ ...this.nodePatch(input), unpublished_changes: true, updated_by: p.userId })
        .where('id', '=', moduleId)
        .execute();
      await this.touch(trx, programId, p.userId);
      await this.audit(trx, p, 'module.updated', 'program_module', moduleId, {
        before: { title: module.title, summary: module.summary, unlockRule: module.unlock_rule },
        after: input,
      });
    });
    return this.done(p, programId);
  }

  async moveModule(p: Principal, programId: string, moduleId: string, input: { phaseId?: string; position: number }): Promise<learning.ProgramDetail> {
    await this.db.transaction().execute(async (trx) => {
      await this.editableProgram(trx, p, programId);
      const module = await this.moduleOf(trx, programId, moduleId);
      const target = input.phaseId ?? module.phase_id;
      if (target !== module.phase_id) {
        await this.phaseOf(trx, p, programId, target);
        await trx.updateTable('program_modules').set({ phase_id: target, unpublished_changes: true, updated_by: p.userId }).where('id', '=', moduleId).execute();
        await this.place(trx, 'program_modules', module.phase_id, null);
      }
      await this.place(trx, 'program_modules', target, moduleId, input.position);
      await this.touch(trx, programId, p.userId);
      await this.audit(trx, p, 'module.moved', 'program_module', moduleId, {
        before: { phaseId: module.phase_id, position: module.position },
        after: { phaseId: target, position: input.position },
      });
    });
    return this.done(p, programId);
  }

  async setModuleArchived(p: Principal, programId: string, moduleId: string, archived: boolean): Promise<learning.ProgramDetail> {
    await this.db.transaction().execute(async (trx) => {
      await this.editableProgram(trx, p, programId);
      const module = await this.moduleOf(trx, programId, moduleId);
      await this.archiveNode(trx, 'program_modules', module, archived, p.userId);
      await this.touch(trx, programId, p.userId);
      await this.audit(trx, p, archived ? 'module.archived' : 'module.restored', 'program_module', moduleId, { before: { status: module.status } });
    });
    return this.done(p, programId);
  }

  async deleteModule(p: Principal, programId: string, moduleId: string): Promise<learning.DeleteResult> {
    const outcome = await this.db.transaction().execute(async (trx) => {
      await this.editableProgram(trx, p, programId);
      const module = await this.moduleOf(trx, programId, moduleId);
      const lessons = await trx.selectFrom('lessons').select(['id', 'first_published_at']).where('module_id', '=', moduleId).execute();
      const neverPublished = !module.first_published_at && lessons.every((l) => !l.first_published_at);
      if (neverPublished && !(await this.hasActivity(trx, lessons.map((l) => l.id)))) {
        await trx.deleteFrom('program_modules').where('id', '=', moduleId).execute();
        await this.place(trx, 'program_modules', module.phase_id, null);
        await this.touch(trx, programId, p.userId);
        await this.audit(trx, p, 'module.deleted', 'program_module', moduleId, { before: { title: module.title, lessons: lessons.length } });
        return 'deleted' as const;
      }
      await this.archiveNode(trx, 'program_modules', module, true, p.userId);
      await this.touch(trx, programId, p.userId);
      await this.audit(trx, p, 'module.archived', 'program_module', moduleId, { before: { status: module.status }, metadata: { requestedDelete: true } });
      return 'archived' as const;
    });
    await this.trees.bump(programId);
    return deleteResult(outcome, 'module');
  }

  private async archiveNode(
    trx: Trx,
    table: NodeTable,
    node: { id: string; status: learning.NodeStatus; first_published_at: Date | null },
    archived: boolean,
    actorId: string,
  ): Promise<void> {
    if (archived && node.status === 'archived') return;
    if (!archived && node.status !== 'archived') throw new PreconditionError('NOT_ARCHIVED', 'This item is not archived.');
    const status = archived ? 'archived' : node.first_published_at ? 'published' : 'draft';
    await sql`
      update ${sql.table(table)}
      set status = ${status}, archived_at = ${archived ? new Date() : null}, unpublished_changes = true, updated_by = ${actorId}
      where id = ${node.id}
    `.execute(trx);
  }

  // ---------------------------------------------------------------- lessons

  async lesson(p: Principal, lessonId: string): Promise<learning.AdminLesson> {
    const lesson = await this.repo.lessonDetail(this.db, p.organizationId, lessonId);
    if (!lesson) throw new NotFoundError('Lesson');
    return lesson;
  }

  async createLesson(p: Principal, input: CreateLessonInput): Promise<learning.AdminLesson> {
    const module = await this.db
      .selectFrom('program_modules as m')
      .innerJoin('programs as pr', 'pr.id', 'm.program_id')
      .select(['m.id', 'm.program_id'])
      .where('m.id', '=', input.moduleId)
      .where('pr.organization_id', '=', p.organizationId)
      .executeTakeFirst();
    if (!module) throw new NotFoundError('Module');
    const config = lessonTypes.parseConfig(input.type, input.config);
    const id = uuidv7();
    await this.db.transaction().execute(async (trx) => {
      await this.editableProgram(trx, p, module.program_id);
      await this.validateRule(trx, p, module.program_id, input.unlockRule);
      await trx
        .insertInto('lessons')
        .values({
          id,
          organization_id: p.organizationId,
          program_id: module.program_id,
          module_id: module.id,
          position: await this.nextPosition(trx, 'lessons', module.id),
          type: input.type,
          title: input.title,
          summary: input.summary ?? null,
          body: input.body ?? null,
          config,
          is_required: input.isRequired,
          estimated_minutes: input.estimatedMinutes,
          unlock_rule: input.unlockRule ?? null,
          status: 'draft',
          first_published_at: null,
          archived_at: null,
          created_by: p.userId,
          updated_by: p.userId,
        })
        .execute();
      if (input.position !== undefined) await this.place(trx, 'lessons', module.id, id, input.position);
      await this.touch(trx, module.program_id, p.userId);
      await this.audit(trx, p, 'lesson.created', 'lesson', id, { after: { programId: module.program_id, moduleId: module.id, type: input.type, title: input.title } });
    });
    await this.trees.bump(module.program_id);
    return this.lesson(p, id);
  }

  async updateLesson(p: Principal, lessonId: string, input: UpdateLessonInput): Promise<learning.AdminLesson> {
    const programId = await this.db.transaction().execute(async (trx) => {
      const { lesson, program } = await this.lessonForEdit(trx, p, lessonId);
      const config = input.config !== undefined ? lessonTypes.parseConfig(lesson.type, input.config) : undefined;
      await this.validateRule(trx, p, program.id, input.unlockRule, lessonId);
      await trx
        .updateTable('lessons')
        .set({
          ...(input.title !== undefined && { title: input.title }),
          ...(input.summary !== undefined && { summary: input.summary }),
          ...(input.body !== undefined && { body: input.body }),
          ...(config !== undefined && { config }),
          ...(input.isRequired !== undefined && { is_required: input.isRequired }),
          ...(input.estimatedMinutes !== undefined && { estimated_minutes: input.estimatedMinutes }),
          ...(input.unlockRule !== undefined && { unlock_rule: input.unlockRule }),
          unpublished_changes: true,
          updated_by: p.userId,
        })
        .where('id', '=', lessonId)
        .execute();
      await this.touch(trx, program.id, p.userId);
      await this.audit(trx, p, 'lesson.updated', 'lesson', lessonId, {
        before: {
          title: lesson.title,
          isRequired: lesson.is_required,
          estimatedMinutes: lesson.estimated_minutes,
          config: lesson.config,
          unlockRule: lesson.unlock_rule,
        },
        after: { ...input, ...(input.body !== undefined && { body: `(${input.body?.length ?? 0} characters)` }) },
      });
      return program.id;
    });
    await this.trees.bump(programId);
    return this.lesson(p, lessonId);
  }

  async moveLesson(p: Principal, lessonId: string, input: { moduleId?: string; position: number }): Promise<learning.ProgramDetail> {
    const programId = await this.db.transaction().execute(async (trx) => {
      const { lesson, program } = await this.lessonForEdit(trx, p, lessonId);
      const target = input.moduleId ?? lesson.module_id;
      if (target !== lesson.module_id) {
        await this.moduleOf(trx, program.id, target);
        await trx.updateTable('lessons').set({ module_id: target, unpublished_changes: true, updated_by: p.userId }).where('id', '=', lessonId).execute();
        await this.place(trx, 'lessons', lesson.module_id, null);
      }
      await this.place(trx, 'lessons', target, lessonId, input.position);
      await this.touch(trx, program.id, p.userId);
      await this.audit(trx, p, 'lesson.moved', 'lesson', lessonId, {
        before: { moduleId: lesson.module_id, position: lesson.position },
        after: { moduleId: target, position: input.position },
      });
      return program.id;
    });
    return this.done(p, programId);
  }

  async setLessonArchived(p: Principal, lessonId: string, archived: boolean): Promise<learning.AdminLesson> {
    const programId = await this.db.transaction().execute(async (trx) => {
      const { lesson, program } = await this.lessonForEdit(trx, p, lessonId);
      await this.archiveNode(trx, 'lessons', lesson, archived, p.userId);
      await this.touch(trx, program.id, p.userId);
      await this.audit(trx, p, archived ? 'lesson.archived' : 'lesson.restored', 'lesson', lessonId, { before: { status: lesson.status } });
      return program.id;
    });
    await this.trees.bump(programId);
    return this.lesson(p, lessonId);
  }

  async deleteLesson(p: Principal, lessonId: string): Promise<learning.DeleteResult> {
    const { outcome, programId } = await this.db.transaction().execute(async (trx) => {
      const { lesson, program } = await this.lessonForEdit(trx, p, lessonId);
      if (!lesson.first_published_at && !(await this.hasActivity(trx, [lessonId]))) {
        await trx.deleteFrom('lessons').where('id', '=', lessonId).execute();
        await this.place(trx, 'lessons', lesson.module_id, null);
        await this.touch(trx, program.id, p.userId);
        await this.audit(trx, p, 'lesson.deleted', 'lesson', lessonId, { before: { title: lesson.title, type: lesson.type } });
        return { outcome: 'deleted' as const, programId: program.id };
      }
      await this.archiveNode(trx, 'lessons', lesson, true, p.userId);
      await this.touch(trx, program.id, p.userId);
      await this.audit(trx, p, 'lesson.archived', 'lesson', lessonId, { before: { status: lesson.status }, metadata: { requestedDelete: true } });
      return { outcome: 'archived' as const, programId: program.id };
    });
    await this.trees.bump(programId);
    return deleteResult(outcome, 'lesson');
  }

  async duplicateLesson(p: Principal, lessonId: string): Promise<learning.AdminLesson> {
    const id = uuidv7();
    const programId = await this.db.transaction().execute(async (trx) => {
      const { lesson, program } = await this.lessonForEdit(trx, p, lessonId);
      await trx
        .insertInto('lessons')
        .values({
          id,
          organization_id: lesson.organization_id,
          program_id: lesson.program_id,
          module_id: lesson.module_id,
          position: await this.nextPosition(trx, 'lessons', lesson.module_id),
          type: lesson.type,
          title: `${lesson.title} (copy)`.slice(0, 200),
          summary: lesson.summary,
          body: lesson.body,
          config: lesson.config,
          is_required: lesson.is_required,
          estimated_minutes: lesson.estimated_minutes,
          unlock_rule: lesson.unlock_rule,
          status: 'draft',
          first_published_at: null,
          archived_at: null,
          created_by: p.userId,
          updated_by: p.userId,
        })
        .execute();
      const resources = await trx.selectFrom('lesson_resources').selectAll().where('lesson_id', '=', lessonId).execute();
      if (resources.length) {
        await trx
          .insertInto('lesson_resources')
          .values(
            resources.map((r) => ({
              id: uuidv7(),
              lesson_id: id,
              position: r.position,
              title: r.title,
              description: r.description,
              kind: r.kind,
              url: r.url,
              media_asset_id: r.media_asset_id,
              created_by: p.userId,
            })),
          )
          .execute();
      }
      await this.place(trx, 'lessons', lesson.module_id, id, lesson.position + 1);
      await this.touch(trx, program.id, p.userId);
      await this.audit(trx, p, 'lesson.duplicated', 'lesson', id, { metadata: { sourceLessonId: lessonId } });
      return program.id;
    });
    await this.trees.bump(programId);
    return this.lesson(p, id);
  }

  // ---------------------------------------------------------------- lesson resources

  async resources(p: Principal, lessonId: string): Promise<learning.LessonResource[]> {
    const lesson = await this.db.selectFrom('lessons').select('id').where('id', '=', lessonId).where('organization_id', '=', p.organizationId).executeTakeFirst();
    if (!lesson) throw new NotFoundError('Lesson');
    const rows = await this.db.selectFrom('lesson_resources').selectAll().where('lesson_id', '=', lessonId).orderBy('position').orderBy('id').execute();
    return rows.map(resourceDto);
  }

  private async resourcesChanged(trx: Trx, lessonId: string, programId: string, actorId: string) {
    await trx.updateTable('lessons').set({ unpublished_changes: true, updated_by: actorId }).where('id', '=', lessonId).execute();
    await this.touch(trx, programId, actorId);
  }

  async addResource(p: Principal, lessonId: string, input: ResourceInput): Promise<learning.LessonResource[]> {
    const programId = await this.db.transaction().execute(async (trx) => {
      const { program } = await this.lessonForEdit(trx, p, lessonId);
      const count = await trx.selectFrom('lesson_resources').select((eb) => eb.fn.countAll<number>().as('n')).where('lesson_id', '=', lessonId).executeTakeFirstOrThrow();
      if (Number(count.n) >= 50) throw new PreconditionError('TOO_MANY_RESOURCES', 'A lesson can have at most 50 resources.');
      const id = uuidv7();
      const existing = await trx.selectFrom('lesson_resources').select(['id', 'position']).where('lesson_id', '=', lessonId).orderBy('position').orderBy('id').execute();
      const order = existing.map((r) => r.id);
      order.splice(input.position === undefined ? order.length : Math.min(Math.max(input.position - 1, 0), order.length), 0, id);
      await trx
        .insertInto('lesson_resources')
        .values({
          id,
          lesson_id: lessonId,
          position: order.indexOf(id) + 1,
          title: input.title,
          description: input.description ?? null,
          kind: input.kind,
          url: input.kind === 'link' ? (input.url ?? null) : null,
          media_asset_id: input.kind === 'media' ? (input.mediaAssetId ?? null) : null,
          created_by: p.userId,
        })
        .execute();
      for (const [i, rid] of order.entries()) {
        if (rid !== id) await trx.updateTable('lesson_resources').set({ position: i + 1 }).where('id', '=', rid).execute();
      }
      await this.resourcesChanged(trx, lessonId, program.id, p.userId);
      await this.audit(trx, p, 'lesson_resource.created', 'lesson', lessonId, { after: { resourceId: id, title: input.title, kind: input.kind } });
      return program.id;
    });
    await this.trees.bump(programId);
    return this.resources(p, lessonId);
  }

  async updateResource(p: Principal, lessonId: string, resourceId: string, input: ResourcePatch): Promise<learning.LessonResource[]> {
    const programId = await this.db.transaction().execute(async (trx) => {
      const { program } = await this.lessonForEdit(trx, p, lessonId);
      const resource = await trx.selectFrom('lesson_resources').selectAll().where('id', '=', resourceId).where('lesson_id', '=', lessonId).executeTakeFirst();
      if (!resource) throw new NotFoundError('Resource');
      if (resource.kind === 'link' && input.url === null) throw new ValidationError([{ path: 'url', message: 'Links need an address' }]);
      if (resource.kind === 'media' && input.mediaAssetId === null) throw new ValidationError([{ path: 'mediaAssetId', message: 'Choose a file' }]);
      await trx
        .updateTable('lesson_resources')
        .set({
          ...(input.title !== undefined && { title: input.title }),
          ...(input.description !== undefined && { description: input.description }),
          ...(resource.kind === 'link' && input.url !== undefined && { url: input.url }),
          ...(resource.kind === 'media' && input.mediaAssetId !== undefined && { media_asset_id: input.mediaAssetId }),
        })
        .where('id', '=', resourceId)
        .execute();
      if (input.position !== undefined) {
        const rows = await trx.selectFrom('lesson_resources').select('id').where('lesson_id', '=', lessonId).orderBy('position').orderBy('id').execute();
        const order = rows.map((r) => r.id).filter((id) => id !== resourceId);
        order.splice(Math.min(Math.max(input.position - 1, 0), order.length), 0, resourceId);
        for (const [i, rid] of order.entries()) await trx.updateTable('lesson_resources').set({ position: i + 1 }).where('id', '=', rid).execute();
      }
      await this.resourcesChanged(trx, lessonId, program.id, p.userId);
      await this.audit(trx, p, 'lesson_resource.updated', 'lesson', lessonId, { before: { resourceId, title: resource.title }, after: input });
      return program.id;
    });
    await this.trees.bump(programId);
    return this.resources(p, lessonId);
  }

  async deleteResource(p: Principal, lessonId: string, resourceId: string): Promise<learning.LessonResource[]> {
    const programId = await this.db.transaction().execute(async (trx) => {
      const { program } = await this.lessonForEdit(trx, p, lessonId);
      const resource = await trx.selectFrom('lesson_resources').selectAll().where('id', '=', resourceId).where('lesson_id', '=', lessonId).executeTakeFirst();
      if (!resource) throw new NotFoundError('Resource');
      await trx.deleteFrom('lesson_resources').where('id', '=', resourceId).execute();
      const rows = await trx.selectFrom('lesson_resources').select('id').where('lesson_id', '=', lessonId).orderBy('position').orderBy('id').execute();
      for (const [i, r] of rows.entries()) await trx.updateTable('lesson_resources').set({ position: i + 1 }).where('id', '=', r.id).execute();
      await this.resourcesChanged(trx, lessonId, program.id, p.userId);
      await this.audit(trx, p, 'lesson_resource.deleted', 'lesson', lessonId, { before: { resourceId, title: resource.title } });
      return program.id;
    });
    await this.trees.bump(programId);
    return this.resources(p, lessonId);
  }
}

function deleteResult(outcome: 'deleted' | 'archived', noun: string): learning.DeleteResult {
  return outcome === 'deleted'
    ? { outcome, message: `The ${noun} was deleted.` }
    : {
        outcome,
        message: `The ${noun} was published before or has learner activity, so it was archived instead of deleted. Learners stop seeing it when you publish changes.`,
      };
}
