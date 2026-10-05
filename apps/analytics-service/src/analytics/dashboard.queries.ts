import type { analytics } from '@a5/contracts';
import { sql, type SqlBool } from '@a5/database';
import type { RawBuilder } from 'kysely';
import type { Db } from '../database/index.js';
import { iso, isoRequired, ratio, round1, type QuerySql } from './query-context.js';

const DAY_MS = 86_400_000;

export interface KpiRow {
  headcount: number;
  active_trainees: number;
  enrollments: number;
  completed: number;
  avg_progress: number | null;
  avg_score: number | null;
  attempts: number;
  failed_attempts: number;
  ai_avg: number | null;
  ai_sessions: number;
  field_ready: number;
  certified: number;
  due_or_done: number;
  overdue: number;
  avg_completion_days: number | null;
}

type Brief = analytics.PersonBrief;

/**
 * SQL behind the dashboards. Every query filters by organization, applies the caller's data
 * scope through `QuerySql.people` / `QuerySql.population`, and returns bounded result sets
 * (aggregates, top-N lists with totals).
 */
export class DashboardQueries {
  constructor(private readonly db: Db) {}

  private async rows<T>(query: RawBuilder<T>): Promise<T[]> {
    return (await query.execute(this.db)).rows;
  }

  /** Team names per user, for person chips. */
  async teamNames(userIds: string[]): Promise<Map<string, string[]>> {
    const ids = [...new Set(userIds)];
    const map = new Map<string, string[]>();
    if (!ids.length) return map;
    const rows = await this.rows(sql<{ user_id: string; name: string }>`
      select ut.user_id, t.name
      from dir_user_teams ut join dir_teams t on t.id = ut.team_id
      where ut.user_id = any(${sql.val(ids)}::uuid[]) and not t.archived
      order by t.name
    `);
    for (const r of rows) map.set(r.user_id, [...(map.get(r.user_id) ?? []), r.name]);
    return map;
  }

  private brief(id: string, displayName: string | null, teams: Map<string, string[]>): Brief {
    return { id, displayName: displayName ?? 'Unknown learner', teamNames: teams.get(id) ?? [] };
  }

  // ---------------------------------------------------------------- KPIs

  async kpis(q: QuerySql): Promise<KpiRow> {
    const now = sql`${q.now}::timestamptz`;
    const [row] = await this.rows(sql<KpiRow>`
      with pop as (${q.population()}),
      enr as (
        select e.* from fact_enrollments e join pop on pop.user_id = e.user_id
        where e.organization_id = ${q.org} and e.status <> 'withdrawn'
          and ${q.program('e.program_id')} and ${q.range(sql`coalesce(e.enrolled_at, e.first_seen_at)`)}
      ),
      att as (
        select a.* from fact_assessment_attempts a
        where a.organization_id = ${q.org} and a.kind <> 'practice'
          and ${q.people('a.user_id', 'a.organization_id')} and ${q.range('a.graded_at')}
          and ${q.programAssessment('a.program_id', 'a.assessment_id')}
      ),
      ai as (
        select s.* from fact_ai_sessions s
        where s.organization_id = ${q.org} and ${q.people('s.user_id', 's.organization_id')} and ${q.range('s.evaluated_at')}
      ),
      ready as (
        select distinct e.user_id from enr e
        where e.status = 'completed'
          and exists (
            select 1 from fact_assessment_attempts f
            where f.user_id = e.user_id and f.organization_id = ${q.org} and f.kind = 'final' and f.passed
              and ${q.programAssessment('f.program_id', 'f.assessment_id')}
          )
      ),
      cert as (
        select distinct c.user_id from fact_certificates c join pop on pop.user_id = c.user_id
        where c.organization_id = ${q.org} and c.status = 'issued'
          and (c.expires_at is null or c.expires_at > ${now}) and ${q.certification('c.definition_id')}
      )
      select
        (select count(*) from pop) as headcount,
        (select count(distinct user_id) from enr where status = 'active') as active_trainees,
        (select count(*) from enr) as enrollments,
        (select count(*) from enr where status = 'completed') as completed,
        (select avg(progress_percent) from enr) as avg_progress,
        (select avg(score_percent) from att) as avg_score,
        (select count(*) from att) as attempts,
        (select count(*) from att where not passed) as failed_attempts,
        (select avg(overall_score) from ai) as ai_avg,
        (select count(*) from ai) as ai_sessions,
        (select count(*) from ready) as field_ready,
        (select count(*) from cert) as certified,
        (select count(*) from enr where status = 'completed' or (status = 'active' and due_at < ${now})) as due_or_done,
        (select count(*) from enr where status = 'active' and (due_at < ${now} or (due_at is null and overdue))) as overdue,
        (select avg(extract(epoch from completed_at - coalesce(enrolled_at, first_seen_at)) / 86400.0)
           from enr where status = 'completed' and completed_at is not null) as avg_completion_days
    `);
    return row!;
  }

