import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { Principal } from '@a5/auth';
import { learning } from '@a5/contracts';
import { isUniqueViolation, sql, type Page } from '@a5/database';
import { learningEvents } from '@a5/events';
import {
  ConflictError,
  EventBus,
  InjectDb,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import { slugify } from '../common/text.js';
import type { Db, DbOrTrx } from '../database/index.js';
import { FactsService } from '../engine/facts.service.js';
import { evaluateProgram, toOutline } from '../engine/progression.js';
import { remapRule } from '../engine/tree.js';
import { TreeService } from '../engine/tree.service.js';
import { iso } from '../engine/dto.js';
import { ProgramsRepository, type ProgramListFilters } from './programs.repository.js';

type CreateProgramInput = z.output<typeof learning.createProgramRequestSchema>;
type UpdateProgramInput = z.output<typeof learning.updateProgramRequestSchema>;

const NOBODY = '00000000-0000-0000-0000-000000000000';
const ROLE_KEY = /^[a-z][a-z0-9_]{1,63}$/;

/** Program-level administration: catalogue, settings, audiences, prerequisites, archive, versions. */
@Injectable()
export class ProgramsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly repo: ProgramsRepository,
    private readonly events: EventBus,
    private readonly trees: TreeService,
    private readonly facts: FactsService,
  ) {}

  list(p: Principal, filters: ProgramListFilters): Promise<Page<learning.ProgramSummary>> {
    return this.repo.list(p.organizationId, filters);
  }

  async get(p: Principal, id: string, db: DbOrTrx = this.db): Promise<learning.ProgramDetail> {
    const detail = await this.repo.detail(db, p.organizationId, id);
    if (!detail) throw new NotFoundError('Program');
    return detail;
  }

  private async uniqueSlug(db: DbOrTrx, organizationId: string, base: string): Promise<string> {
    const rows = await db
      .selectFrom('programs')
      .select('slug')
      .where('organization_id', '=', organizationId)
      .where(sql`lower(slug)`, 'like', `${base.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      .execute();
    const taken = new Set(rows.map((r) => r.slug.toLowerCase()));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base.slice(0, 76)}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private async assertOwner(db: DbOrTrx, organizationId: string, ownerUserId: string | null | undefined): Promise<void> {
    if (!ownerUserId) return;
    const owner = await db
      .selectFrom('dir_users')
      .select('id')
      .where('id', '=', ownerUserId)
      .where('organization_id', '=', organizationId)
      .executeTakeFirst();
    if (!owner) throw new ValidationError([{ path: 'ownerUserId', message: 'Choose someone from your organization.' }]);
  }

  async create(p: Principal, input: CreateProgramInput): Promise<learning.ProgramDetail> {
    await this.assertOwner(this.db, p.organizationId, input.ownerUserId);
    const id = uuidv7();
    try {
      await this.db.transaction().execute(async (trx) => {
        const slug = input.slug ?? (await this.uniqueSlug(trx, p.organizationId, slugify(input.title)));
        await trx
          .insertInto('programs')
          .values({
            id,
            organization_id: p.organizationId,
            slug,
            title: input.title,
            summary: input.summary ?? null,
            description: input.description ?? null,
            cover_media_asset_id: input.coverMediaAssetId ?? null,
            category: input.category ?? null,
            owner_user_id: input.ownerUserId ?? p.userId,
            status: 'draft',
            phase_label: input.phaseLabel,
            settings: learning.programSettingsSchema.parse(input.settings ?? {}),
            estimated_minutes: input.estimatedMinutes ?? null,
            duration_days: input.durationDays ?? null,
            availability_starts_at: input.availabilityStartsAt ? new Date(input.availabilityStartsAt) : null,
            availability_ends_at: input.availabilityEndsAt ? new Date(input.availabilityEndsAt) : null,
            tags: input.tags,
            published_revision: null,
            published_at: null,
            archived_at: null,
            created_by: p.userId,
            updated_by: p.userId,
          })
          .execute();
        await this.events.audit(trx, {
          action: 'program.created',
          resourceType: 'program',
          resourceId: id,
          actorDisplay: p.displayName,
          after: { title: input.title, slug },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'programs_org_slug_uq')) {
        throw new ConflictError('SLUG_TAKEN', 'Another program already uses this URL name. Choose a different one.');
      }
      throw err;
    }
    return this.get(p, id);
  }

  async update(p: Principal, id: string, input: UpdateProgramInput): Promise<learning.ProgramDetail> {
    const current = await this.repo.find(this.db, p.organizationId, id);
    if (!current) throw new NotFoundError('Program');
    if (current.status === 'archived') throw new PreconditionError('PROGRAM_ARCHIVED', 'Restore the program before editing it.');
    await this.assertOwner(this.db, p.organizationId, input.ownerUserId);

    const startsAt = input.availabilityStartsAt !== undefined ? input.availabilityStartsAt : iso(current.availability_starts_at);
    const endsAt = input.availabilityEndsAt !== undefined ? input.availabilityEndsAt : iso(current.availability_ends_at);
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
      throw new ValidationError([{ path: 'availabilityEndsAt', message: 'End must be after the start' }]);
    }
    const settings = input.settings ? learning.programSettingsSchema.parse({ ...current.settings, ...input.settings }) : undefined;
    // Fields that are part of the published snapshot; changing them needs "Publish changes".
    const learnerFacing =
      (input.title !== undefined && input.title !== current.title) ||
      (input.summary !== undefined && input.summary !== current.summary) ||
      (input.description !== undefined && input.description !== current.description) ||
      (input.category !== undefined && input.category !== current.category) ||
      (input.coverMediaAssetId !== undefined && input.coverMediaAssetId !== current.cover_media_asset_id) ||
      (input.phaseLabel !== undefined && input.phaseLabel !== current.phase_label) ||
      (input.estimatedMinutes !== undefined && input.estimatedMinutes !== current.estimated_minutes) ||
      (settings !== undefined && JSON.stringify(settings) !== JSON.stringify(learning.programSettingsSchema.parse(current.settings ?? {})));

    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('programs')
          .set((eb) => ({
            ...(input.title !== undefined && { title: input.title }),
            ...(input.slug !== undefined && { slug: input.slug }),
            ...(input.summary !== undefined && { summary: input.summary }),
            ...(input.description !== undefined && { description: input.description }),
            ...(input.category !== undefined && { category: input.category }),
            ...(input.coverMediaAssetId !== undefined && { cover_media_asset_id: input.coverMediaAssetId }),
            ...(input.ownerUserId !== undefined && { owner_user_id: input.ownerUserId }),
            ...(input.phaseLabel !== undefined && { phase_label: input.phaseLabel }),
            ...(input.estimatedMinutes !== undefined && { estimated_minutes: input.estimatedMinutes }),
            ...(input.durationDays !== undefined && { duration_days: input.durationDays }),
            ...(input.availabilityStartsAt !== undefined && { availability_starts_at: startsAt ? new Date(startsAt) : null }),
            ...(input.availabilityEndsAt !== undefined && { availability_ends_at: endsAt ? new Date(endsAt) : null }),
            ...(input.tags !== undefined && { tags: input.tags }),
            ...(settings !== undefined && { settings }),
            ...(learnerFacing && { revision: eb('revision', '+', 1) }),
            updated_by: p.userId,
          }))
          .where('id', '=', id)
          .execute();
        await this.events.audit(trx, {
          action: 'program.updated',
          resourceType: 'program',
          resourceId: id,
          actorDisplay: p.displayName,
          before: { title: current.title, slug: current.slug, settings: current.settings },
          after: input,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'programs_org_slug_uq')) {
        throw new ConflictError('SLUG_TAKEN', 'Another program already uses this URL name. Choose a different one.');
      }
      throw err;
    }
    await this.trees.bump(id);
    return this.get(p, id);
  }

  /** Deep copy of the working copy (without archived nodes) as a new draft program. */
  async duplicate(p: Principal, id: string, input: { title?: string; slug?: string }): Promise<learning.ProgramDetail> {
    const source = await this.repo.find(this.db, p.organizationId, id);
    if (!source) throw new NotFoundError('Program');
    const newId = uuidv7();
    try {
      await this.db.transaction().execute(async (trx) => {
        const [phases, modules, lessons, audiences, prerequisites] = await Promise.all([
          trx.selectFrom('program_phases').selectAll().where('program_id', '=', id).where('status', '!=', 'archived').execute(),
          trx.selectFrom('program_modules').selectAll().where('program_id', '=', id).where('status', '!=', 'archived').execute(),
          trx.selectFrom('lessons').selectAll().where('program_id', '=', id).where('status', '!=', 'archived').execute(),
          trx.selectFrom('program_audiences').selectAll().where('program_id', '=', id).execute(),
          trx.selectFrom('program_prerequisites').selectAll().where('program_id', '=', id).execute(),
        ]);
        const livePhases = phases;
        const liveModules = modules.filter((m) => livePhases.some((ph) => ph.id === m.phase_id));
        const liveLessons = lessons.filter((l) => liveModules.some((m) => m.id === l.module_id));
        const ids = new Map<string, string>([[id, newId]]);
        for (const row of [...livePhases, ...liveModules, ...liveLessons]) ids.set(row.id, uuidv7());

        const title = input.title ?? `${source.title} (copy)`;
        const slug = input.slug ?? (await this.uniqueSlug(trx, p.organizationId, slugify(`${source.slug}-copy`)));
        await trx
          .insertInto('programs')
          .values({
            id: newId,
            organization_id: p.organizationId,
            slug,
            title,
            summary: source.summary,
            description: source.description,
            cover_media_asset_id: source.cover_media_asset_id,
            category: source.category,
            owner_user_id: p.userId,
            status: 'draft',
            phase_label: source.phase_label,
            settings: source.settings,
            estimated_minutes: source.estimated_minutes,
            duration_days: source.duration_days,
            availability_starts_at: source.availability_starts_at,
            availability_ends_at: source.availability_ends_at,
            tags: source.tags,
            published_revision: null,
            published_at: null,
            archived_at: null,
            created_by: p.userId,
            updated_by: p.userId,
          })
          .execute();
        if (audiences.length) {
          await trx
            .insertInto('program_audiences')
            .values(audiences.map((a) => ({ program_id: newId, kind: a.kind, ref: a.ref })))
            .execute();
        }
        if (prerequisites.length) {
          await trx
            .insertInto('program_prerequisites')
            .values(prerequisites.map((r) => ({ program_id: newId, required_program_id: r.required_program_id })))
            .execute();
        }
        const draft = { status: 'draft' as const, first_published_at: null, archived_at: null, created_by: p.userId, updated_by: p.userId };
        if (livePhases.length) {
          await trx
            .insertInto('program_phases')
            .values(
              livePhases.map((ph) => ({
                id: ids.get(ph.id)!,
                program_id: newId,
                position: ph.position,
                title: ph.title,
                summary: ph.summary,
                unlock_rule: remapRule(ph.unlock_rule, ids),
                ...draft,
              })),
            )
            .execute();
        }
        if (liveModules.length) {
          await trx
            .insertInto('program_modules')
            .values(
              liveModules.map((m) => ({
                id: ids.get(m.id)!,
                program_id: newId,
                phase_id: ids.get(m.phase_id)!,
                position: m.position,
                title: m.title,
                summary: m.summary,
                unlock_rule: remapRule(m.unlock_rule, ids),
                ...draft,
              })),
            )
            .execute();
        }
        if (liveLessons.length) {
          await trx
            .insertInto('lessons')
            .values(
              liveLessons.map((l) => ({
                id: ids.get(l.id)!,
                organization_id: p.organizationId,
                program_id: newId,
                module_id: ids.get(l.module_id)!,
                position: l.position,
                type: l.type,
                title: l.title,
                summary: l.summary,
                body: l.body,
                config: l.config,
                is_required: l.is_required,
                estimated_minutes: l.estimated_minutes,
                unlock_rule: remapRule(l.unlock_rule, ids),
                ...draft,
              })),
            )
            .execute();
          const resources = await trx
            .selectFrom('lesson_resources')
            .selectAll()
            .where(
              'lesson_id',
              'in',
              liveLessons.map((l) => l.id),
            )
            .execute();
          if (resources.length) {
            await trx
              .insertInto('lesson_resources')
              .values(
                resources.map((r) => ({
                  id: uuidv7(),
                  lesson_id: ids.get(r.lesson_id)!,
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
        }
        await this.events.audit(trx, {
          action: 'program.duplicated',
          resourceType: 'program',
          resourceId: newId,
          actorDisplay: p.displayName,
          after: { title, slug },
          metadata: { sourceProgramId: id, phases: livePhases.length, modules: liveModules.length, lessons: liveLessons.length },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'programs_org_slug_uq')) {
        throw new ConflictError('SLUG_TAKEN', 'Another program already uses this URL name. Choose a different one.');
      }
      throw err;
    }
    return this.get(p, newId);
  }

  async archive(p: Principal, id: string): Promise<learning.ProgramDetail> {
    const program = await this.repo.find(this.db, p.organizationId, id);
    if (!program) throw new NotFoundError('Program');
    if (program.status === 'archived') return this.get(p, id);
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('programs').set({ status: 'archived', archived_at: new Date(), updated_by: p.userId }).where('id', '=', id).execute();
      await this.events.emit(trx, learningEvents.programArchived, { programId: id }, { organizationId: p.organizationId, subject: { type: 'program', id } });
      await this.events.audit(trx, {
        action: 'program.archived',
        resourceType: 'program',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { status: program.status },
        after: { status: 'archived' },
      });
    });
    await this.trees.bump(id);
    return this.get(p, id);
  }

  async restore(p: Principal, id: string): Promise<learning.ProgramDetail> {
    const program = await this.repo.find(this.db, p.organizationId, id);
    if (!program) throw new NotFoundError('Program');
    if (program.status !== 'archived') throw new PreconditionError('NOT_ARCHIVED', 'This program is not archived.');
    const status = program.published_version > 0 ? 'published' : 'draft';
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('programs').set({ status, archived_at: null, updated_by: p.userId }).where('id', '=', id).execute();
      await this.events.audit(trx, {
        action: 'program.restored',
        resourceType: 'program',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { status: 'archived' },
        after: { status },
      });
    });
    await this.trees.bump(id);
    return this.get(p, id);
  }

  async setAudiences(p: Principal, id: string, audiences: learning.Audience[]): Promise<learning.ProgramDetail> {
    const program = await this.repo.find(this.db, p.organizationId, id);
    if (!program) throw new NotFoundError('Program');
    const unique = [...new Map(audiences.map((a) => [`${a.kind}:${a.ref}`, a])).values()];
    const errors: Array<{ path: string; message: string }> = [];
    const teamIds = unique.filter((a) => a.kind === 'team').map((a) => a.ref);
    const unitIds = unique.filter((a) => a.kind === 'department' || a.kind === 'location').map((a) => a.ref);
    const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    const [teams, units] = await Promise.all([
      teamIds.filter(isUuid).length
        ? this.db.selectFrom('dir_teams').select('id').where('id', 'in', teamIds.filter(isUuid)).where('organization_id', '=', p.organizationId).execute()
        : Promise.resolve([]),
      unitIds.filter(isUuid).length
        ? this.db.selectFrom('dir_units').select(['id', 'kind']).where('id', 'in', unitIds.filter(isUuid)).where('organization_id', '=', p.organizationId).execute()
        : Promise.resolve([]),
    ]);
    unique.forEach((a, i) => {
      const path = `audiences.${i}.ref`;
      if (a.kind === 'role' && !ROLE_KEY.test(a.ref)) errors.push({ path, message: 'Use a role key such as sales_rep.' });
      if (a.kind === 'team' && !teams.some((t) => t.id === a.ref)) errors.push({ path, message: 'Choose a team from your organization.' });
      if ((a.kind === 'department' || a.kind === 'location') && !units.some((u) => u.id === a.ref && u.kind === a.kind)) {
        errors.push({ path, message: `Choose a ${a.kind} from your organization.` });
      }
    });
    if (errors.length) throw new ValidationError(errors);
    const before = await this.db.selectFrom('program_audiences').select(['kind', 'ref']).where('program_id', '=', id).execute();
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('program_audiences').where('program_id', '=', id).execute();
      if (unique.length) await trx.insertInto('program_audiences').values(unique.map((a) => ({ program_id: id, kind: a.kind, ref: a.ref }))).execute();
      await this.events.audit(trx, {
        action: 'program.audiences_changed',
        resourceType: 'program',
        resourceId: id,
        actorDisplay: p.displayName,
        before,
        after: unique,
      });
    });
    return this.get(p, id);
  }

  async setPrerequisites(p: Principal, id: string, programIds: string[]): Promise<learning.ProgramDetail> {
    const program = await this.repo.find(this.db, p.organizationId, id);
    if (!program) throw new NotFoundError('Program');
    const unique = [...new Set(programIds)];
    if (unique.includes(id)) throw new ValidationError([{ path: 'programIds', message: 'A program cannot require itself.' }]);
    if (unique.length) {
      const found = await this.db.selectFrom('programs').select('id').where('id', 'in', unique).where('organization_id', '=', p.organizationId).execute();
      if (found.length !== unique.length) throw new ValidationError([{ path: 'programIds', message: 'Choose programs from your organization.' }]);
      // Reject cycles: none of the new prerequisites may (transitively) require this program.
      const edges = await this.db
        .selectFrom('program_prerequisites as pp')
        .innerJoin('programs as p', 'p.id', 'pp.program_id')
        .select(['pp.program_id', 'pp.required_program_id'])
        .where('p.organization_id', '=', p.organizationId)
        .execute();
      const requires = new Map<string, string[]>();
      for (const e of edges) requires.set(e.program_id, [...(requires.get(e.program_id) ?? []), e.required_program_id]);
      const seen = new Set<string>();
      const stack = [...unique];
      while (stack.length) {
        const current = stack.pop()!;
        if (current === id) throw new ValidationError([{ path: 'programIds', message: 'These prerequisites would create a loop between programs.' }]);
        if (seen.has(current)) continue;
        seen.add(current);
        stack.push(...(requires.get(current) ?? []));
      }
    }
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('program_prerequisites').where('program_id', '=', id).execute();
      if (unique.length) {
        await trx.insertInto('program_prerequisites').values(unique.map((r) => ({ program_id: id, required_program_id: r }))).execute();
      }
      await this.events.audit(trx, {
        action: 'program.prerequisites_changed',
        resourceType: 'program',
        resourceId: id,
        actorDisplay: p.displayName,
        after: { programIds: unique },
      });
    });
    return this.get(p, id);
  }

  /** Outline as a brand-new trainee would see it (no progress). */
  async preview(p: Principal, id: string, source: 'draft' | 'published'): Promise<learning.Outline> {
    const program = await this.repo.find(this.db, p.organizationId, id);
    if (!program) throw new NotFoundError('Program');
    const tree = source === 'published' ? await this.trees.published(id) : await this.trees.working(id);
    if (!tree) throw new PreconditionError('NOT_PUBLISHED', 'This program has not been published yet. Preview the draft instead.');
    const facts = await this.facts.load(this.db, tree, { userId: NOBODY, enrollment: null });
    return toOutline(tree, evaluateProgram(tree, facts), null);
  }

  async versions(p: Principal, id: string): Promise<learning.ProgramVersion[]> {
    const program = await this.repo.find(this.db, p.organizationId, id);
    if (!program) throw new NotFoundError('Program');
    const rows = await this.db
      .selectFrom('program_versions')
      .select(['version', 'change_note', 'published_at', 'published_by', 'published_by_name', 'stats'])
      .where('program_id', '=', id)
      .orderBy('version', 'desc')
      .execute();
    return rows.map((r) => ({
      version: r.version,
      changeNote: r.change_note,
      publishedAt: r.published_at.toISOString(),
      publishedBy: r.published_by ? { id: r.published_by, displayName: r.published_by_name ?? 'Unknown' } : null,
      stats: r.stats,
    }));
  }

  async version(p: Principal, id: string, version: number) {
    const program = await this.repo.find(this.db, p.organizationId, id);
    if (!program) throw new NotFoundError('Program');
    const r = await this.db.selectFrom('program_versions').selectAll().where('program_id', '=', id).where('version', '=', version).executeTakeFirst();
    if (!r) throw new NotFoundError('Program version');
    return {
      version: r.version,
      changeNote: r.change_note,
      publishedAt: r.published_at.toISOString(),
      publishedBy: r.published_by ? { id: r.published_by, displayName: r.published_by_name ?? 'Unknown' } : null,
      stats: r.stats,
      snapshot: r.snapshot,
    };
  }
}
