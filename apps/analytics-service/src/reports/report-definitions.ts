import type { analytics } from '@a5/contracts';
import { sql } from '@a5/database';
import type { RawBuilder } from 'kysely';
import type { QuerySql } from '../analytics/query-context.js';

type Column = analytics.ReportColumn;
type ColumnType = Column['type'];

export interface ReportDefinition {
  key: analytics.ReportKey;
  title: string;
  description: string;
  columns: Column[];
  defaultSort: string;
  /** Column matched by the free-text `q` parameter. */
  searchColumn: string;
  /**
   * Row source. Must select `"rowId"` (stable unique key used as the sort tiebreaker), optionally
   * `"userId"`, and one aliased column per entry in `columns`.
   */
  query(q: QuerySql): RawBuilder<Record<string, unknown>>;
}

const col = (key: string, label: string, type: ColumnType, sortable = true): Column => ({ key, label, type, sortable });

/** Employee name, number and teams for a user id expression (requires `left join dir_users u`). */
const employeeColumns = sql`
  coalesce(u.display_name, 'Unknown learner') as "employee",
  u.employee_id as "employeeId",
  (select string_agg(t.name, ', ' order by t.name)
     from dir_user_teams ut join dir_teams t on t.id = ut.team_id
    where ut.user_id = u.id and not t.archived) as "team"
`;

const employeeCols = [col('employee', 'Employee', 'string'), col('employeeId', 'Employee ID', 'string'), col('team', 'Team', 'string')];

function overdueExpr(q: QuerySql, alias = 'e'): RawBuilder<boolean> {
  const e = (c: string) => sql.ref(`${alias}.${c}`);
  return sql<boolean>`(${e('status')} = 'active' and (${e('due_at')} < ${q.now}::timestamptz or (${e('due_at')} is null and ${e('overdue')})))`;
}