  static teamKpis(row: KpiRow): analytics.TeamKpis {
    return {
      headcount: Number(row.headcount),
      activeTrainees: Number(row.active_trainees),
      enrollments: Number(row.enrollments),
      programCompletion: ratio(row.completed, row.enrollments),
      averageProgressPercent: round1(row.avg_progress),
      averageAssessmentScore: round1(row.avg_score),
      assessmentAttempts: Number(row.attempts),
      aiRolePlayAverage: round1(row.ai_avg),
      aiSessions: Number(row.ai_sessions),
      fieldReadyCount: Number(row.field_ready),
      certifiedCount: Number(row.certified),
    };
  }

  // ---------------------------------------------------------------- people lists

  async fallingBehind(q: QuerySql, limit = 10): Promise<{ total: number; items: analytics.FallingBehindItem[] }> {
    const now = sql`${q.now}::timestamptz`;
    const { inactivityDays, paceTolerancePercent } = q.ctx.settings;
    const rows = await this.rows(sql<{
      enrollment_id: string;
      user_id: string;
      display_name: string;
      program_id: string;
      program_title: string;
      progress_percent: number;
      expected_percent: number | null;
      enrolled_at: Date;
      due_at: Date | null;
      last_activity_at: Date | null;
      days_inactive: number;
      r_overdue: boolean;
      r_inactive: boolean;
      r_pace: boolean;
      total: number;
    }>`
      with pop as (${q.population()}),
      base as (
        select e.enrollment_id, e.user_id, pop.display_name, e.program_id,
          coalesce(p.title, e.program_title, 'Untitled program') as program_title,
          e.progress_percent,
          coalesce(e.enrolled_at, e.first_seen_at) as enrolled_at,
          e.due_at,
          greatest(e.last_activity_at, la.last_activity_at) as last_activity_at,
          ((e.due_at is not null and e.due_at < ${now}) or (e.due_at is null and e.overdue)) as is_overdue,
          case when e.due_at is not null and e.due_at > coalesce(e.enrolled_at, e.first_seen_at) then
            least(100, greatest(0,
              extract(epoch from (${now} - coalesce(e.enrolled_at, e.first_seen_at)))
              / extract(epoch from (e.due_at - coalesce(e.enrolled_at, e.first_seen_at))) * 100))
          end as expected_percent
        from fact_enrollments e
        join pop on pop.user_id = e.user_id
        left join dim_programs p on p.id = e.program_id
        left join learner_activity la on la.user_id = e.user_id
        where e.organization_id = ${q.org} and e.status = 'active' and ${q.program('e.program_id')}
      ),
      flagged as (
        select b.*,
          greatest(0, floor(extract(epoch from (${now} - coalesce(b.last_activity_at, b.enrolled_at))) / 86400))::int as days_inactive,
          b.is_overdue as r_overdue,
          (coalesce(b.last_activity_at, b.enrolled_at) <= ${now} - make_interval(days => ${inactivityDays})) as r_inactive,
          (b.expected_percent is not null and b.progress_percent < b.expected_percent - ${paceTolerancePercent}) as r_pace
        from base b
      )
      select f.*, count(*) over () as total
      from flagged f
      where f.r_overdue or f.r_inactive or f.r_pace
      order by f.r_overdue desc, f.days_inactive desc, (f.expected_percent - f.progress_percent) desc nulls last, f.display_name
      limit ${limit}
    `);
    const teams = await this.teamNames(rows.map((r) => r.user_id));
    return {
      total: Number(rows[0]?.total ?? 0),
      items: rows.map((r) => ({
        person: this.brief(r.user_id, r.display_name, teams),
        enrollmentId: r.enrollment_id,
        programId: r.program_id,
        programTitle: r.program_title,
        progressPercent: round1(r.progress_percent) ?? 0,
        expectedPercent: round1(r.expected_percent),
        enrolledAt: isoRequired(r.enrolled_at),
        dueAt: iso(r.due_at),
        lastActivityAt: iso(r.last_activity_at),
        daysInactive: Number(r.days_inactive),
        reasons: [
          ...(r.r_overdue ? (['overdue'] as const) : []),
          ...(r.r_inactive ? (['inactive'] as const) : []),
          ...(r.r_pace ? (['behind_pace'] as const) : []),
        ],
      })),
    };
  }

