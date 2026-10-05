import { leaves, type Rule, type RuleLabelResolver } from '@a5/rules';
import type { DbOrTrx } from '../database/index.js';

interface ReferencedIds {
  programs: Set<string>;
  assessments: Set<string>;
  scenarios: Set<string>;
  certifications: Set<string>;
  lessons: Set<string>;
  phases: Set<string>;
}

export function referencedIds(rules: readonly Rule[]): ReferencedIds {
  const ids: ReferencedIds = {
    programs: new Set(),
    assessments: new Set(),
    scenarios: new Set(),
    certifications: new Set(),
    lessons: new Set(),
    phases: new Set(),
  };
  for (const leaf of rules.flatMap(leaves)) {
    switch (leaf.type) {
      case 'program_completed':
      case 'program_assessments_score':
        ids.programs.add(leaf.programId);
        break;
      case 'assessment_score':
        ids.assessments.add(leaf.assessmentId);
        break;
      case 'ai_scenario_score':
        ids.scenarios.add(leaf.scenarioId);
        break;
      case 'ai_sessions_count':
      case 'ai_average_score':
        for (const s of leaf.scenarioIds ?? []) ids.scenarios.add(s);
        break;
      case 'certification_held':
        ids.certifications.add(leaf.certificationId);
        break;
      case 'lesson_completed':
        ids.lessons.add(leaf.lessonId);
        break;
      case 'phase_completed':
        ids.phases.add(leaf.phaseId);
        break;
      default:
        break;
    }
  }
  return ids;
}

/** Programs whose assessment map a rule needs (program_assessments_score leaves). */
export function assessmentProgramIds(rule: Rule): string[] {
  return [...new Set(leaves(rule).flatMap((l) => (l.type === 'program_assessments_score' ? [l.programId] : [])))];
}

/**
 * Display names for rule descriptions, resolved from local projections (program catalog,
 * program assessment maps, AI results, milestones and certification definitions).
 */
export async function loadRuleNames(db: DbOrTrx, rules: readonly Rule[]): Promise<RuleLabelResolver> {
  const ids = referencedIds(rules);
  const [programs, assessments, scenarios, certifications, lessons] = await Promise.all([
    ids.programs.size || ids.phases.size
      ? db.selectFrom('program_catalog').select(['program_id', 'title', 'phases']).execute()
      : Promise.resolve([]),
    ids.assessments.size
      ? db
          .selectFrom('program_assessments')
          .select(['assessment_id', 'title'])
          .where('assessment_id', 'in', [...ids.assessments])
          .union(
            db
              .selectFrom('learner_assessment_results')
              .select(['assessment_id', 'title'])
              .where('assessment_id', 'in', [...ids.assessments]),
          )
          .execute()
      : Promise.resolve([]),
    ids.scenarios.size
      ? db
          .selectFrom('learner_ai_results')
          .select(['scenario_id', 'scenario_title'])
          .distinct()
          .where('scenario_id', 'in', [...ids.scenarios])
          .execute()
      : Promise.resolve([]),
    ids.certifications.size
      ? db.selectFrom('certification_definitions').select(['id', 'name']).where('id', 'in', [...ids.certifications]).execute()
      : Promise.resolve([]),
    ids.lessons.size
      ? db
          .selectFrom('learner_milestones')
          .select(['ref_id', 'title'])
          .distinct()
          .where('kind', '=', 'lesson')
          .where('ref_id', 'in', [...ids.lessons])
          .execute()
      : Promise.resolve([]),
  ]);
  const programNames = new Map(programs.map((p) => [p.program_id, p.title]));
  const phaseNames = new Map(programs.flatMap((p) => p.phases.map((ph) => [ph.phaseId, ph.title] as const)));
  const assessmentNames = new Map(assessments.map((a) => [a.assessment_id, a.title]));
  const scenarioNames = new Map(scenarios.map((s) => [s.scenario_id, s.scenario_title]));
  const certificationNames = new Map(certifications.map((c) => [c.id, c.name]));
  const lessonNames = new Map(lessons.filter((l) => l.title).map((l) => [l.ref_id, l.title!]));
  return {
    program: (id) => programNames.get(id),
    phase: (id) => phaseNames.get(id),
    assessment: (id) => assessmentNames.get(id),
    scenario: (id) => scenarioNames.get(id),
    certification: (id) => certificationNames.get(id),
    lesson: (id) => lessonNames.get(id),
  };
}
