import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { learning } from '@a5/contracts';
import { likePattern, paginate, sql, type Page, type Selectable, type SqlBool } from '@a5/database';
import { InjectDb, NotFoundError } from '@a5/nest-kit';
import { learnerRefs } from '../common/people.js';
import { ScopeService } from '../common/scope.service.js';
import { plural } from '../common/text.js';
import type { Db, EnrollmentsTable } from '../database/index.js';
import { iso, isOverdue } from '../engine/dto.js';
import { phaseRef, type ProgramTree } from '../engine/tree.js';
import { TreeService } from '../engine/tree.service.js';

export interface TeamProgressFilters {
  q?: string;
  programId?: string;
  teamId?: string;
  status?: learning.EnrollmentStatus[];
  attention?: boolean;
  sort?: string;
  page: number;
  pageSize: number;
}

const SORTS = {
  name: sql`u.display_name`,
  progress: sql`e.progress_percent`,
  lastActivity: sql`e.last_activity_at`,
  dueAt: sql`e.due_at`,
} as const;

const DAY = 86_400_000;

type Row = Selectable<EnrollmentsTable> & {
  program_title: string;
  inactivity_days: number;
  flag_overdue: boolean;
  flag_inactive: boolean;
  flag_not_started: boolean;
  flag_failing: boolean;
  flag_approval: boolean;
};

/**
 * Manager and trainer views of learner progress. Data comes from the denormalised enrollment
 * columns plus the score projections, so a page of rows costs a fixed number of queries.
 */
