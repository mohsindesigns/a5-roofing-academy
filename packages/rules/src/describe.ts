import type { Rule } from './schema.js';

/** Resolves entity ids to display names. Missing names fall back to generic wording. */
export interface RuleLabelResolver {
  lesson?(id: string): string | undefined;
  module?(id: string): string | undefined;
  phase?(id: string): string | undefined;
  program?(id: string): string | undefined;
  assessment?(id: string): string | undefined;
  scenario?(id: string): string | undefined;
  certification?(id: string): string | undefined;
}

const kindsLabel: Record<string, string> = {
  quiz: 'quizzes',
  exam: 'exams',
  final: 'final assessments',
  practice: 'practice assessments',
};

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function scenarioScope(ids: readonly string[] | undefined, names: RuleLabelResolver): string {
  if (!ids || ids.length === 0) return 'AI role-plays';
  const resolved = ids.map((id) => names.scenario?.(id) ?? 'selected scenario');
  return ids.length === 1 ? `"${resolved[0]}" role-plays` : `role-plays in ${list(resolved)}`;
}

/** Human readable sentence for a rule. Labels set by administrators always win. */
export function describeRule(rule: Rule, names: RuleLabelResolver = {}): string {
  if (rule.label) return rule.label;
  switch (rule.type) {
    case 'all':
      return rule.rules.length === 0
        ? 'No requirements'
        : list(rule.rules.map((r) => describeRule(r, names)));
    case 'any':
      return `One of: ${rule.rules.map((r) => describeRule(r, names)).join(' / ')}`;
    case 'lesson_completed':
      return `Complete ${quote(names.lesson?.(rule.lessonId)) ?? 'the required lesson'}`;
    case 'module_completed':
      return `Complete ${quote(names.module?.(rule.moduleId)) ?? 'the required module'}`;
    case 'phase_completed':
      return `Complete ${names.phase?.(rule.phaseId) ?? 'the previous phase'}`;
    case 'program_completed': {
      const name = names.program?.(rule.programId) ?? 'the program';
      return rule.minPercent >= 100 ? `Complete ${name}` : `Reach ${rule.minPercent}% of ${name}`;
    }
    case 'assessment_score':
      return `Score ${rule.minPercent}% or higher on ${quote(names.assessment?.(rule.assessmentId)) ?? 'the assessment'}`;
    case 'program_assessments_score': {
      const what = list(rule.kinds.map((k) => kindsLabel[k] ?? k));
      const program = names.program?.(rule.programId) ?? 'the program';
      return `Score ${rule.minPercent}% or higher on every required ${what} in ${program}`;
    }
    case 'ai_scenario_score':
      return `Score ${rule.minScore} or higher on ${quote(names.scenario?.(rule.scenarioId)) ?? 'the AI scenario'}`;
    case 'ai_sessions_count': {
      const scope = scenarioScope(rule.scenarioIds, names);
      const min = rule.minScore !== undefined ? ` scoring ${rule.minScore}+` : '';
      return `Complete ${rule.minCount} ${scope}${min}`;
    }
    case 'ai_average_score': {
      const scope = scenarioScope(rule.scenarioIds, names);
      const window = rule.lastN ? ` (last ${rule.lastN})` : '';
      return `Average ${rule.minScore} or higher across ${scope}${window}`;
    }
    case 'approval':
      return rule.kind === 'manager'
        ? 'Manager approval'
        : rule.kind === 'trainer'
          ? 'Trainer approval'
          : 'Manual review';
    case 'certification_held':
      return `Hold ${names.certification?.(rule.certificationId) ?? 'the prerequisite certification'}`;
    case 'date_reached':
      return `Available from ${new Date(rule.date).toLocaleDateString('en-US', { dateStyle: 'medium' })}`;
    case 'days_since_enrollment':
      return `${rule.days} days after enrollment`;
  }
}

function quote(value: string | undefined): string | undefined {
  return value === undefined ? undefined : `"${value}"`;
}