  async requiringAttention(q: QuerySql, limit = 10): Promise<{ total: number; items: Array<AttentionItem> }> {
    const { lowAiScore, attentionLookbackDays } = q.ctx.settings;
    const since = new Date(q.now.getTime() - attentionLookbackDays * DAY_MS);
    const rows = await this.rows(sql<{
      user_id: string;
      display_name: string;
      reasons: Array<Record<string, unknown>>;
      latest_at: Date;
      total: number;
    }>`
      with pop as (${q.population()}),
      latest_attempt as (
        select distinct on (a.user_id, a.assessment_id)
          a.user_id, a.assessment_id, a.assessment_title, a.score_percent, a.passing_percent, a.passed, a.graded_at,
          count(*) over (partition by a.user_id, a.assessment_id) as attempts
        from fact_assessment_attempts a
        join pop on pop.user_id = a.user_id
        where a.organization_id = ${q.org} and a.kind <> 'practice'
          and ${q.programAssessment('a.program_id', 'a.assessment_id')}
        order by a.user_id, a.assessment_id, a.graded_at desc
      ),
      latest_ai as (
        select distinct on (s.user_id, s.scenario_id)
          s.user_id, s.scenario_id, s.scenario_title, s.overall_score, s.passing_score, s.passed, s.evaluated_at
        from fact_ai_sessions s
        join pop on pop.user_id = s.user_id
        where s.organization_id = ${q.org}
        order by s.user_id, s.scenario_id, s.evaluated_at desc
      ),
      reasons as (
        select user_id, graded_at as at, json_build_object(
          'kind', 'failed_assessment', 'assessmentId', assessment_id, 'title', assessment_title,
          'scorePercent', score_percent, 'passingPercent', passing_percent, 'attempts', attempts, 'at', graded_at) as reason
        from latest_attempt
        where not passed and ${q.rangeOr('graded_at', since)}
        union all
        select user_id, evaluated_at, json_build_object(
          'kind', 'low_ai_score', 'scenarioId', scenario_id, 'title', scenario_title,
          'score', overall_score, 'passingScore', passing_score, 'at', evaluated_at)
        from latest_ai
        where (not passed or overall_score < ${lowAiScore}) and ${q.rangeOr('evaluated_at', since)}
      )
      select r.user_id, p.display_name, json_agg(r.reason order by r.at desc) as reasons, max(r.at) as latest_at,
             count(*) over () as total
      from reasons r join pop p on p.user_id = r.user_id
      group by r.user_id, p.display_name
      order by count(*) desc, max(r.at) desc, p.display_name
      limit ${limit}
    `);
    const teams = await this.teamNames(rows.map((r) => r.user_id));
    return {
      total: Number(rows[0]?.total ?? 0),
      items: rows.map((r) => ({
        person: this.brief(r.user_id, r.display_name, teams),
        latestAt: isoRequired(r.latest_at),
        reasons: r.reasons.slice(0, 5).map((reason): analytics.AttentionReason =>
          reason.kind === 'failed_assessment'
            ? {
                kind: 'failed_assessment',
                assessmentId: String(reason.assessmentId),
                title: String(reason.title),
                scorePercent: round1(Number(reason.scorePercent)) ?? 0,
                passingPercent: round1(Number(reason.passingPercent)) ?? 0,
                attempts: Number(reason.attempts),
                at: isoRequired(String(reason.at)),
              }
            : {
                kind: 'low_ai_score',
                scenarioId: String(reason.scenarioId),
                title: String(reason.title),
                score: round1(Number(reason.score)) ?? 0,
                passingScore: round1(Number(reason.passingScore)) ?? 0,
                at: isoRequired(String(reason.at)),
              },
        ),
      })),
    };
  }

