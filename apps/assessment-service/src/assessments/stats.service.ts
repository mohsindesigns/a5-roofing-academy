import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { assessment } from '@a5/contracts';
import { sql } from '@a5/database';
import { InjectDb, NotFoundError } from '@a5/nest-kit';
import type { Db } from '../database/index.js';
import { round2 } from '../engine/question-types.js';

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : round2(Number(v));

/** Assessment analytics computed from attempts (effective scores include overrides). */
@Injectable()
export class StatsService {
  constructor(@InjectDb() private readonly db: Db) {}

  async stats(
    p: Principal,
    assessmentId: string,
    hardestLimit = 10,
  ): Promise<assessment.AssessmentStats> {
    const exists = await this.db
      .selectFrom('assessments')
      .select('id')
      .where('id', '=', assessmentId)
      .where('organization_id', '=', p.organizationId)
      .executeTakeFirst();
    if (!exists) throw new NotFoundError('Assessment');

    const effective = sql`
      select a.id, a.user_id, a.status, a.attempt_number, a.auto_submitted, a.started_at, a.submitted_at,
        coalesce(o.new_score_percent, a.score_percent) as score,
        coalesce(o.new_passed, a.passed) as passed
      from attempts a
      left join lateral (
        select so.new_score_percent, so.new_passed from score_overrides so
        where so.attempt_id = a.id order by so.created_at desc, so.id desc limit 1
      ) o on true
      where a.assessment_id = ${assessmentId} and a.organization_id = ${p.organizationId}
    `;

    const summary = await sql<{
      total: number;
      in_progress: number;
      pending_review: number;
      graded: number;
      auto_submitted: number;
      learners: number;
      average: number | null;
      median: number | null;
      pass_rate: number | null;
      first_pass_rate: number | null;
      avg_duration: number | null;
    }>`
      with eff as (${effective})
      select
        count(*)::int as total,
        count(*) filter (where status = 'in_progress')::int as in_progress,
        count(*) filter (where status = 'pending_review')::int as pending_review,
        count(*) filter (where status = 'graded')::int as graded,
        count(*) filter (where auto_submitted)::int as auto_submitted,
        count(distinct user_id)::int as learners,
        avg(score) filter (where status = 'graded') as average,
        percentile_cont(0.5) within group (order by score) filter (where status = 'graded') as median,
        avg(case when passed then 100.0 else 0 end) filter (where status = 'graded') as pass_rate,
        avg(case when passed then 100.0 else 0 end) filter (where status = 'graded' and attempt_number = 1) as first_pass_rate,
        avg(extract(epoch from submitted_at - started_at)) filter (where submitted_at is not null) as avg_duration
      from eff
    `.execute(this.db);
    const s = summary.rows[0]!;

    const buckets = await sql<{ bucket: number; count: number }>`
      with eff as (${effective})
      select least(width_bucket(score, 0, 100, 10), 10)::int as bucket, count(*)::int as count
      from eff where status = 'graded' group by 1
    `.execute(this.db);
    const byBucket = new Map(buckets.rows.map((b) => [Number(b.bucket), Number(b.count)]));

    const hardest = await sql<{
      question_id: string;
      answered: number;
      correct_rate: number;
      score_ratio: number;
      prompt: string;
      type: assessment.QuestionType;
      difficulty: assessment.Difficulty;
      category_id: string | null;
      category_name: string | null;
    }>`
      select r.question_id, r.answered, r.correct_rate, r.score_ratio,
        v.prompt, v.type, v.difficulty, c.id as category_id, c.name as category_name
      from (
        select aq.question_id,
          count(*)::int as answered,
          avg(case when aa.is_correct then 100.0 else 0 end) as correct_rate,
          avg(coalesce(aa.awarded_points, 0) / aq.points) as score_ratio
        from attempt_answers aa
        join attempt_questions aq on aq.id = aa.attempt_question_id
        join attempts a on a.id = aa.attempt_id
        where a.assessment_id = ${assessmentId} and a.organization_id = ${p.organizationId} and a.status = 'graded'
        group by aq.question_id
      ) r
      join questions q on q.id = r.question_id
      join question_versions v on v.id = q.current_version_id
      left join question_categories c on c.id = v.category_id
      order by r.correct_rate asc, r.score_ratio asc, r.answered desc, r.question_id
      limit ${hardestLimit}
    `.execute(this.db);

    return {
      assessmentId,
      attempts: {
        total: Number(s.total),
        inProgress: Number(s.in_progress),
        pendingReview: Number(s.pending_review),
        graded: Number(s.graded),
        autoSubmitted: Number(s.auto_submitted),
      },
      learners: Number(s.learners),
      passRate: num(s.pass_rate),
      firstAttemptPassRate: num(s.first_pass_rate),
      averageScorePercent: num(s.average),
      medianScorePercent: num(s.median),
      averageDurationSeconds: s.avg_duration === null ? null : Math.round(Number(s.avg_duration)),
      // Buckets are [from, to); the last one includes 100.
      scoreDistribution: Array.from({ length: 10 }, (_, i) => ({
        from: i * 10,
        to: (i + 1) * 10,
        count: byBucket.get(i + 1) ?? 0,
      })),
      hardestQuestions: hardest.rows.map((h) => ({
        questionId: h.question_id,
        prompt: h.prompt,
        type: h.type,
        difficulty: h.difficulty,
        category: h.category_id ? { id: h.category_id, name: h.category_name! } : null,
        answered: Number(h.answered),
        correctRate: round2(Number(h.correct_rate)),
        averageScoreRatio: round2(Number(h.score_ratio)),
      })),
    };
  }
}
