import { Injectable } from '@nestjs/common';
import type { learning } from '@a5/contracts';
import { likePattern, paginate, sql, type Page, type Selectable } from '@a5/database';
import { InjectDb } from '@a5/nest-kit';
import { DEFAULT_ROLES } from '@a5/permissions';
import type {
  Db,
  DbOrTrx,
  LessonResourcesTable,
  LessonsTable,
  ProgramModulesTable,
  ProgramPhasesTable,
  ProgramsTable,
} from '../database/index.js';
import { iso } from '../engine/dto.js';
import { assembleTree, parseSettings } from '../engine/tree.js';
import { lessonTypes } from '../lesson-types/registry.js';
import { publishIssues } from './publish-validation.js';

type ProgramRow = Selectable<ProgramsTable>;
type LessonRow = Selectable<LessonsTable>;
type ResourceRow = Selectable<LessonResourcesTable>;

const SORTS = {
  title: sql`lower(p.title)`,
  updatedAt: sql`p.updated_at`,
  createdAt: sql`p.created_at`,
  status: sql`p.status`,
} as const;

export interface ProgramListFilters {
  q?: string;
  status?: learning.ProgramStatus[];
  category?: string;
  sort?: string;
  page: number;
  pageSize: number;
}

const byPosition = <T extends { position: number; created_at: Date; id: string }>(a: T, b: T) =>
  a.position - b.position || a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id);

export function resourceDto(r: ResourceRow): learning.LessonResource {
  return {
    id: r.id,
    position: r.position,
    title: r.title,
    description: r.description,
    kind: r.kind,
    url: r.url,
    mediaAssetId: r.media_asset_id,
  };
}