  async expiringCertificates(q: QuerySql, limit = 10): Promise<analytics.TeamDashboard['expiringCertifications']> {
    const now = sql`${q.now}::timestamptz`;
    const rows = await this.rows(sql<{
      certificate_id: string;
      user_id: string;
      display_name: string;
      definition_id: string;
      definition_name: string;
      certificate_number: string | null;
      expires_at: Date;
      w30: number;
      w60: number;
      w90: number;
    }>`
      with pop as (${q.population()})
      select c.certificate_id, c.user_id, p.display_name, c.definition_id, c.definition_name, c.certificate_number, c.expires_at,
        count(*) filter (where c.expires_at <= ${now} + interval '30 days') over () as w30,
        count(*) filter (where c.expires_at <= ${now} + interval '60 days') over () as w60,
        count(*) over () as w90
      from fact_certificates c join pop p on p.user_id = c.user_id
      where c.organization_id = ${q.org} and c.status = 'issued'
        and c.expires_at > ${now} and c.expires_at <= ${now} + interval '90 days'
        and ${q.certification('c.definition_id')}
      order by c.expires_at, p.display_name
      limit ${limit}
    `);
    const teams = await this.teamNames(rows.map((r) => r.user_id));
    return {
      within30Days: Number(rows[0]?.w30 ?? 0),
      within60Days: Number(rows[0]?.w60 ?? 0),
      within90Days: Number(rows[0]?.w90 ?? 0),
      items: rows.map((r) => ({
        person: this.brief(r.user_id, r.display_name, teams),
        certificateId: r.certificate_id,
        certificationId: r.definition_id,
        certificationName: r.definition_name,
        certificateNumber: r.certificate_number,
        expiresAt: isoRequired(r.expires_at),
        daysRemaining: Math.ceil((r.expires_at.getTime() - q.now.getTime()) / DAY_MS),
      })),
    };
  }

  async recentActivity(q: QuerySql, limit = 20): Promise<analytics.ActivityItem[]> {
    const rows = await this.rows(sql<{
      id: string;
      occurred_at: Date;
      kind: analytics.ActivityKind;
      title: string;
      score: number | null;
      passed: boolean | null;
      user_id: string;
      display_name: string | null;
    }>`
      select f.id, f.occurred_at, f.kind, f.title, f.score, f.passed, f.user_id, u.display_name
      from fact_activity f
      left join dir_users u on u.id = f.user_id
      where f.organization_id = ${q.org}
        and ${q.people('f.user_id', 'f.organization_id')}
        and ${q.range('f.occurred_at')}
        and f.occurred_at <= ${q.now}::timestamptz
      order by f.occurred_at desc, f.id
      limit ${limit}
    `);
    return rows.map((r) => ({
      id: r.id,
      at: isoRequired(r.occurred_at),
      kind: r.kind,
      title: r.title,
      score: round1(r.score),
      passed: r.passed,
      person: { id: r.user_id, displayName: r.display_name ?? 'Unknown learner' },
    }));
  }

