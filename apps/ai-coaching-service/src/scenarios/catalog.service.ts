import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { ai } from '@a5/contracts';
import { likePattern, paginate, sql } from '@a5/database';
import { InjectDb, NotFoundError } from '@a5/nest-kit';
import { isoOrNull } from '../common/people.js';
import type { Db, Difficulty } from '../database/index.js';

/**
 * What learners see of published scenarios: the situation they walk into, never the hidden
 * concern, the homeowner instructions or rubric internals.
 */
@Injectable()
export class CatalogService {
  constructor(@InjectDb() private readonly db: Db) {}

  private query(p: Principal) {
    return this.db
      .selectFrom('ai_scenarios as s')
      .innerJoin('ai_personas as pe', 'pe.id', 's.persona_id')
      .leftJoin(
        (eb) =>
          eb
            .selectFrom('ai_sessions as x')
            .leftJoin('ai_evaluations as e', 'e.session_id', 'x.id')
            .select([
              'x.scenario_id',
              sql<number>`count(*)::int`.as('attempts'),
              sql<number | null>`max(e.overall_score)`.as('best_score'),
              sql<Date | null>`max(x.started_at)`.as('last_practiced_at'),
            ])
            .where('x.user_id', '=', p.userId)
            .where('x.is_test', '=', false)
            .groupBy('x.scenario_id')
            .as('st'),
        (join) => join.onRef('st.scenario_id', '=', 's.id'),
      )
      .select([
        's.id',
        's.title',
        's.category',
        's.difficulty',
        's.objection',
        's.rep_brief',
        's.passing_score',
        's.max_turns',
        's.current_prompt_version_id',
        'pe.name as persona_name',
        'pe.description as persona_description',
        'st.attempts',
        'st.best_score',
        'st.last_practiced_at',
      ])
      .where('s.organization_id', '=', p.organizationId)
      .where('s.status', '=', 'published');
  }

  private stats(r: { attempts: number | null; best_score: number | null; last_practiced_at: Date | null; passing_score: number }): ai.PracticeScenarioBrief['myStats'] {
    const best = r.best_score === null ? null : Number(r.best_score);
    return {
      attempts: Number(r.attempts ?? 0),
      bestScore: best,
      passed: best !== null && best >= r.passing_score,
      lastPracticedAt: isoOrNull(r.last_practiced_at),
    };
  }

  async list(p: Principal, q: { q?: string; category?: string; difficulty?: Difficulty; page: number; pageSize: number }) {
    let query = this.query(p);
    if (q.category) query = query.where('s.category', '=', q.category);
    if (q.difficulty) query = query.where('s.difficulty', '=', q.difficulty);
    if (q.q) {
      const pattern = likePattern(q.q);
      query = query.where((eb) => eb.or([eb('s.title', 'ilike', pattern), eb('s.objection', 'ilike', pattern), eb('s.category', 'ilike', pattern)]));
    }
    const order = sql`case s.difficulty when 'beginner' then 1 when 'intermediate' then 2 when 'advanced' then 3 else 4 end`;
    const page = await paginate(query.orderBy(order).orderBy('s.title'), q);
    return {
      ...page,
      items: page.items.map((r) => ({
        id: r.id,
        title: r.title,
        category: r.category,
        difficulty: r.difficulty,
        objection: r.objection,
        persona: { name: r.persona_name },
        passingScore: r.passing_score,
        maxTurns: r.max_turns,
        myStats: this.stats(r),
      })),
    };
  }

  async brief(p: Principal, id: string): Promise<ai.PracticeScenarioBrief> {
    const r = await this.query(p).where('s.id', '=', id).executeTakeFirst();
    if (!r || !r.current_prompt_version_id) throw new NotFoundError('Scenario');
    const rubric = await this.db
      .selectFrom('ai_prompt_versions as pv')
      .innerJoin('ai_rubric_versions as rv', 'rv.id', 'pv.rubric_version_id')
      .select('rv.categories')
      .where('pv.id', '=', r.current_prompt_version_id)
      .executeTakeFirstOrThrow();
    return {
      id: r.id,
      title: r.title,
      category: r.category,
      difficulty: r.difficulty,
      objection: r.objection,
      repBrief: r.rep_brief,
      persona: { name: r.persona_name, description: r.persona_description },
      passingScore: r.passing_score,
      maxTurns: r.max_turns,
      myStats: this.stats(r),
      scoredOn: rubric.categories.filter((c) => c.weight > 0).map((c) => ({ key: c.key, label: c.label })),
    };
  }
}