/** Read models for the program builder (working copy, all statuses). */
@Injectable()
export class ProgramsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  async find(db: DbOrTrx, organizationId: string, id: string): Promise<ProgramRow | undefined> {
    return db.selectFrom('programs').selectAll().where('id', '=', id).where('organization_id', '=', organizationId).executeTakeFirst();
  }

  private async counts(db: DbOrTrx, ids: string[]) {
    const map = new Map<string, learning.ProgramSummary['counts']>();
    for (const id of ids) map.set(id, { phases: 0, lessons: 0, activeEnrollments: 0, completedEnrollments: 0 });
    if (ids.length === 0) return map;
    const [phases, lessons, enrollments] = await Promise.all([
      db
        .selectFrom('program_phases')
        .select(['program_id', (eb) => eb.fn.countAll<number>().as('n')])
        .where('program_id', 'in', ids)
        .where('status', '!=', 'archived')
        .groupBy('program_id')
        .execute(),
      db
        .selectFrom('lessons')
        .select(['program_id', (eb) => eb.fn.countAll<number>().as('n')])
        .where('program_id', 'in', ids)
        .where('status', '!=', 'archived')
        .groupBy('program_id')
        .execute(),
      db
        .selectFrom('enrollments')
        .select([
          'program_id',
          (eb) => eb.fn.countAll<number>().filterWhere('status', '=', 'active').as('active'),
          (eb) => eb.fn.countAll<number>().filterWhere('status', '=', 'completed').as('completed'),
        ])
        .where('program_id', 'in', ids)
        .groupBy('program_id')
        .execute(),
    ]);
    for (const r of phases) map.get(r.program_id)!.phases = Number(r.n);
    for (const r of lessons) map.get(r.program_id)!.lessons = Number(r.n);
    for (const r of enrollments) {
      map.get(r.program_id)!.activeEnrollments = Number(r.active);
      map.get(r.program_id)!.completedEnrollments = Number(r.completed);
    }
    return map;
  }

  private async people(db: DbOrTrx, ids: Array<string | null>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((i): i is string => Boolean(i)))];
    if (unique.length === 0) return new Map();
    const rows = await db.selectFrom('dir_users').select(['id', 'display_name']).where('id', 'in', unique).execute();
    return new Map(rows.map((r) => [r.id, r.display_name]));
  }

  private summary(row: ProgramRow, counts: learning.ProgramSummary['counts'], owners: Map<string, string>): learning.ProgramSummary {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      category: row.category,
      status: row.status,
      coverMediaAssetId: row.cover_media_asset_id,
      phaseLabel: row.phase_label,
      tags: row.tags,
      owner: row.owner_user_id ? { id: row.owner_user_id, displayName: owners.get(row.owner_user_id) ?? 'Former employee' } : null,
      publishedVersion: row.published_version,
      publishedAt: iso(row.published_at),
      hasUnpublishedChanges: row.status !== 'archived' && Number(row.revision) !== Number(row.published_revision ?? -1),
      archivedAt: iso(row.archived_at),
      counts,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async list(organizationId: string, f: ProgramListFilters): Promise<Page<learning.ProgramSummary>> {
    let query = this.db.selectFrom('programs as p').selectAll('p').where('p.organization_id', '=', organizationId);
    if (f.q) {
      const pattern = likePattern(f.q);
      query = query.where((eb) =>
        eb.or([eb('p.title', 'ilike', pattern), eb('p.summary', 'ilike', pattern), eb('p.slug', 'ilike', pattern), eb('p.category', 'ilike', pattern)]),
      );
    }
    if (f.status?.length) query = query.where('p.status', 'in', f.status);
    if (f.category) query = query.where(sql`lower(p.category)`, '=', f.category.toLowerCase());
    const desc = f.sort?.startsWith('-') ?? false;
    const key = (f.sort?.replace(/^-/, '') ?? 'title') as keyof typeof SORTS;
    query = query.orderBy(SORTS[key] ?? SORTS.title, desc ? 'desc' : 'asc').orderBy('p.id');
    const page = await paginate(query, { page: f.page, pageSize: f.pageSize });
    const ids = page.items.map((r) => r.id);
    const [counts, owners] = await Promise.all([this.counts(this.db, ids), this.people(this.db, page.items.map((r) => r.owner_user_id))]);
    return { ...page, items: page.items.map((r) => this.summary(r, counts.get(r.id)!, owners)) };
  }

  async summaryOf(db: DbOrTrx, row: ProgramRow): Promise<learning.ProgramSummary> {
    const [counts, owners] = await Promise.all([this.counts(db, [row.id]), this.people(db, [row.owner_user_id])]);
    return this.summary(row, counts.get(row.id)!, owners);
  }

  /** Full builder view: settings, audiences, prerequisites, every node with its status and activity. */
  async detail(db: DbOrTrx, organizationId: string, id: string): Promise<learning.ProgramDetail | null> {
    const program = await this.find(db, organizationId, id);
    if (!program) return null;
    const [phases, modules, lessons, audiences, prerequisites] = await Promise.all([
      db.selectFrom('program_phases').selectAll().where('program_id', '=', id).execute(),
      db.selectFrom('program_modules').selectAll().where('program_id', '=', id).execute(),
      db.selectFrom('lessons').selectAll().where('program_id', '=', id).execute(),
      db.selectFrom('program_audiences').selectAll().where('program_id', '=', id).orderBy('kind').orderBy('ref').execute(),
      db
        .selectFrom('program_prerequisites as pp')
        .innerJoin('programs as p', 'p.id', 'pp.required_program_id')
        .select(['p.id', 'p.title'])
        .where('pp.program_id', '=', id)
        .orderBy('p.title')
        .execute(),
    ]);
    const lessonIds = lessons.map((l) => l.id);
    const [resources, activity] = await Promise.all([
      lessonIds.length ? db.selectFrom('lesson_resources').selectAll().where('lesson_id', 'in', lessonIds).execute() : Promise.resolve([]),
      lessonIds.length
        ? db
            .selectFrom('lesson_progress')
            .select([
              'lesson_id',
              (eb) => eb.fn.countAll<number>().as('started'),
              (eb) => eb.fn.countAll<number>().filterWhere('status', '=', 'completed').as('completed'),
            ])
            .where('lesson_id', 'in', lessonIds)
            .groupBy('lesson_id')
            .execute()
        : Promise.resolve([]),
    ]);
    const activityBy = new Map(activity.map((a) => [a.lesson_id, { learnersStarted: Number(a.started), learnersCompleted: Number(a.completed) }]));
    const resourcesBy = new Map<string, ResourceRow[]>();
    for (const r of resources) resourcesBy.set(r.lesson_id, [...(resourcesBy.get(r.lesson_id) ?? []), r]);

    const summary = await this.summaryOf(db, program);
    const tree = assembleTree(program, { phases, modules, lessons, resources }, 0);
    const label = (index: number) => `${program.phase_label} ${index + 1}`;

    let liveIndex = 0;
    const adminPhases: learning.AdminPhase[] = [...phases].sort(byPosition).map((phase: Selectable<ProgramPhasesTable>) => {
      const phaseLabelText = phase.status === 'archived' ? `${program.phase_label} (archived)` : label(liveIndex++);
      return {
        id: phase.id,
        position: phase.position,
        label: phaseLabelText,
        title: phase.title,
        summary: phase.summary,
        unlockRule: phase.unlock_rule,
        status: phase.status,
        hasUnpublishedChanges: phase.unpublished_changes,
        modules: modules
          .filter((m) => m.phase_id === phase.id)
          .sort(byPosition)
          .map((module: Selectable<ProgramModulesTable>) => ({
            id: module.id,
            phaseId: phase.id,
            position: module.position,
            title: module.title,
            summary: module.summary,
            unlockRule: module.unlock_rule,
            status: module.status,
            hasUnpublishedChanges: module.unpublished_changes,
            lessons: lessons
              .filter((l) => l.module_id === module.id)
              .sort(byPosition)
              .map((lesson) => this.adminLesson(lesson, phase.id, resourcesBy.get(lesson.id) ?? [], activityBy.get(lesson.id))),
          })),
      };
    });

    const audienceNames = await this.audienceNames(db, audiences);
    return {
      ...summary,
      description: program.description,
      settings: parseSettings(program.settings),
      estimatedMinutes: program.estimated_minutes,
      computedMinutes: lessons.filter((l) => l.status !== 'archived').reduce((n, l) => n + l.estimated_minutes, 0),
      durationDays: program.duration_days,
      availabilityStartsAt: iso(program.availability_starts_at),
      availabilityEndsAt: iso(program.availability_ends_at),
      audiences: audiences.map((a) => ({ kind: a.kind, ref: a.ref, name: audienceNames.get(`${a.kind}:${a.ref}`) ?? a.ref })),
      prerequisites,
      phases: adminPhases,
      publishIssues: program.status === 'archived' ? [] : publishIssues(tree),
    };
  }

  adminLesson(
    lesson: LessonRow,
    phaseId: string,
    resources: ResourceRow[],
    activity: { learnersStarted: number; learnersCompleted: number } | undefined,
  ): learning.AdminLesson {
    return {
      id: lesson.id,
      programId: lesson.program_id,
      phaseId,
      moduleId: lesson.module_id,
      position: lesson.position,
      type: lesson.type,
      title: lesson.title,
      summary: lesson.summary,
      body: lesson.body,
      config: lessonTypes.has(lesson.type) ? lessonTypes.readConfig(lesson.type, lesson.config) : lesson.config,
      isRequired: lesson.is_required,
      estimatedMinutes: lesson.estimated_minutes,
      unlockRule: lesson.unlock_rule,
      status: lesson.status,
      hasUnpublishedChanges: lesson.unpublished_changes,
      firstPublishedAt: iso(lesson.first_published_at),
      completionMode: lessonTypes.has(lesson.type) ? lessonTypes.get(lesson.type).completion : 'manual',
      resources: [...resources].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map(resourceDto),
      activity: activity ?? { learnersStarted: 0, learnersCompleted: 0 },
      updatedAt: lesson.updated_at.toISOString(),
    };
  }

  async lessonDetail(db: DbOrTrx, organizationId: string, lessonId: string): Promise<learning.AdminLesson | null> {
    const lesson = await db
      .selectFrom('lessons as l')
      .innerJoin('program_modules as m', 'm.id', 'l.module_id')
      .selectAll('l')
      .select('m.phase_id')
      .where('l.id', '=', lessonId)
      .where('l.organization_id', '=', organizationId)
      .executeTakeFirst();
    if (!lesson) return null;
    const [resources, activity] = await Promise.all([
      db.selectFrom('lesson_resources').selectAll().where('lesson_id', '=', lessonId).execute(),
      db
        .selectFrom('lesson_progress')
        .select([(eb) => eb.fn.countAll<number>().as('started'), (eb) => eb.fn.countAll<number>().filterWhere('status', '=', 'completed').as('completed')])
        .where('lesson_id', '=', lessonId)
        .executeTakeFirst(),
    ]);
    const { phase_id, ...row } = lesson;
    return this.adminLesson(row, phase_id, resources, {
      learnersStarted: Number(activity?.started ?? 0),
      learnersCompleted: Number(activity?.completed ?? 0),
    });
  }

  private async audienceNames(db: DbOrTrx, audiences: Array<{ kind: learning.AudienceKind; ref: string }>): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const teams = audiences.filter((a) => a.kind === 'team').map((a) => a.ref);
    const units = audiences.filter((a) => a.kind === 'department' || a.kind === 'location').map((a) => a.ref);
    const [teamRows, unitRows] = await Promise.all([
      teams.length ? db.selectFrom('dir_teams').select(['id', 'name']).where('id', 'in', teams).execute() : Promise.resolve([]),
      units.length ? db.selectFrom('dir_units').select(['id', 'name', 'kind']).where('id', 'in', units).execute() : Promise.resolve([]),
    ]);
    for (const t of teamRows) names.set(`team:${t.id}`, t.name);
    for (const u of unitRows) names.set(`${u.kind}:${u.id}`, u.name);
    for (const a of audiences.filter((x) => x.kind === 'role')) {
      names.set(`role:${a.ref}`, DEFAULT_ROLES.find((r) => r.key === a.ref)?.name ?? a.ref);
    }
    return names;
  }
}
