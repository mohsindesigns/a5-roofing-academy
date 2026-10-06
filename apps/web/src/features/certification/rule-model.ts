import {
  isGroup,
  leaves,
  type AssessmentKind,
  type LeafRule,
  type LeafRuleType,
  type Rule,
} from '@a5/rules';

/** Index path from the root group to a node: `[]` is the root, `[2, 0]` its third child's first child. */
export type RulePath = readonly number[];

export interface LeafMeta {
  type: LeafRuleType;
  label: string;
  hint: string;
  group: 'Training' | 'Assessments' | 'AI practice' | 'Other';
}

/**
 * Requirement types a certification can evaluate. Approval is not listed: it follows the
 * approval policy of the certification and is added by the API.
 */
export const ADDABLE_LEAVES: readonly LeafMeta[] = [
  {
    type: 'program_completed',
    label: 'Complete a program',
    hint: 'Progress through a whole program.',
    group: 'Training',
  },
  {
    type: 'phase_completed',
    label: 'Complete a phase',
    hint: 'One week or phase of a program.',
    group: 'Training',
  },
  {
    type: 'lesson_completed',
    label: 'Complete a lesson',
    hint: 'A single lesson.',
    group: 'Training',
  },
  {
    type: 'assessment_score',
    label: 'Score on an assessment',
    hint: 'Best score on one quiz or exam.',
    group: 'Assessments',
  },
  {
    type: 'program_assessments_score',
    label: 'Score on a program’s assessments',
    hint: 'Every required assessment of a kind in a program.',
    group: 'Assessments',
  },
  {
    type: 'ai_scenario_score',
    label: 'Score on an AI scenario',
    hint: 'Best score on one role-play scenario.',
    group: 'AI practice',
  },
  {
    type: 'ai_sessions_count',
    label: 'Number of AI practice sessions',
    hint: 'Sessions completed, optionally above a score.',
    group: 'AI practice',
  },
  {
    type: 'ai_average_score',
    label: 'Average AI practice score',
    hint: 'Average over all or the latest sessions.',
    group: 'AI practice',
  },
  {
    type: 'certification_held',
    label: 'Hold another certification',
    hint: 'A prerequisite certificate.',
    group: 'Other',
  },
  {
    type: 'days_since_enrollment',
    label: 'Days since enrollment',
    hint: 'A minimum amount of time in training.',
    group: 'Other',
  },
  {
    type: 'date_reached',
    label: 'Not before a date',
    hint: 'Certification opens on a calendar date.',
    group: 'Other',
  },
];

export const LEAF_LABEL: Record<LeafRuleType, string> = {
  lesson_completed: 'Complete a lesson',
  module_completed: 'Complete a module',
  phase_completed: 'Complete a phase',
  program_completed: 'Complete a program',
  assessment_score: 'Score on an assessment',
  program_assessments_score: 'Score on a program’s assessments',
  ai_scenario_score: 'Score on an AI scenario',
  ai_sessions_count: 'Number of AI practice sessions',
  ai_average_score: 'Average AI practice score',
  approval: 'Approval',
  certification_held: 'Hold another certification',
  date_reached: 'Not before a date',
  days_since_enrollment: 'Days since enrollment',
};

export const ASSESSMENT_KINDS: ReadonlyArray<{ value: AssessmentKind; label: string }> = [
  { value: 'quiz', label: 'Quizzes' },
  { value: 'exam', label: 'Exams' },
  { value: 'final', label: 'Final assessments' },
  { value: 'practice', label: 'Practice assessments' },
];

/** A blank number: shown as an empty field and reported by `ruleProblems` until it is filled in. */
export const UNSET = Number.NaN;

/** A new requirement with no thresholds chosen. The administrator enters every number. */
export function newLeaf(type: LeafRuleType): Rule {
  switch (type) {
    case 'program_completed':
      return { type, programId: '', minPercent: 100 };
    case 'phase_completed':
      return { type, phaseId: '' };
    case 'lesson_completed':
      return { type, lessonId: '' };
    case 'module_completed':
      return { type, moduleId: '' };
    case 'assessment_score':
      return { type, assessmentId: '', minPercent: UNSET };
    case 'program_assessments_score':
      return { type, programId: '', minPercent: UNSET, kinds: ['quiz'] };
    case 'ai_scenario_score':
      return { type, scenarioId: '', minScore: UNSET };
    case 'ai_sessions_count':
      return { type, minCount: UNSET };
    case 'ai_average_score':
      return { type, minScore: UNSET };
    case 'approval':
      return { type, kind: 'manager' };
    case 'certification_held':
      return { type, certificationId: '' };
    case 'date_reached':
      return { type, date: '' };
    case 'days_since_enrollment':
      return { type, days: UNSET };
  }
}

export const emptyGroup = (type: 'all' | 'any' = 'all'): Rule => ({ type, rules: [] });

/** The editor works on a group at the root; a lone requirement becomes a one-item group. */
export function asGroup(rule: Rule): Rule {
  return isGroup(rule) ? rule : { type: 'all', rules: [rule] };
}

export function nodeAt(root: Rule, path: RulePath): Rule | undefined {
  let node: Rule | undefined = root;
  for (const i of path) {
    if (!node || !isGroup(node)) return undefined;
    node = node.rules[i];
  }
  return node;
}