  async weakestAreas(q: QuerySql, limit = 5): Promise<analytics.TeamDashboard['weakestAreas']> {
    const [ai, questions] = await Promise.all([
      this.rows(sql<{ key: string; label: string; avg: number; n: number }>`
        select c.category_key as key, (array_agg(c.category_label order by c.evaluated_at desc))[1] as label,
               avg(c.score) as avg, count(*) as n
        from fact_ai_category_scores c
        where c.organization_id = ${q.org} and ${q.people('c.user_id', 'c.organization_id')} and ${q.range('c.evaluated_at')}
        group by c.category_key
        order by avg(c.score) asc, count(*) desc, c.category_key
        limit ${limit}
      `),
      this.rows(sql<{ category_id: string | null; name: string | null; answered: number; incorrect: number }>`
        select coalesce(q.category_id, dq.category_id) as category_id, qc.name,
               count(*) as answered, count(*) filter (where not q.correct) as incorrect
        from fact_question_results q
        left join dim_questions dq on dq.id = q.question_id
        left join dim_question_categories qc on qc.id = coalesce(q.category_id, dq.category_id)
        where q.organization_id = ${q.org} and q.correct is not null
          and ${q.people('q.user_id', 'q.organization_id')} and ${q.range('q.graded_at')}
          and ${this.questionProgram(q)}
        group by coalesce(q.category_id, dq.category_id), qc.name
        having count(*) >= ${q.ctx.settings.minQuestionSample} and count(*) filter (where not q.correct) > 0
        order by (count(*) filter (where not q.correct))::numeric / count(*) desc, count(*) desc
        limit ${limit}
      `),
    ]);
    return {
      aiCategories: ai.map((r) => ({ key: r.key, label: r.label, averageScore: round1(r.avg) ?? 0, sessions: Number(r.n) })),
      questionCategories: questions.map((r) => ({
        categoryId: r.category_id,
        name: r.name ?? 'Uncategorized',
        answered: Number(r.answered),
        incorrect: Number(r.incorrect),
        missRatePercent: round1((Number(r.incorrect) / Number(r.answered)) * 100) ?? 0,
      })),
    };
  }

  private questionProgram(q: QuerySql): RawBuilder<SqlBool> {
    const p = q.ctx.filters.programId;
    if (!p) return sql<SqlBool>`true`;
    return sql<SqlBool>`(q.assessment_id in (select id from dim_assessments where program_id = ${p})
      or q.attempt_id in (select attempt_id from fact_assessment_attempts where program_id = ${p}))`;
  }

  // ---------------------------------------------------------------- company

