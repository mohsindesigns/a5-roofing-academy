import type { ApprovalKind, AssessmentKind, RuleFacts } from '@a5/rules';
import type { DbOrTrx } from '../database/index.js';

export interface FactsScope {
  userId: string;
  /** Candidate whose approvals count (approvals are per candidate and cycle). */
  candidateId: string | null;
  cycle: number;
  /** Renewal evaluations only count activity on or after this instant. */
  since: Date | null;
  now: Date;
  /** Programs associated with the certification (for days-since-enrollment). */
  programIds: readonly string[];
  /** Programs referenced by program-assessment requirements of the rule being evaluated. */
  referencedProgramIds: readonly string[];
}

/**
 * Preloads every fact family for one learner (one query each) and exposes them synchronously to the
 * rule evaluator. Facts come only from local projections, so evaluation never calls other services.
 */
export async function loadFacts(db: DbOrTrx, scope: FactsScope): Promise<RuleFacts> {
  const { userId, since } = scope;
  const [programs, assessments, aiResults, milestones, approvals, held] = await Promise.all([
    db
      .selectFrom('learner_program_status')
      .select(['program_id', 'status', 'progress_percent', 'enrolled_at', 'completed_at'])
      .where('user_id', '=', userId)
      .execute(),
    (() => {
      let q = db
        .selectFrom('learner_assessment_results')
        .select(['assessment_id', (eb) => eb.fn.max('score_percent').as('best')])
        .where('user_id', '=', userId)
        .groupBy('assessment_id');
      if (since) q = q.where('graded_at', '>=', since);
      return q.execute();
    })(),
    (() => {
      let q = db
        .selectFrom('learner_ai_results')
        .select(['scenario_id', 'overall_score'])
        .where('user_id', '=', userId)
        .orderBy('evaluated_at', 'desc')
        .orderBy('session_id', 'desc');
      if (since) q = q.where('evaluated_at', '>=', since);
      return q.execute();
    })(),
    (() => {
      let q = db
        .selectFrom('learner_milestones')
        .select(['kind', 'ref_id'])
        .where('user_id', '=', userId);
      if (since) q = q.where('completed_at', '>=', since);
      return q.execute();
    })(),
    scope.candidateId
      ? db
          .selectFrom('certificate_approvals')
          .select('kind')
          .where('candidate_id', '=', scope.candidateId)
          .where('cycle', '=', scope.cycle)
          .where('status', '=', 'approved')
          .execute()
      : Promise.resolve([] as Array<{ kind: ApprovalKind }>),
    db
      .selectFrom('issued_certificates')
      .select('definition_id')
      .where('user_id', '=', userId)
      .where('status', '=', 'issued')
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', scope.now)]))
      .execute(),
  ]);

  const programRows = new Map(programs.map((p) => [p.program_id, p]));
  const best = new Map(
    assessments.map((a) => [a.assessment_id, a.best === null ? null : Number(a.best)]),
  );
  const lessonsDone = new Set(milestones.filter((m) => m.kind === 'lesson').map((m) => m.ref_id));
  const phasesDone = new Set(milestones.filter((m) => m.kind === 'phase').map((m) => m.ref_id));
  const approved = new Set(approvals.map((a) => a.kind));
  const heldDefinitions = new Set(held.map((h) => h.definition_id));
  const sessions = aiResults.map((r) => ({
    scenarioId: r.scenario_id,
    score: Number(r.overall_score),
  }));

  // Program assessment requirement maps are loaded lazily per program (rarely more than one).
  const programAssessments = await loadProgramAssessments(db, [
    ...new Set([...programRows.keys(), ...scope.referencedProgramIds]),
  ]);

  return {
    programProgress(programId) {
      const row = programRows.get(programId);
      if (!row || row.status === 'withdrawn') return null;
      if (since) {
        if (row.completed_at && row.completed_at >= since) return 100;
        if (row.enrolled_at && row.enrolled_at >= since) return Number(row.progress_percent);
        return null;
      }
      return row.completed_at ? 100 : Number(row.progress_percent);
    },
    assessmentBestScore: (assessmentId) => best.get(assessmentId) ?? null,
    programAssessments(programId, kinds: readonly AssessmentKind[]) {
      return (programAssessments.get(programId) ?? [])
        .filter((a) => a.required && kinds.includes(a.kind))
        .map((a) => ({
          assessmentId: a.assessment_id,
          bestScore: best.get(a.assessment_id) ?? null,
        }));
    },
    aiScenarioBestScore(scenarioId) {
      const scores = sessions.filter((s) => s.scenarioId === scenarioId).map((s) => s.score);
      return scores.length ? Math.max(...scores) : null;
    },
    aiSessions(scenarioIds) {
      return scenarioIds && scenarioIds.length
        ? sessions.filter((s) => scenarioIds.includes(s.scenarioId))
        : sessions;
    },
    approval: (kind) => approved.has(kind),
    certificationHeld: (definitionId) => heldDefinitions.has(definitionId),
    lessonCompleted: (lessonId) => lessonsDone.has(lessonId),
    phaseCompleted: (phaseId) => phasesDone.has(phaseId),
    enrolledAt() {
      const dates = scope.programIds
        .map((id) => programRows.get(id))
        .filter((r): r is NonNullable<typeof r> =>
          Boolean(r && r.status !== 'withdrawn' && r.enrolled_at),
        )
        .map((r) => r.enrolled_at!.getTime());
      if (dates.length === 0) {
        const all = programs
          .filter((r) => r.enrolled_at && r.status !== 'withdrawn')
          .map((r) => r.enrolled_at!.getTime());
        return all.length ? new Date(Math.min(...all)) : null;
      }
      return new Date(Math.min(...dates));
    },
    now: () => scope.now,
  };
}

async function loadProgramAssessments(db: DbOrTrx, programIds: string[]) {
  const map = new Map<
    string,
    Array<{ assessment_id: string; kind: AssessmentKind; required: boolean }>
  >();
  if (programIds.length === 0) return map;
  const rows = await db
    .selectFrom('program_assessments')
    .select(['program_id', 'assessment_id', 'kind', 'required'])
    .where('program_id', 'in', programIds)
    .execute();
  for (const r of rows) {
    const list = map.get(r.program_id) ?? [];
    list.push({ assessment_id: r.assessment_id, kind: r.kind, required: r.required });
    map.set(r.program_id, list);
  }
  return map;
}