function mapAt(root: Rule, path: RulePath, fn: (node: Rule) => Rule | null): Rule {
  if (path.length === 0) return fn(root) ?? root;
  if (!isGroup(root)) return root;
  const [head, ...rest] = path as [number, ...number[]];
  const rules: Rule[] = [];
  root.rules.forEach((child, i) => {
    if (i !== head) {
      rules.push(child);
      return;
    }
    if (rest.length === 0) {
      const next = fn(child);
      if (next) rules.push(next);
    } else {
      rules.push(mapAt(child, rest, fn));
    }
  });
  return { ...root, rules };
}

export function replaceAt(root: Rule, path: RulePath, node: Rule): Rule {
  return mapAt(root, path, () => node);
}

export function removeAt(root: Rule, path: RulePath): Rule {
  if (path.length === 0) return root;
  return mapAt(root, path, () => null);
}

export function appendAt(root: Rule, groupPath: RulePath, node: Rule): Rule {
  return mapAt(root, groupPath, (group) =>
    isGroup(group) ? { ...group, rules: [...group.rules, node] } : group,
  );
}

export function countLeaves(rule: Rule): number {
  return leaves(rule).length;
}

export interface RuleProblem {
  path: RulePath;
  message: string;
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const inRange = (n: unknown, min: number, max: number): boolean => isNum(n) && n >= min && n <= max;
const wholeIn = (n: unknown, min: number, max: number): boolean =>
  inRange(n, min, max) && Number.isInteger(n);

function leafProblem(rule: LeafRule): string | null {
  switch (rule.type) {
    case 'program_completed':
      if (!rule.programId) return 'Choose a program.';
      return inRange(rule.minPercent, 0, 100) ? null : 'Enter a completion between 0 and 100.';
    case 'phase_completed':
      return rule.phaseId ? null : 'Choose a phase.';
    case 'lesson_completed':
      return rule.lessonId ? null : 'Choose a lesson.';
    case 'module_completed':
      return rule.moduleId ? null : 'Choose a module.';
    case 'assessment_score':
      if (!rule.assessmentId) return 'Choose an assessment.';
      return inRange(rule.minPercent, 0, 100) ? null : 'Enter a passing score between 0 and 100.';
    case 'program_assessments_score':
      if (!rule.programId) return 'Choose a program.';
      if (rule.kinds.length === 0) return 'Choose at least one kind of assessment.';
      return inRange(rule.minPercent, 0, 100) ? null : 'Enter a passing score between 0 and 100.';
    case 'ai_scenario_score':
      if (!rule.scenarioId) return 'Choose a scenario.';
      return inRange(rule.minScore, 0, 100) ? null : 'Enter a score between 0 and 100.';
    case 'ai_sessions_count':
      if (!wholeIn(rule.minCount, 1, 1000))
        return 'Enter a number of sessions between 1 and 1,000.';
      if (rule.minScore !== undefined && !inRange(rule.minScore, 0, 100))
        return 'Enter a score between 0 and 100.';
      return null;
    case 'ai_average_score':
      if (!inRange(rule.minScore, 0, 100)) return 'Enter an average score between 0 and 100.';
      if (rule.lastN !== undefined && !wholeIn(rule.lastN, 1, 1000))
        return 'Enter a number of sessions between 1 and 1,000.';
      return null;
    case 'approval':
      return null;
    case 'certification_held':
      return rule.certificationId ? null : 'Choose a certification.';
    case 'date_reached':
      return rule.date && !Number.isNaN(Date.parse(rule.date)) ? null : 'Choose a date.';
    case 'days_since_enrollment':
      return wholeIn(rule.days, 0, 3650) ? null : 'Enter a number of days between 0 and 3,650.';
  }
}

/** Problems that would make the API reject the rule, in plain language and located by path. */
export function ruleProblems(rule: Rule, path: RulePath = []): RuleProblem[] {
  if (isGroup(rule)) {
    const own: RuleProblem[] =
      rule.type === 'any' && rule.rules.length === 0
        ? [{ path, message: 'Add at least one requirement to this group, or remove it.' }]
        : [];
    return [...own, ...rule.rules.flatMap((child, i) => ruleProblems(child, [...path, i]))];
  }
  const message = leafProblem(rule);
  return message ? [{ path, message }] : [];
}

/** Drops values that only exist while editing (blank numbers) so the rule matches the API schema. */
export function cleanRule(rule: Rule): Rule {
  if (isGroup(rule)) {
    const { label, ...rest } = rule;
    return { ...rest, ...(label ? { label } : {}), rules: rule.rules.map(cleanRule) };
  }
  const copy: Record<string, unknown> = { ...rule };
  for (const [k, v] of Object.entries(copy)) {
    if (v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v))) delete copy[k];
  }
  if (Array.isArray(copy['scenarioIds']) && copy['scenarioIds'].length === 0)
    delete copy['scenarioIds'];
  return copy as unknown as Rule;
}

/**
 * Approval requirements follow the certification's approval policy and are added by the API, so a
 * policy change removes the ones the old policy created. Empty choice groups left behind are dropped.
 */
export function stripApprovals(rule: Rule): Rule {
  if (!isGroup(rule)) return rule;
  const rules = rule.rules
    .filter((r) => r.type !== 'approval')
    .map(stripApprovals)
    .filter((r) => !(r.type === 'any' && isGroup(r) && r.rules.length === 0));
  return { ...rule, rules };
}

export function samePath(a: RulePath, b: RulePath): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