@Injectable()
export class TeamProgressService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly trees: TreeService,
  ) {}

  /** Team must exist in the caller's organization and be inside their scope; 404 otherwise. */
  async assertTeamVisible(p: Principal, teamId: string): Promise<void> {
    const team = await this.db
      .selectFrom('dir_teams')
      .select(['id', 'organization_id'])
      .where('id', '=', teamId)
      .executeTakeFirst();
    if (!team || team.organization_id !== p.organizationId) throw new NotFoundError('Team');
    const filter = p.scopeFilter('enrollments.view');
    if (filter.kind === 'organization' || filter.kind === 'platform') return;
    if (filter.kind === 'managed' && filter.teamIds.includes(teamId)) return;
    throw new NotFoundError('Team');
  }

  private flags(now: Date) {
    const inactivityDays = sql<number>`coalesce((pr.settings->>'inactivityAlertDays')::int, 7)`;
    const cutoff = sql`${now}::timestamptz - (${inactivityDays} * interval '1 day')`;
    const approval = sql<boolean>`exists (select 1 from approval_requests a where a.enrollment_id = e.id and a.status = 'pending')`;
    return {
      inactivityDays,
      overdue: sql<boolean>`(e.status = 'active' and e.due_at is not null and e.due_at < ${now})`,
      // Waiting on a reviewer is not the learner standing still, so a pending approval suppresses it.
      inactive: sql<boolean>`(e.status = 'active' and e.started_at is not null and coalesce(e.last_activity_at, e.started_at) < ${cutoff} and not ${approval})`,
      notStarted: sql<boolean>`(e.status = 'active' and e.started_at is null and e.enrolled_at < ${cutoff})`,
      failing: sql<boolean>`(e.status = 'active' and exists (
        select 1 from learner_assessment_scores s
        join lessons l on l.program_id = e.program_id and l.status = 'published'
          and l.type in ('quiz', 'final_assessment') and l.config->>'assessmentId' = s.assessment_id::text
        where s.user_id = e.user_id and s.passed = false
      ))`,
      approval,
    };
  }

  /** Enrollments of non-archived programs with their attention flags computed in SQL. */
  private flagged(now: Date) {
    const flags = this.flags(now);
    return this.db
      .selectFrom('enrollments as e')
      .innerJoin('programs as pr', 'pr.id', 'e.program_id')
      .leftJoin('dir_users as u', 'u.id', 'e.user_id')
      .selectAll('e')
      .select([
        'pr.title as program_title',
        flags.inactivityDays.as('inactivity_days'),
        flags.overdue.as('flag_overdue'),
        flags.inactive.as('flag_inactive'),
        flags.notStarted.as('flag_not_started'),
        flags.failing.as('flag_failing'),
        flags.approval.as('flag_approval'),
      ])
      .where('pr.status', '!=', 'archived');
  }

  async list(p: Principal, f: TeamProgressFilters): Promise<Page<learning.TeamProgressRow>> {
    if (f.teamId) await this.assertTeamVisible(p, f.teamId);
    const now = new Date();
    const flags = this.flags(now);
    let query = this.flagged(now)
      .where(
        this.scope.condition(p, 'enrollments.view', {
          userColumn: 'e.user_id',
          orgColumn: 'e.organization_id',
        }),
      )
      .where('e.status', 'in', f.status?.length ? f.status : ['active', 'completed']);
    if (f.programId) query = query.where('e.program_id', '=', f.programId);
    if (f.teamId)
      query = query.where(
        'e.user_id',
        'in',
        this.db.selectFrom('dir_user_teams').select('user_id').where('team_id', '=', f.teamId),
      );
    if (f.q) {
      const pattern = likePattern(f.q);
      query = query.where((eb) =>
        eb.or([eb('u.display_name', 'ilike', pattern), eb('u.email', 'ilike', pattern)]),
      );
    }
    if (f.attention) {
      query = query.where(
        sql<SqlBool>`(${flags.overdue} or ${flags.inactive} or ${flags.notStarted} or ${flags.failing} or ${flags.approval})`,
      );
    }
    const desc = f.sort?.startsWith('-') ?? false;
    const key = (f.sort?.replace(/^-/, '') ?? 'name') as keyof typeof SORTS;
    query = query
      .orderBy(SORTS[key] ?? SORTS.name, sql.raw(desc ? 'desc nulls last' : 'asc nulls last'))
      .orderBy('e.id');
    const page = await paginate(query, { page: f.page, pageSize: f.pageSize });
    return { ...page, items: await this.rows(page.items as Row[], now) };
  }

  private async rows(rows: Row[], now: Date): Promise<learning.TeamProgressRow[]> {
    if (rows.length === 0) return [];
    const learners = await learnerRefs(
      this.db,
      rows.map((r) => r.user_id),
    );
    const trees = new Map<string, ProgramTree | null>();
    for (const id of new Set(rows.map((r) => r.program_id)))
      trees.set(id, await this.trees.published(id));
    const failingUsers = rows.filter((r) => r.flag_failing).map((r) => r.user_id);
    const failing = failingUsers.length
      ? await this.db
          .selectFrom('learner_assessment_scores')
          .select(['user_id', 'assessment_id', 'assessment_title', 'best_score', 'attempts'])
          .where('user_id', 'in', failingUsers)
          .where('passed', '=', false)
          .execute()
      : [];

    return rows.map((r) => {
      const tree = trees.get(r.program_id) ?? null;
      const attention: learning.AttentionFlag[] = [];
      if (r.flag_overdue && r.due_at) {
        const days = Math.max(1, Math.floor((now.getTime() - r.due_at.getTime()) / DAY));
        attention.push({ code: 'overdue', message: `Overdue by ${plural(days, 'day')}` });
      }
      if (r.flag_not_started) {
        attention.push({
          code: 'not_started',
          message: `Has not started since being enrolled ${plural(Math.floor((now.getTime() - r.enrolled_at.getTime()) / DAY), 'day')} ago`,
        });
      }
      if (r.flag_inactive) {
        const last = r.last_activity_at ?? r.started_at!;
        attention.push({
          code: 'inactive',
          message: `No activity in ${plural(Math.floor((now.getTime() - last.getTime()) / DAY), 'day')}`,
        });
      }
      if (r.flag_failing && tree) {
        const programAssessments = new Set(
          tree.phases.flatMap((ph) =>
            ph.modules.flatMap((m) => m.lessons.map((l) => String(l.config.assessmentId ?? ''))),
          ),
        );
        for (const s of failing.filter(
          (x) => x.user_id === r.user_id && programAssessments.has(x.assessment_id),
        )) {
          attention.push({
            code: 'failing_assessment',
            message: `${s.assessment_title}: best score ${Math.round(Number(s.best_score))}% after ${plural(s.attempts, 'attempt')}`,
          });
        }
      }
      if (r.flag_approval)
        attention.push({
          code: 'awaiting_approval',
          message: 'Waiting for a sign-off or assignment review',
        });
      return {
        enrollmentId: r.id,
        learner: learners.get(r.user_id)!,
        program: { id: r.program_id, title: tree?.title ?? r.program_title },
        status: r.status,
        progressPercent: Number(r.progress_percent),
        requiredTotal: r.required_total,
        requiredCompleted: r.required_completed,
        currentPhase: phaseRef(tree, r.current_phase_id),
        enrolledAt: r.enrolled_at.toISOString(),
        lastActivityAt: iso(r.last_activity_at),
        dueAt: iso(r.due_at),
        overdue: isOverdue(r, now),
        attention,
      };
    });
  }

  /** One learner across programs, with assessment and AI practice scores. 404 outside scope. */
  async learner(p: Principal, userId: string): Promise<learning.LearnerProgress> {
    const user = await this.db
      .selectFrom('dir_users')
      .select(['id', 'organization_id'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new NotFoundError('Learner');
    await this.scope.assertAdmits(
      p,
      ['enrollments.view'],
      { userId, organizationId: user.organization_id },
      'Learner',
    );
    const now = new Date();
    const rows = await this.flagged(now)
      .where('e.user_id', '=', userId)
      .where('e.organization_id', '=', p.organizationId)
      .where('e.status', 'in', ['active', 'completed'])
      .orderBy('e.enrolled_at', 'desc')
      .execute();
    const enrollments = await this.rows(rows as Row[], now);
    const [learners, assessments, ai] = await Promise.all([
      learnerRefs(this.db, [userId]),
      this.db
        .selectFrom('learner_assessment_scores')
        .selectAll()
        .where('user_id', '=', userId)
        .orderBy('last_attempt_at', 'desc')
        .execute(),
      this.db
        .selectFrom('learner_ai_scores')
        .selectAll()
        .where('user_id', '=', userId)
        .orderBy('last_session_at', 'desc')
        .execute(),
    ]);
    return {
      learner: learners.get(userId)!,
      enrollments,
      assessments: assessments.map((a) => ({
        id: a.assessment_id,
        title: a.assessment_title,
        kind: a.kind,
        bestScore: Number(a.best_score),
        lastScore: Number(a.last_score),
        passed: a.passed,
        attempts: a.attempts,
        lastAt: a.last_attempt_at.toISOString(),
      })),
      aiScenarios: ai.map((s) => ({
        id: s.scenario_id,
        title: s.scenario_title,
        bestScore: Number(s.best_score),
        lastScore: Number(s.last_score),
        passed: s.passed,
        attempts: s.sessions,
        lastAt: s.last_session_at.toISOString(),
      })),
    };
  }
}