  async breakdown(q: QuerySql, by: 'team' | 'location'): Promise<analytics.BreakdownRow[]> {
    const now = sql`${q.now}::timestamptz`;
    const groups =
      by === 'team'
        ? sql`select t.id as group_id, t.name from dir_teams t where t.organization_id = ${q.org} and not t.archived`
        : sql`select d.id as group_id, d.name from dir_units d where d.organization_id = ${q.org} and d.kind = 'location' and not d.archived`;
    const membership =
      by === 'team'
        ? sql`select ut.team_id as group_id, ut.user_id from dir_user_teams ut`
        : sql`select u.location_id as group_id, u.id as user_id from dir_users u where u.location_id is not null`;
    const rows = await this.rows(sql<{
      group_id: string;
      name: string;
      headcount: number;
      active_trainees: number;
      enrollments: number;
      completed: number;
      progress_sum: number | null;
      att_sum: number | null;
      att_n: number;
      ai_sum: number | null;
      ai_n: number;
      certified: number;
      overdue: number;
    }>`
      with pop as (${q.population()}),
      enr as (
        select e.user_id, e.status, e.progress_percent,
          (e.status = 'active' and (e.due_at < ${now} or (e.due_at is null and e.overdue))) as is_overdue
        from fact_enrollments e
        where e.organization_id = ${q.org} and e.status <> 'withdrawn'
          and ${q.program('e.program_id')} and ${q.range(sql`coalesce(e.enrolled_at, e.first_seen_at)`)}
      ),
      att as (
        select a.user_id, a.score_percent from fact_assessment_attempts a
        where a.organization_id = ${q.org} and a.kind <> 'practice' and ${q.range('a.graded_at')}
          and ${q.programAssessment('a.program_id', 'a.assessment_id')}
      ),
      ai as (
        select s.user_id, s.overall_score from fact_ai_sessions s
        where s.organization_id = ${q.org} and ${q.range('s.evaluated_at')}
      ),
      cert as (
        select distinct c.user_id from fact_certificates c
        where c.organization_id = ${q.org} and c.status = 'issued'
          and (c.expires_at is null or c.expires_at > ${now}) and ${q.certification('c.definition_id')}
      ),
      enr_u as (
        select user_id, count(*) as enrollments, count(*) filter (where status = 'completed') as completed,
          count(*) filter (where status = 'active') as active, count(*) filter (where is_overdue) as overdue,
          sum(progress_percent) as progress_sum
        from enr group by user_id
      ),
      att_u as (select user_id, sum(score_percent) as att_sum, count(*) as att_n from att group by user_id),
      ai_u as (select user_id, sum(overall_score) as ai_sum, count(*) as ai_n from ai group by user_id),
      per_user as (
        select p.user_id,
          coalesce(e.enrollments, 0) as enrollments, coalesce(e.completed, 0) as completed,
          coalesce(e.active, 0) as active, coalesce(e.overdue, 0) as overdue, e.progress_sum,
          a.att_sum, coalesce(a.att_n, 0) as att_n, i.ai_sum, coalesce(i.ai_n, 0) as ai_n,
          (c.user_id is not null) as certified
        from pop p
        left join enr_u e on e.user_id = p.user_id
        left join att_u a on a.user_id = p.user_id
        left join ai_u i on i.user_id = p.user_id
        left join cert c on c.user_id = p.user_id
      ),
      groups as (${groups}),
      membership as (${membership})
      select g.group_id, g.name,
        count(u.user_id) as headcount,
        count(u.user_id) filter (where u.active > 0) as active_trainees,
        coalesce(sum(u.enrollments), 0) as enrollments,
        coalesce(sum(u.completed), 0) as completed,
        sum(u.progress_sum) as progress_sum,
        sum(u.att_sum) as att_sum,
        coalesce(sum(u.att_n), 0) as att_n,
        sum(u.ai_sum) as ai_sum,
        coalesce(sum(u.ai_n), 0) as ai_n,
        count(u.user_id) filter (where u.certified) as certified,
        coalesce(sum(u.overdue), 0) as overdue
      from groups g
      join membership m on m.group_id = g.group_id
      join per_user u on u.user_id = m.user_id
      group by g.group_id, g.name
      order by g.name
    `);
    return rows.map((r) => ({
      id: r.group_id,
      name: r.name,
      headcount: Number(r.headcount),
      activeTrainees: Number(r.active_trainees),
      programCompletion: ratio(r.completed, r.enrollments),
      averageProgressPercent: Number(r.enrollments) > 0 ? round1(Number(r.progress_sum) / Number(r.enrollments)) : null,
      averageAssessmentScore: Number(r.att_n) > 0 ? round1(Number(r.att_sum) / Number(r.att_n)) : null,
      aiRolePlayAverage: Number(r.ai_n) > 0 ? round1(Number(r.ai_sum) / Number(r.ai_n)) : null,
      certifiedCount: Number(r.certified),
      overdueEnrollments: Number(r.overdue),
    }));
  }

