import type { analytics } from '@a5/contracts';
import { sql } from '@a5/database';
import type { RawBuilder } from 'kysely';
import type { Db } from '../database/index.js';
import { iso, isoRequired, round1 } from './query-context.js';

export interface LearnerQueryInput {
  organizationId: string;
  userId: string;
  programId?: string | undefined;
  now: Date;
  timezone: string;
  minCohortSize: number;
}

const MAX_SESSIONS = 50;

/**
 * Personal analytics for one learner. Comparisons use peers enrolled in the same programs
 * (excluding the learner) and are only returned as averages over at least `minCohortSize`
 * people, so no individual result can be inferred.
 */
export class LearnerQueries {
  constructor(private readonly db: Db) {}

  private async rows<T>(query: RawBuilder<T>): Promise<T[]> {
    return (await query.execute(this.db)).rows;
  }

  /** Peers: other learners in the same organization enrolled in any program the learner is enrolled in. */
  private peers(input: LearnerQueryInput): RawBuilder<unknown> {
    const program = input.programId ? sql`and e.program_id = ${input.programId}` : sql``;
    return sql`
      select distinct e.user_id from fact_enrollments e
      where e.organization_id = ${input.organizationId} and e.user_id <> ${input.userId} and e.status <> 'withdrawn' ${program}
        and e.program_id in (select m.program_id from fact_enrollments m where m.user_id = ${input.userId} and m.organization_id = ${input.organizationId})
    `;
  }

  private cohort(value: number | null, size: number, min: number): number | null {
    return size >= min ? round1(value) : null;
  }