export const REPORTS: ReportDefinition[] = [
  {
    key: 'training-completion',
    title: 'Training completion',
    description: 'One row per enrollment with progress, due date and completion time.',
    columns: [
      ...employeeCols,
      col('location', 'Location', 'string'),
      col('program', 'Program', 'string'),
      col('status', 'Status', 'string'),
      col('progressPercent', 'Progress %', 'percent'),
      col('requiredCompleted', 'Required lessons done', 'integer'),
      col('requiredTotal', 'Required lessons', 'integer'),
      col('enrolledAt', 'Enrolled', 'datetime'),
      col('dueAt', 'Due', 'datetime'),
      col('completedAt', 'Completed', 'datetime'),
      col('daysToComplete', 'Days to complete', 'number'),
      col('overdue', 'Overdue', 'boolean'),
    ],
    defaultSort: 'employee',
    searchColumn: 'employee',
    query: (q) => sql`
      select e.enrollment_id as "rowId", e.user_id as "userId", ${employeeColumns},
        loc.name as "location",
        coalesce(p.title, e.program_title, 'Untitled program') as "program",
        e.status as "status",
        round(e.progress_percent::numeric, 1) as "progressPercent",
        e.required_completed as "requiredCompleted",
        coalesce(e.required_total, p.required_lesson_count) as "requiredTotal",
        coalesce(e.enrolled_at, e.first_seen_at) as "enrolledAt",
        e.due_at as "dueAt",
        e.completed_at as "completedAt",
        round((extract(epoch from e.completed_at - coalesce(e.enrolled_at, e.first_seen_at)) / 86400.0)::numeric, 1) as "daysToComplete",
        ${overdueExpr(q)} as "overdue"
      from fact_enrollments e
      left join dir_users u on u.id = e.user_id
      left join dir_units loc on loc.id = u.location_id
      left join dim_programs p on p.id = e.program_id
      where e.organization_id = ${q.org}
        and ${q.people('e.user_id', 'e.organization_id')}
        and ${q.program('e.program_id')}
        and ${q.range(sql`coalesce(e.enrolled_at, e.first_seen_at)`)}
    `,
  },
  {
    key: 'assessment-performance',
    title: 'Assessment performance',
    description: 'One row per learner and assessment: attempts, best and latest score, and when they passed.',
    columns: [
      ...employeeCols,
      col('assessment', 'Assessment', 'string'),
      col('kind', 'Type', 'string'),
      col('attempts', 'Attempts', 'integer'),
      col('bestScore', 'Best score %', 'percent'),
      col('latestScore', 'Latest score %', 'percent'),
      col('averageScore', 'Average score %', 'percent'),
      col('passed', 'Passed', 'boolean'),
      col('firstPassedAt', 'First passed', 'datetime'),
      col('lastAttemptAt', 'Last attempt', 'datetime'),
    ],
    defaultSort: '-lastAttemptAt',
    searchColumn: 'employee',
    query: (q) => sql`
      with g as (
        select a.user_id, a.assessment_id,
          (array_agg(a.assessment_title order by a.graded_at desc))[1] as title,
          (array_agg(a.kind order by a.graded_at desc))[1] as kind,
          count(*) as attempts,
          max(a.score_percent) as best,
          (array_agg(a.score_percent order by a.graded_at desc))[1] as latest,
          avg(a.score_percent) as average,
          bool_or(a.passed) as passed,
          min(a.graded_at) filter (where a.passed) as first_passed_at,
          max(a.graded_at) as last_attempt_at
        from fact_assessment_attempts a
        where a.organization_id = ${q.org}
          and ${q.people('a.user_id', 'a.organization_id')}
          and ${q.range('a.graded_at')}
          and ${q.programAssessment('a.program_id', 'a.assessment_id')}
        group by a.user_id, a.assessment_id
      )
      select g.user_id::text || ':' || g.assessment_id::text as "rowId", g.user_id as "userId", ${employeeColumns},
        g.title as "assessment", g.kind as "kind", g.attempts as "attempts",
        round(g.best::numeric, 1) as "bestScore", round(g.latest::numeric, 1) as "latestScore", round(g.average::numeric, 1) as "averageScore",
        g.passed as "passed", g.first_passed_at as "firstPassedAt", g.last_attempt_at as "lastAttemptAt"
      from g left join dir_users u on u.id = g.user_id
    `,
  },
  {
    key: 'ai-coaching-performance',
    title: 'AI coaching performance',
    description: 'One row per learner: role-play sessions, scores, pass rate and strongest / weakest rubric category.',
    columns: [
      ...employeeCols,
      col('sessions', 'Sessions', 'integer'),
      col('averageScore', 'Average score', 'number'),
      col('bestScore', 'Best score', 'number'),
      col('latestScore', 'Latest score', 'number'),
      col('passRate', 'Pass rate %', 'percent'),
      col('scenariosPracticed', 'Scenarios practiced', 'integer'),
      col('weakestCategory', 'Weakest category', 'string'),
      col('strongestCategory', 'Strongest category', 'string'),
      col('lastSessionAt', 'Last session', 'datetime'),
    ],
    defaultSort: 'employee',
    searchColumn: 'employee',
    query: (q) => sql`
      with s as (
        select x.* from fact_ai_sessions x
        where x.organization_id = ${q.org} and ${q.people('x.user_id', 'x.organization_id')} and ${q.range('x.evaluated_at')}
      ),
      g as (
        select s.user_id, count(*) as sessions, avg(s.overall_score) as average, max(s.overall_score) as best,
          (array_agg(s.overall_score order by s.evaluated_at desc))[1] as latest,
          avg(s.passed::int) * 100 as pass_rate, count(distinct s.scenario_id) as scenarios, max(s.evaluated_at) as last_at
        from s group by s.user_id
      ),
      cat as (
        select c.user_id, c.category_key, (array_agg(c.category_label order by c.evaluated_at desc))[1] as label, avg(c.score) as average
        from fact_ai_category_scores c where c.session_id in (select session_id from s)
        group by c.user_id, c.category_key
      )
      select g.user_id::text as "rowId", g.user_id as "userId", ${employeeColumns},
        g.sessions as "sessions", round(g.average::numeric, 1) as "averageScore", round(g.best::numeric, 1) as "bestScore",
        round(g.latest::numeric, 1) as "latestScore", round(g.pass_rate::numeric, 1) as "passRate", g.scenarios as "scenariosPracticed",
        (select cat.label from cat where cat.user_id = g.user_id order by cat.average asc, cat.label limit 1) as "weakestCategory",
        (select cat.label from cat where cat.user_id = g.user_id order by cat.average desc, cat.label limit 1) as "strongestCategory",
        g.last_at as "lastSessionAt"
      from g left join dir_users u on u.id = g.user_id
    `,
  },
  {
    key: 'certification-status',
    title: 'Certification status',
    description: 'One row per certificate with status, issue and expiry dates.',
    columns: [
      ...employeeCols,
      col('certification', 'Certification', 'string'),
      col('certificateNumber', 'Certificate number', 'string'),
      col('status', 'Status', 'string'),
      col('issuedAt', 'Issued', 'datetime'),
      col('expiresAt', 'Expires', 'datetime'),
      col('daysUntilExpiry', 'Days until expiry', 'integer'),
    ],
    defaultSort: 'expiresAt',
    searchColumn: 'employee',
    query: (q) => sql`
      select c.certificate_id::text as "rowId", c.user_id as "userId", ${employeeColumns},
        c.definition_name as "certification",
        c.certificate_number as "certificateNumber",
        case when c.status = 'issued' and c.expires_at is not null and c.expires_at <= ${q.now}::timestamptz then 'expired' else c.status end as "status",
        c.issued_at as "issuedAt",
        c.expires_at as "expiresAt",
        case when c.status = 'issued' and c.expires_at > ${q.now}::timestamptz
          then ceil(extract(epoch from c.expires_at - ${q.now}::timestamptz) / 86400)::int end as "daysUntilExpiry"
      from fact_certificates c
      left join dir_users u on u.id = c.user_id
      where c.organization_id = ${q.org}
        and ${q.people('c.user_id', 'c.organization_id')}
        and ${q.certification('c.definition_id')}
        and ${q.range('c.issued_at')}
    `,
  },
  {
    key: 'overdue-training',
    title: 'Overdue training',
    description: 'Active enrollments past their due date, with managers and last activity.',
    columns: [
      ...employeeCols,
      col('managers', 'Managers', 'string'),
      col('program', 'Program', 'string'),
      col('dueAt', 'Due', 'datetime'),
      col('daysOverdue', 'Days overdue', 'integer'),
      col('progressPercent', 'Progress %', 'percent'),
      col('lastActivityAt', 'Last activity', 'datetime'),
    ],
    defaultSort: '-daysOverdue',
    searchColumn: 'employee',
    query: (q) => sql`
      select e.enrollment_id::text as "rowId", e.user_id as "userId", ${employeeColumns},
        (select string_agg(distinct m.display_name, ', ')
           from dir_users m
          where m.id in (
            select tm.user_id from dir_team_managers tm join dir_user_teams ut on ut.team_id = tm.team_id where ut.user_id = e.user_id
            union
            select s.supervisor_id from dir_user_supervisors s where s.user_id = e.user_id and s.kind = 'manager'
          )) as "managers",
        coalesce(p.title, e.program_title, 'Untitled program') as "program",
        e.due_at as "dueAt",
        case when e.due_at is not null then floor(extract(epoch from ${q.now}::timestamptz - e.due_at) / 86400)::int end as "daysOverdue",
        round(e.progress_percent::numeric, 1) as "progressPercent",
        greatest(e.last_activity_at, la.last_activity_at) as "lastActivityAt"
      from fact_enrollments e
      left join dir_users u on u.id = e.user_id
      left join dim_programs p on p.id = e.program_id
      left join learner_activity la on la.user_id = e.user_id
      where e.organization_id = ${q.org}
        and ${overdueExpr(q)}
        and ${q.people('e.user_id', 'e.organization_id')}
        and ${q.program('e.program_id')}
    `,
  },
  {
    key: 'training-engagement',
    title: 'Training engagement',
    description: 'One row per learner: lessons, assessments, AI practice and active days in the period.',
    columns: [
      ...employeeCols,
      col('location', 'Location', 'string'),
      col('lessonsStarted', 'Lessons started', 'integer'),
      col('lessonsCompleted', 'Lessons completed', 'integer'),
      col('assessmentsTaken', 'Assessment attempts', 'integer'),
      col('aiSessions', 'AI sessions', 'integer'),
      col('activeDays', 'Active days', 'integer'),
      col('lastActivityAt', 'Last activity', 'datetime'),
      col('daysSinceActivity', 'Days since activity', 'integer'),
    ],
    defaultSort: 'employee',
    searchColumn: 'employee',
    query: (q) => sql`
      with pop as (${q.population()}),
      acts as (
        select f.user_id, f.started_at as at, 'lesson_started' as kind from fact_lesson_events f
          where f.organization_id = ${q.org} and f.started_at is not null and ${q.program('f.program_id')}
        union all
        select f.user_id, f.completed_at, 'lesson_completed' from fact_lesson_events f
          where f.organization_id = ${q.org} and f.completed_at is not null and ${q.program('f.program_id')}
        union all
        select a.user_id, a.graded_at, 'assessment' from fact_assessment_attempts a
          where a.organization_id = ${q.org} and ${q.programAssessment('a.program_id', 'a.assessment_id')}
        union all
        select s.user_id, s.evaluated_at, 'ai' from fact_ai_sessions s where s.organization_id = ${q.org}
      ),
      win as (select * from acts where acts.user_id in (select user_id from pop) and ${q.range('acts.at')}),
      g as (
        select user_id,
          count(*) filter (where kind = 'lesson_started') as started,
          count(*) filter (where kind = 'lesson_completed') as completed,
          count(*) filter (where kind = 'assessment') as assessments,
          count(*) filter (where kind = 'ai') as ai,
          count(distinct (at at time zone ${q.tz})::date) as active_days
        from win group by user_id
      )
      select pop.user_id::text as "rowId", pop.user_id as "userId", ${employeeColumns},
        loc.name as "location",
        coalesce(g.started, 0) as "lessonsStarted",
        coalesce(g.completed, 0) as "lessonsCompleted",
        coalesce(g.assessments, 0) as "assessmentsTaken",
        coalesce(g.ai, 0) as "aiSessions",
        coalesce(g.active_days, 0) as "activeDays",
        la.last_activity_at as "lastActivityAt",
        case when la.last_activity_at is not null
          then greatest(0, floor(extract(epoch from ${q.now}::timestamptz - la.last_activity_at) / 86400))::int end as "daysSinceActivity"
      from pop
      left join g on g.user_id = pop.user_id
      left join dir_users u on u.id = pop.user_id
      left join dir_units loc on loc.id = u.location_id
      left join learner_activity la on la.user_id = pop.user_id
    `,
  },
  {
    key: 'course-effectiveness',
    title: 'Course effectiveness',
    description: 'Assessments and AI scenarios with learners, scores, pass rates and attempts needed to pass.',
    columns: [
      col('itemType', 'Type', 'string'),
      col('item', 'Item', 'string'),
      col('program', 'Program', 'string'),
      col('learners', 'Learners', 'integer'),
      col('attempts', 'Attempts', 'integer'),
      col('averageScore', 'Average score', 'number'),
      col('passRate', 'Pass rate %', 'percent'),
      col('firstAttemptPassRate', 'First-attempt pass rate %', 'percent'),
      col('averageAttemptsToPass', 'Attempts to pass', 'number'),
    ],
    defaultSort: 'item',
    searchColumn: 'item',
    query: (q) => sql`
      with att as (
        select a.* from fact_assessment_attempts a
        where a.organization_id = ${q.org} and a.kind <> 'practice'
          and ${q.people('a.user_id', 'a.organization_id')} and ${q.range('a.graded_at')}
          and ${q.programAssessment('a.program_id', 'a.assessment_id')}
      ),
      ai as (
        select s.*, row_number() over (partition by s.user_id, s.scenario_id order by s.evaluated_at) as n
        from fact_ai_sessions s
        where s.organization_id = ${q.org} and ${q.people('s.user_id', 's.organization_id')} and ${q.range('s.evaluated_at')}
      ),
      assessment_rows as (
        select 'assessment:' || a.assessment_id::text as row_id, 'Assessment' as item_type,
          (array_agg(a.assessment_title order by a.graded_at desc))[1] as item,
          (select dp.title from dim_assessments da join dim_programs dp on dp.id = da.program_id where da.id = a.assessment_id) as program,
          count(distinct a.user_id) as learners, count(*) as attempts, avg(a.score_percent) as average,
          avg(a.passed::int) * 100 as pass_rate,
          avg(case when a.attempt_number = 1 then a.passed::int end) * 100 as first_pass_rate,
          (select avg(t.m) from (
             select min(x.attempt_number) as m from att x where x.assessment_id = a.assessment_id and x.passed group by x.user_id
           ) t) as attempts_to_pass
        from att a group by a.assessment_id
      ),
      scenario_rows as (
        select 'scenario:' || s.scenario_id::text, 'AI scenario',
          (array_agg(s.scenario_title order by s.evaluated_at desc))[1],
          (select dp.title from dim_scenarios ds join dim_programs dp on dp.id = ds.program_id where ds.id = s.scenario_id),
          count(distinct s.user_id), count(*), avg(s.overall_score),
          avg(s.passed::int) * 100,
          avg(case when s.n = 1 then s.passed::int end) * 100,
          (select avg(t.m) from (
             select min(x.n) as m from ai x where x.scenario_id = s.scenario_id and x.passed group by x.user_id
           ) t)
        from ai s group by s.scenario_id
      ),
      all_rows as (select * from assessment_rows union all select * from scenario_rows)
      select row_id as "rowId", item_type as "itemType", item as "item", program as "program",
        learners as "learners", attempts as "attempts", round(average::numeric, 1) as "averageScore",
        round(pass_rate::numeric, 1) as "passRate", round(first_pass_rate::numeric, 1) as "firstAttemptPassRate",
        round(attempts_to_pass::numeric, 1) as "averageAttemptsToPass"
      from all_rows
    `,
  },
];

export const REPORTS_BY_KEY = new Map(REPORTS.map((r) => [r.key, r]));

export function reportDefinitionDto(def: ReportDefinition): analytics.ReportDefinitionDto {
  return { key: def.key, title: def.title, description: def.description, columns: def.columns, defaultSort: def.defaultSort };
}