  async dropOffLessons(q: QuerySql, limit = 10): Promise<Array<DropOffLesson>> {
    const now = sql`${q.now}::timestamptz`;
    const rows = await this.rows(sql<{
      lesson_id: string;
      title: string | null;
      lesson_type: string | null;
      phase_title: string | null;
      position: number | null;
      avg_dwell: number;
      completions: number;
      stalled_learners: number;
      avg_days_stalled: number | null;
    }>`
      with pop as (${q.population()}),
      lessons as (
        select l.id, l.title, l.lesson_type, l.position, ph.title as phase_title
        from dim_lessons l left join dim_phases ph on ph.id = l.phase_id
        where l.organization_id = ${q.org} and l.in_program and ${q.program('l.program_id')}
      ),
      done as (
        select f.lesson_id, f.completed_at,
          coalesce(lag(f.completed_at) over (partition by f.enrollment_id order by f.completed_at),
                   coalesce(e.enrolled_at, e.first_seen_at)) as prev_at
        from fact_lesson_events f
        join fact_enrollments e on e.enrollment_id = f.enrollment_id
        where f.organization_id = ${q.org} and f.completed_at is not null
          and ${q.people('f.user_id', 'f.organization_id')} and ${q.program('f.program_id')}
      ),
      dwell as (
        select lesson_id, greatest(0, extract(epoch from completed_at - prev_at) / 86400.0) as days, false as stalled
        from done where ${q.range('completed_at')}
      ),
      stalled as (
        select nl.id as lesson_id,
          greatest(0, extract(epoch from ${now} - coalesce(
            (select max(x.completed_at) from fact_lesson_events x where x.enrollment_id = e.enrollment_id),
            coalesce(e.enrolled_at, e.first_seen_at))) / 86400.0) as days,
          true as stalled
        from fact_enrollments e
        join pop on pop.user_id = e.user_id
        cross join lateral (
          select l.id from dim_lessons l
          where l.program_id = e.program_id and l.in_program and coalesce(l.required, true) and l.position is not null
            and not exists (
              select 1 from fact_lesson_events x
              where x.enrollment_id = e.enrollment_id and x.lesson_id = l.id and x.completed_at is not null)
          order by l.position
          limit 1
        ) nl
        where e.organization_id = ${q.org} and e.status = 'active' and ${q.program('e.program_id')}
      ),
      samples as (select * from dwell union all select * from stalled)
      select l.id as lesson_id, l.title, l.lesson_type, l.phase_title, l.position,
        avg(s.days) as avg_dwell,
        count(*) filter (where not s.stalled) as completions,
        count(*) filter (where s.stalled) as stalled_learners,
        avg(s.days) filter (where s.stalled) as avg_days_stalled
      from samples s join lessons l on l.id = s.lesson_id
      group by l.id, l.title, l.lesson_type, l.phase_title, l.position
      order by avg(s.days) desc, count(*) filter (where s.stalled) desc, l.position nulls last
      limit ${limit}
    `);
    return rows.map((r) => ({
      lessonId: r.lesson_id,
      title: r.title ?? 'Untitled lesson',
      lessonType: r.lesson_type,
      phaseTitle: r.phase_title,
      position: r.position === null ? null : Number(r.position),
      averageDwellDays: round1(r.avg_dwell) ?? 0,
      completions: Number(r.completions),
      stalledLearners: Number(r.stalled_learners),
      averageDaysStalled: round1(r.avg_days_stalled),
    }));
  }

  async hardestQuestions(q: QuerySql, limit = 10): Promise<Array<HardQuestion>> {
    const rows = await this.rows(sql<{
      question_id: string;
      assessment_id: string;
      prompt: string | null;
      assessment_title: string | null;
      category_name: string | null;
      answered: number;
      incorrect: number;
    }>`
      select q.question_id, q.assessment_id, dq.prompt, da.title as assessment_title, qc.name as category_name,
        count(*) as answered, count(*) filter (where not q.correct) as incorrect
      from fact_question_results q
      left join dim_questions dq on dq.id = q.question_id
      left join dim_assessments da on da.id = q.assessment_id
      left join dim_question_categories qc on qc.id = coalesce(q.category_id, dq.category_id)
      where q.organization_id = ${q.org} and q.correct is not null
        and ${q.people('q.user_id', 'q.organization_id')} and ${q.range('q.graded_at')} and ${this.questionProgram(q)}
      group by q.question_id, q.assessment_id, dq.prompt, da.title, qc.name
      having count(*) >= ${q.ctx.settings.minQuestionSample} and count(*) filter (where not q.correct) > 0
      order by (count(*) filter (where not q.correct))::numeric / count(*) desc, count(*) desc, q.question_id
      limit ${limit}
    `);
    return rows.map((r) => ({
      questionId: r.question_id,
      prompt: r.prompt,
      assessmentId: r.assessment_id,
      assessmentTitle: r.assessment_title ?? 'Assessment',
      categoryName: r.category_name,
      answered: Number(r.answered),
      incorrect: Number(r.incorrect),
      missRatePercent: round1((Number(r.incorrect) / Number(r.answered)) * 100) ?? 0,
    }));
  }

