import { Injectable } from '@nestjs/common';
import type { DbOrTrx } from '../database/index.js';
import { emptyFacts, type LearnerFacts } from './progression.js';
import { ruleReferences, treeRules, type ProgramTree } from './tree.js';

export interface FactsSubject {
  userId: string;
  enrollment: { id: string; enrolled_at: Date } | null;
}

/**
 * Loads the facts the progression evaluator needs, one query per fact family. Pass the current
 * transaction so uncommitted progress in the same unit of work is visible.
 */
@Injectable()
export class FactsService {
  async load(db: DbOrTrx, tree: ProgramTree, subject: FactsSubject, now: Date = new Date()): Promise<LearnerFacts> {
    const facts = emptyFacts(now);
    facts.enrolledAt = subject.enrollment?.enrolled_at ?? null;
    const refs = ruleReferences(treeRules(tree));
    const needsSessions = refs.ruleTypes.has('ai_sessions_count') || refs.ruleTypes.has('ai_average_score');
    const enrollmentId = subject.enrollment?.id;

    const [program, progress, assessments, aiScores, aiSessions, approvals, enrollments, prerequisites, phases] = await Promise.all([
      db
        .selectFrom('programs')
        .select(['availability_starts_at', 'availability_ends_at'])
        .where('id', '=', tree.programId)
        .executeTakeFirst(),
      enrollmentId
        ? db
            .selectFrom('lesson_progress')
            .select(['lesson_id', 'status', 'percent', 'started_at', 'completed_at', 'completion_source', 'data'])
            .where('enrollment_id', '=', enrollmentId)
            .execute()
        : Promise.resolve([]),
      db.selectFrom('learner_assessment_scores').selectAll().where('user_id', '=', subject.userId).execute(),
      db.selectFrom('learner_ai_scores').selectAll().where('user_id', '=', subject.userId).execute(),
      needsSessions
        ? db
            .selectFrom('learner_ai_sessions')
            .select(['scenario_id', 'score'])
            .where('user_id', '=', subject.userId)
            .orderBy('evaluated_at', 'desc')
            .limit(1000)
            .execute()
        : Promise.resolve([]),
      enrollmentId
        ? db
            .selectFrom('approval_requests')
            .select('kind')
            .distinct()
            .where('enrollment_id', '=', enrollmentId)
            .where('status', '=', 'approved')
            .execute()
        : Promise.resolve([]),
      db
        .selectFrom('enrollments as e')
        .innerJoin('programs as p', 'p.id', 'e.program_id')
        .select(['e.program_id', 'e.status', 'e.progress_percent', 'p.title'])
        .where('e.user_id', '=', subject.userId)
        .where('e.program_id', '!=', tree.programId)
        .execute(),
      db
        .selectFrom('program_prerequisites as pp')
        .innerJoin('programs as p', 'p.id', 'pp.required_program_id')
        .select(['p.id', 'p.title'])
        .where('pp.program_id', '=', tree.programId)
        .orderBy('p.title')
        .execute(),
      enrollmentId
        ? db.selectFrom('phase_completions').select(['phase_id', 'completed_at']).where('enrollment_id', '=', enrollmentId).execute()
        : Promise.resolve([]),
    ]);

    facts.availability = {
      startsAt: program?.availability_starts_at ?? null,
      endsAt: program?.availability_ends_at ?? null,
    };
    for (const p of progress) {
      facts.progress.set(p.lesson_id, {
        status: p.status,
        percent: Number(p.percent),
        startedAt: p.started_at,
        completedAt: p.completed_at,
        source: p.completion_source,
        data: p.data ?? {},
      });
    }
    for (const a of assessments) {
      facts.assessmentScores.set(a.assessment_id, {
        bestScore: Number(a.best_score),
        lastScore: Number(a.last_score),
        passed: a.passed,
        attempts: a.attempts,
        title: a.assessment_title,
        kind: a.kind,
        lastAt: a.last_attempt_at,
      });
    }
    for (const s of aiScores) {
      facts.aiScores.set(s.scenario_id, {
        bestScore: Number(s.best_score),
        lastScore: Number(s.last_score),
        passed: s.passed,
        attempts: s.sessions,
        title: s.scenario_title,
        lastAt: s.last_session_at,
      });
    }
    facts.aiSessions = aiSessions.map((s) => ({ scenarioId: s.scenario_id, score: Number(s.score) }));
    for (const a of approvals) {
      // Manager sign-offs satisfy "manager approval"; reviewed assignments satisfy trainer / manual review.
      if (a.kind === 'manager_approval') facts.approvals.add('manager');
      else {
        facts.approvals.add('trainer');
        facts.approvals.add('manual_review');
      }
    }
    for (const e of enrollments) {
      facts.programProgress.set(e.program_id, e.status === 'completed' ? 100 : Number(e.progress_percent));
      facts.programTitles.set(e.program_id, e.title);
    }
    facts.prerequisites = prerequisites.map((p) => {
      const percent = facts.programProgress.get(p.id) ?? 0;
      const completed = enrollments.some((e) => e.program_id === p.id && e.status === 'completed');
      facts.programTitles.set(p.id, p.title);
      return { programId: p.id, title: p.title, percent, completed };
    });
    const unknownPrograms = refs.programIds.filter((id) => id !== tree.programId && !facts.programTitles.has(id));
    if (unknownPrograms.length) {
      const rows = await db.selectFrom('programs').select(['id', 'title']).where('id', 'in', unknownPrograms).execute();
      for (const r of rows) facts.programTitles.set(r.id, r.title);
    }
    for (const p of phases) facts.phaseCompletedAt.set(p.phase_id, p.completed_at);
    return facts;
  }
}
