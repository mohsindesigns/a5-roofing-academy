import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { ai } from '@a5/contracts';
import { paginate, sql, type Page } from '@a5/database';
import { userScopeCondition } from '@a5/directory';
import { aiEvents } from '@a5/events';
import { EventBus, InjectDb, NotFoundError } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import type { PermissionKey } from '@a5/permissions';
import { People, isoOrNull } from '../common/people.js';
import type { Db, SessionStatus } from '../database/index.js';
import { readScenarioSnapshot } from '../prompts/snapshots.js';
import { SessionView } from '../sessions/session-view.js';
import { summaryDto } from '../sessions/sessions.service.js';

export interface ReviewListQuery {
  userId?: string;
  scenarioId?: string;
  teamId?: string;
  status?: SessionStatus;
  minScore?: number;
  maxScore?: number;
  from?: string;
  to?: string;
  reviewed?: boolean;
  includeTests?: boolean;
  q?: string;
  page: number;
  pageSize: number;
}

/**
 * Trainer / manager access to other people's sessions. Every query is limited by the caller's
 * data scope (own, managed teams and trainees, organization); out-of-scope sessions are 404.
 */
@Injectable()
export class ReviewService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly view: SessionView,
    private readonly people: People,
    private readonly events: EventBus,
  ) {}

  private scope(p: Principal, permission: PermissionKey) {
    return userScopeCondition(p.scopeFilter(permission), {
      userColumn: 's.user_id',
      orgColumn: 's.organization_id',
    });
  }

  async list(p: Principal, q: ReviewListQuery): Promise<Page<ai.ReviewSessionSummary>> {
    let query = this.db
      .selectFrom('ai_sessions as s')
      .innerJoin('ai_prompt_versions as pv', 'pv.id', 's.prompt_version_id')
      .leftJoin('ai_evaluations as e', 'e.session_id', 's.id')
      .select([
        's.id',
        's.user_id',
        's.scenario_id',
        's.mode',
        's.is_test',
        's.status',
        's.end_reason',
        's.turn_count',
        's.started_at',
        's.ended_at',
        's.provider',
        's.model',
        'pv.scenario_snapshot',
        'e.overall_score',
        'e.passed',
        sql<number>`(select count(*)::int from ai_session_reviews r where r.session_id = s.id)`.as(
          'review_count',
        ),
        sql<Date | null>`(select max(r.created_at) from ai_session_reviews r where r.session_id = s.id)`.as(
          'last_reviewed_at',
        ),
      ])
      .where('s.organization_id', '=', p.organizationId)
      .where(this.scope(p, 'ai_sessions.view'));
    if (!q.includeTests) query = query.where('s.is_test', '=', false);
    if (q.userId) query = query.where('s.user_id', '=', q.userId);
    if (q.scenarioId) query = query.where('s.scenario_id', '=', q.scenarioId);
    if (q.status) query = query.where('s.status', '=', q.status);
    if (q.teamId)
      query = query.where(
        sql<boolean>`s.user_id in (select user_id from dir_user_teams where team_id = ${q.teamId})`,
      );
    if (q.minScore !== undefined) query = query.where('e.overall_score', '>=', q.minScore);
    if (q.maxScore !== undefined) query = query.where('e.overall_score', '<=', q.maxScore);
    if (q.from) query = query.where('s.started_at', '>=', new Date(`${q.from}T00:00:00Z`));
    if (q.to)
      query = query.where(
        's.started_at',
        '<',
        new Date(Date.parse(`${q.to}T00:00:00Z`) + 86_400_000),
      );
    if (q.reviewed === true)
      query = query.where(
        sql<boolean>`exists (select 1 from ai_session_reviews r where r.session_id = s.id)`,
      );
    if (q.reviewed === false)
      query = query.where(
        sql<boolean>`not exists (select 1 from ai_session_reviews r where r.session_id = s.id)`,
      );
    if (q.q) {
      const pattern = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where(
        sql<boolean>`(s.user_id in (select id from dir_users where display_name ilike ${pattern}) or pv.scenario_snapshot->>'title' ilike ${pattern})`,
      );
    }
    const page = await paginate(query.orderBy('s.started_at', 'desc'), q);
    const learners = await this.people.refs(page.items.map((r) => r.user_id));
    return {
      ...page,
      items: page.items.map((r) => ({
        ...summaryDto(r),
        learner: learners.get(r.user_id) ?? { id: r.user_id, displayName: 'Former team member' },
        reviewCount: Number(r.review_count),
        lastReviewedAt: isoOrNull(r.last_reviewed_at),
      })),
    };
  }

  private async inScope(p: Principal, id: string, permission: PermissionKey) {
    const row = await this.db
      .selectFrom('ai_sessions as s')
      .selectAll('s')
      .where('s.id', '=', id)
      .where('s.organization_id', '=', p.organizationId)
      .where(this.scope(p, permission))
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Practice session');
    return row;
  }

  async detail(p: Principal, id: string): Promise<ai.ReviewSessionDetail> {
    const row = await this.inScope(p, id, 'ai_sessions.view');
    const [session, learner] = await Promise.all([
      this.view.build(row),
      this.people.ref(row.user_id),
    ]);
    return {
      ...session,
      learner: learner ?? { id: row.user_id, displayName: 'Former team member' },
    };
  }

  /** Coaching feedback from a trainer or manager in scope. Emits ai.session.reviewed. */
  async addReview(
    p: Principal,
    id: string,
    input: ai.CreateReviewRequest,
  ): Promise<ai.ReviewSessionDetail> {
    const row = await this.inScope(p, id, 'ai_sessions.review');
    const pv = await this.db
      .selectFrom('ai_prompt_versions')
      .select('scenario_snapshot')
      .where('id', '=', row.prompt_version_id)
      .executeTakeFirstOrThrow();
    const reviewId = uuidv7();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('ai_session_reviews')
        .values({
          id: reviewId,
          session_id: id,
          organization_id: p.organizationId,
          reviewer_id: p.userId,
          comment: input.comment,
          recommendation: input.recommendation,
        })
        .execute();
      await this.events.emit(
        trx,
        aiEvents.sessionReviewed,
        {
          sessionId: id,
          scenarioTitle: readScenarioSnapshot(pv.scenario_snapshot).title,
          userId: row.user_id,
          reviewerId: p.userId,
        },
        { subject: { type: 'ai_session', id }, organizationId: p.organizationId },
      );
      await this.events.audit(
        trx,
        {
          action: 'ai.session.reviewed',
          resourceType: 'ai_session',
          resourceId: id,
          actorDisplay: p.displayName,
          after: { reviewId, recommendation: input.recommendation },
        },
        { organizationId: p.organizationId },
      );
    });
    return this.detail(p, id);
  }
}