  async mostFailedObjections(q: QuerySql, limit = 10): Promise<Array<FailedObjection>> {
    const rows = await this.rows(sql<{
      scenario_id: string;
      title: string;
      category: string;
      difficulty: string;
      sessions: number;
      failed: number;
      avg: number;
    }>`
      select s.scenario_id,
        (array_agg(s.scenario_title order by s.evaluated_at desc))[1] as title,
        (array_agg(s.scenario_category order by s.evaluated_at desc))[1] as category,
        (array_agg(s.difficulty order by s.evaluated_at desc))[1] as difficulty,
        count(*) as sessions, count(*) filter (where not s.passed) as failed, avg(s.overall_score) as avg
      from fact_ai_sessions s
      where s.organization_id = ${q.org} and ${q.people('s.user_id', 's.organization_id')} and ${q.range('s.evaluated_at')}
      group by s.scenario_id
      having count(*) filter (where not s.passed) > 0
      order by count(*) filter (where not s.passed) desc, (count(*) filter (where not s.passed))::numeric / count(*) desc, avg(s.overall_score), s.scenario_id
      limit ${limit}
    `);
    return rows.map((r) => ({
      scenarioId: r.scenario_id,
      title: r.title,
      category: r.category,
      difficulty: r.difficulty,
      sessions: Number(r.sessions),
      failed: Number(r.failed),
      failureRatePercent: round1((Number(r.failed) / Number(r.sessions)) * 100) ?? 0,
      averageScore: round1(r.avg) ?? 0,
    }));
  }

  async certification(q: QuerySql): Promise<{ conversion: analytics.Ratio; averageDays: number | null; medianDays: number | null }> {
    const [conv] = await this.rows(sql<{ eligible: number; converted: number }>`
      select count(*) as eligible, count(*) filter (where c.first_issued_at is not null) as converted
      from fact_certification_candidates c
      where c.organization_id = ${q.org} and c.eligible_at is not null
        and ${q.people('c.user_id', 'c.organization_id')} and ${q.certification('c.definition_id')} and ${q.range('c.eligible_at')}
    `);
    const [time] = await this.rows(sql<{ avg_days: number | null; median_days: number | null }>`
      with firsts as (
        select c.first_issued_at,
          (select min(coalesce(e.enrolled_at, e.first_seen_at)) from fact_enrollments e
            where e.user_id = c.user_id and e.organization_id = ${q.org}
              and coalesce(e.enrolled_at, e.first_seen_at) <= c.first_issued_at and ${q.program('e.program_id')}) as started_at
        from fact_certification_candidates c
        where c.organization_id = ${q.org} and c.first_issued_at is not null
          and ${q.people('c.user_id', 'c.organization_id')} and ${q.certification('c.definition_id')} and ${q.range('c.first_issued_at')}
      ),
      days as (select extract(epoch from first_issued_at - started_at) / 86400.0 as d from firsts where started_at is not null)
      select avg(d) as avg_days, percentile_cont(0.5) within group (order by d) as median_days from days
    `);
    return {
      conversion: ratio(conv?.converted ?? 0, conv?.eligible ?? 0),
      averageDays: round1(time?.avg_days ?? null),
      medianDays: round1(time?.median_days ?? null),
    };
  }
}

type AttentionItem = analytics.TeamDashboard['requiringAttention']['items'][number];
type DropOffLesson = analytics.CompanyDashboard['dropOffLessons'][number];
type HardQuestion = analytics.CompanyDashboard['hardestQuestions'][number];
type FailedObjection = analytics.CompanyDashboard['mostFailedObjections'][number];
