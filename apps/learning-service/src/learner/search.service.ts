import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { learning } from '@a5/contracts';
import { likePattern, sql } from '@a5/database';
import { InjectDb } from '@a5/nest-kit';
import type { Db } from '../database/index.js';
import { orderedLessons } from '../engine/tree.js';
import { TreeService } from '../engine/tree.service.js';

/**
 * Search across programs and lessons. Program builders search the whole working copy of their
 * organization; learners search the published content of programs they are enrolled in.
 */
@Injectable()
export class SearchService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly trees: TreeService,
  ) {}

  async search(p: Principal, q: string, limit: number): Promise<learning.SearchResult> {
    return p.can('programs.view') ? this.admin(p, q, limit) : this.learner(p, q, limit);
  }

  private async admin(p: Principal, q: string, limit: number): Promise<learning.SearchResult> {
    const pattern = likePattern(q);
    const [programs, lessons] = await Promise.all([
      this.db
        .selectFrom('programs')
        .select(['id', 'title', 'summary', 'status'])
        .where('organization_id', '=', p.organizationId)
        .where((eb) => eb.or([eb('title', 'ilike', pattern), eb('summary', 'ilike', pattern), eb('category', 'ilike', pattern)]))
        .orderBy(sql`case when status = 'archived' then 1 else 0 end`)
        .orderBy(sql`lower(title)`)
        .limit(limit)
        .execute(),
      this.db
        .selectFrom('lessons as l')
        .innerJoin('programs as pr', 'pr.id', 'l.program_id')
        .innerJoin('program_modules as m', 'm.id', 'l.module_id')
        .innerJoin('program_phases as ph', 'ph.id', 'm.phase_id')
        .select(['l.id', 'l.title', 'l.type', 'l.status', 'l.program_id', 'pr.title as program_title', 'ph.title as phase_title'])
        .where('l.organization_id', '=', p.organizationId)
        .where((eb) => eb.or([eb('l.title', 'ilike', pattern), eb('l.summary', 'ilike', pattern)]))
        .orderBy(sql`case when l.status = 'archived' then 1 else 0 end`)
        .orderBy(sql`lower(l.title)`)
        .limit(limit)
        .execute(),
    ]);
    return {
      programs,
      lessons: lessons.map((l) => ({
        id: l.id,
        title: l.title,
        type: l.type,
        programId: l.program_id,
        programTitle: l.program_title,
        phaseTitle: l.phase_title,
        status: l.status,
      })),
    };
  }

  private async learner(p: Principal, q: string, limit: number): Promise<learning.SearchResult> {
    const needle = q.toLocaleLowerCase('en-US');
    const matches = (...texts: Array<string | null>) => texts.some((t) => t?.toLocaleLowerCase('en-US').includes(needle));
    const enrolled = await this.db
      .selectFrom('enrollments as e')
      .innerJoin('programs as pr', 'pr.id', 'e.program_id')
      .select('e.program_id')
      .where('e.user_id', '=', p.userId)
      .where('e.organization_id', '=', p.organizationId)
      .where('e.status', 'in', ['active', 'completed'])
      .where('pr.status', '=', 'published')
      .execute();
    const result: learning.SearchResult = { programs: [], lessons: [] };
    for (const { program_id } of enrolled) {
      const tree = await this.trees.published(program_id);
      if (!tree) continue;
      if (matches(tree.title, tree.summary)) result.programs.push({ id: tree.programId, title: tree.title, summary: tree.summary, status: 'published' });
      for (const { lesson, phase } of orderedLessons(tree)) {
        if (matches(lesson.title, lesson.summary)) {
          result.lessons.push({
            id: lesson.id,
            title: lesson.title,
            type: lesson.type,
            programId: tree.programId,
            programTitle: tree.title,
            phaseTitle: phase.title,
            status: 'published',
          });
        }
      }
    }
    return { programs: result.programs.slice(0, limit), lessons: result.lessons.slice(0, limit) };
  }
}