  async summary(input: LearnerQueryInput): Promise<analytics.LearnerSummary> {
    const { organizationId: org, userId: me, timezone: tz } = input;
    const program = (column: string) => (input.programId ? sql`and ${sql.ref(column)} = ${input.programId}` : sql``);

    const [person] = await this.rows(sql<{ display_name: string }>`select display_name from dir_users where id = ${me}`);

    const enrollments = await this.rows(sql<{
      enrollment_id: string;
      program_id: string;
      program_title: string;
      status: 'active' | 'completed' | 'withdrawn';
      progress_percent: number;
      enrolled_at: Date;
      due_at: Date | null;
      completed_at: Date | null;
      overdue: boolean;
      required_total: number | null;
    }>`
      select e.enrollment_id, e.program_id, coalesce(p.title, e.program_title, 'Untitled program') as program_title, e.status,
        e.progress_percent, coalesce(e.enrolled_at, e.first_seen_at) as enrolled_at, e.due_at, e.completed_at,
        (e.status = 'active' and (e.due_at < ${input.now}::timestamptz or (e.due_at is null and e.overdue))) as overdue,
        coalesce(e.required_total, p.required_lesson_count) as required_total
      from fact_enrollments e left join dim_programs p on p.id = e.program_id
      where e.organization_id = ${org} and e.user_id = ${me} ${program('e.program_id')}
      order by coalesce(e.enrolled_at, e.first_seen_at) desc
    `);

    // Progress trend for the most relevant enrollment: active first, then most recent.
    const focus = enrollments.find((e) => e.status === 'active') ?? enrollments.find((e) => e.status !== 'withdrawn') ?? null;
    let progressTrend: analytics.LearnerSummary['progressTrend'] = null;
    if (focus) {
      const days = await this.rows(sql<{ d: string; n: number; req: number }>`
        select (f.completed_at at time zone ${tz})::date::text as d, count(*) as n,
               count(*) filter (where coalesce(f.required, true)) as req
        from fact_lesson_events f
        where f.enrollment_id = ${focus.enrollment_id} and f.completed_at is not null
        group by 1 order by 1
      `);
      let lessons = 0;
      let required = 0;
      const total = focus.required_total === null ? null : Number(focus.required_total);
      progressTrend = {
        enrollmentId: focus.enrollment_id,
        programTitle: focus.program_title,
        requiredTotal: total,
        points: days.map((d) => {
          lessons += Number(d.n);
          required += Number(d.req);
          return {
            date: d.d,
            completedLessons: lessons,
            progressPercent: total && total > 0 ? round1(Math.min(100, (required / total) * 100)) : null,
          };
        }),
      };
    }

    const attempts = await this.rows(sql<{
      assessment_id: string;
      assessment_title: string;
      kind: string;
      attempt_number: number;
      score_percent: number;
      passed: boolean;
      passing_percent: number;
      graded_at: Date;
    }>`
      select a.assessment_id, a.assessment_title, a.kind, a.attempt_number, a.score_percent, a.passed, a.passing_percent, a.graded_at
      from fact_assessment_attempts a
      where a.organization_id = ${org} and a.user_id = ${me} and a.kind <> 'practice'
        ${input.programId ? sql`and (a.program_id = ${input.programId} or a.assessment_id in (select id from dim_assessments where program_id = ${input.programId}))` : sql``}
      order by a.graded_at, a.attempt_number
    `);
    const assessmentIds = [...new Set(attempts.map((a) => a.assessment_id))];
    const cohortScores = assessmentIds.length
      ? await this.rows(sql<{ assessment_id: string; avg: number; n: number }>`
          select x.assessment_id, avg(x.best) as avg, count(*) as n
          from (
            select a.user_id, a.assessment_id, max(a.score_percent) as best
            from fact_assessment_attempts a
            where a.organization_id = ${org} and a.assessment_id = any(${sql.val(assessmentIds)}::uuid[])
              and a.user_id in (${this.peers(input)})
            group by a.user_id, a.assessment_id
          ) x
          group by x.assessment_id
        `)
      : [];
    const cohortByAssessment = new Map(cohortScores.map((c) => [c.assessment_id, c]));
    const quizScores: analytics.LearnerSummary['quizScores'] = assessmentIds.map((id) => {
      const list = attempts.filter((a) => a.assessment_id === id);
      const latest = list[list.length - 1]!;
      const cohort = cohortByAssessment.get(id);
      return {
        assessmentId: id,
        title: latest.assessment_title,
        kind: latest.kind,
        passingPercent: round1(latest.passing_percent) ?? 0,
        bestScore: round1(Math.max(...list.map((a) => Number(a.score_percent)))) ?? 0,
        passed: list.some((a) => a.passed),
        attempts: list.map((a) => ({
          attemptNumber: Number(a.attempt_number),
          scorePercent: round1(a.score_percent) ?? 0,
          passed: a.passed,
          gradedAt: isoRequired(a.graded_at),
        })),
        cohortAverage: cohort ? this.cohort(cohort.avg, Number(cohort.n), input.minCohortSize) : null,
      };
    });

    const sessions = (
      await this.rows(sql<{ session_id: string; evaluated_at: Date; scenario_title: string; overall_score: number; passed: boolean }>`
        select s.session_id, s.evaluated_at, s.scenario_title, s.overall_score, s.passed
        from fact_ai_sessions s
        where s.organization_id = ${org} and s.user_id = ${me}
        order by s.evaluated_at desc
        limit ${MAX_SESSIONS}
      `)
    ).reverse();
    const categoryRows = await this.rows(sql<{ key: string; label: string; d: string; score: number }>`
      select c.category_key as key, c.category_label as label, (c.evaluated_at at time zone ${tz})::date::text as d, c.score
      from fact_ai_category_scores c
      where c.organization_id = ${org} and c.user_id = ${me}
        and c.session_id in (select s.session_id from fact_ai_sessions s where s.user_id = ${me} order by s.evaluated_at desc limit ${MAX_SESSIONS})
      order by c.evaluated_at
    `);
    const cohortCategories = await this.rows(sql<{ key: string; avg: number; n: number }>`
      select x.key, avg(x.avg) as avg, count(*) as n
      from (
        select c.user_id, c.category_key as key, avg(c.score) as avg
        from fact_ai_category_scores c
        where c.organization_id = ${org} and c.user_id in (${this.peers(input)})
        group by c.user_id, c.category_key
      ) x
      group by x.key
    `);
    const cohortByCategory = new Map(cohortCategories.map((c) => [c.key, c]));
    const categoryMap = new Map<string, { label: string; points: Array<{ date: string; score: number }> }>();
    for (const r of categoryRows) {
      const entry = categoryMap.get(r.key) ?? { label: r.label, points: [] };
      entry.label = r.label;
      entry.points.push({ date: r.d, score: round1(r.score) ?? 0 });
      categoryMap.set(r.key, entry);
    }
    const categories = [...categoryMap.entries()]
      .map(([key, v]) => {
        const cohort = cohortByCategory.get(key);
        return {
          key,
          label: v.label,
          myAverage: round1(v.points.reduce((s, p) => s + p.score, 0) / v.points.length) ?? 0,
          cohortAverage: cohort ? this.cohort(cohort.avg, Number(cohort.n), input.minCohortSize) : null,
          points: v.points,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));

    const [cmp] = await this.rows(sql<{
      cohort_size: number;
      my_progress: number | null;
      cohort_progress: number | null;
      my_assessment: number | null;
      cohort_assessment: number | null;
      cohort_assessment_n: number;
      my_ai: number | null;
      cohort_ai: number | null;
      cohort_ai_n: number;
    }>`
      with peers as (${this.peers(input)}),
      peer_enr as (
        select e.progress_percent from fact_enrollments e
        where e.organization_id = ${org} and e.user_id in (select user_id from peers) and e.status <> 'withdrawn'
          and e.program_id in (select m.program_id from fact_enrollments m where m.user_id = ${me}) ${program('e.program_id')}
      ),
      peer_att as (
        select a.user_id, a.score_percent from fact_assessment_attempts a
        where a.organization_id = ${org} and a.kind <> 'practice' and a.user_id in (select user_id from peers)
      ),
      peer_ai as (
        select s.user_id, s.overall_score from fact_ai_sessions s
        where s.organization_id = ${org} and s.user_id in (select user_id from peers)
      )
      select
        (select count(*) from peers) as cohort_size,
        (select avg(progress_percent) from fact_enrollments where organization_id = ${org} and user_id = ${me} and status <> 'withdrawn' ${program('program_id')}) as my_progress,
        (select avg(progress_percent) from peer_enr) as cohort_progress,
        (select avg(score_percent) from fact_assessment_attempts where organization_id = ${org} and user_id = ${me} and kind <> 'practice') as my_assessment,
        (select avg(score_percent) from peer_att) as cohort_assessment,
        (select count(distinct user_id) from peer_att) as cohort_assessment_n,
        (select avg(overall_score) from fact_ai_sessions where organization_id = ${org} and user_id = ${me}) as my_ai,
        (select avg(overall_score) from peer_ai) as cohort_ai,
        (select count(distinct user_id) from peer_ai) as cohort_ai_n
    `);
    const min = input.minCohortSize;
    const cohortSize = Number(cmp?.cohort_size ?? 0);

    return {
      generatedAt: input.now.toISOString(),
      person: { id: me, displayName: person?.display_name ?? 'You' },
      enrollments: enrollments.map((e) => ({
        enrollmentId: e.enrollment_id,
        programId: e.program_id,
        programTitle: e.program_title,
        status: e.status,
        progressPercent: round1(e.progress_percent) ?? 0,
        enrolledAt: isoRequired(e.enrolled_at),
        dueAt: iso(e.due_at),
        completedAt: iso(e.completed_at),
        overdue: e.overdue,
      })),
      progressTrend,
      quizScores,
      aiScores: {
        sessions: sessions.map((s) => ({
          sessionId: s.session_id,
          evaluatedAt: isoRequired(s.evaluated_at),
          scenarioTitle: s.scenario_title,
          overallScore: round1(s.overall_score) ?? 0,
          passed: s.passed,
        })),
        categories,
      },
      comparisons: {
        cohortSize,
        minimumCohortSize: min,
        progressPercent: { mine: round1(cmp?.my_progress ?? null), cohort: this.cohort(cmp?.cohort_progress ?? null, cohortSize, min) },
        assessmentAverage: {
          mine: round1(cmp?.my_assessment ?? null),
          cohort: this.cohort(cmp?.cohort_assessment ?? null, Number(cmp?.cohort_assessment_n ?? 0), min),
        },
        aiAverage: {
          mine: round1(cmp?.my_ai ?? null),
          cohort: this.cohort(cmp?.cohort_ai ?? null, Number(cmp?.cohort_ai_n ?? 0), min),
        },
      },
    };
  }
}
