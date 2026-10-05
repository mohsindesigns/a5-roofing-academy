import type { certification } from '@a5/contracts';
import {
  checklist,
  describeRule,
  evaluateRule,
  isGroup,
  leaves,
  type ApprovalKind,
  type Rule,
  type RuleFacts,
  type RuleLabelResolver,
  type RuleResult,
} from '@a5/rules';

type RequirementItem = certification.RequirementItem;

/** Leaf types whose facts certification projects. Others cannot be evaluated here. */
export const SUPPORTED_LEAF_TYPES = new Set<Rule['type']>([
  'program_completed',
  'assessment_score',
  'program_assessments_score',
  'ai_scenario_score',
  'ai_sessions_count',
  'ai_average_score',
  'approval',
  'certification_held',
  'date_reached',
  'days_since_enrollment',
  'lesson_completed',
  'phase_completed',
]);

export interface EligibilityOutcome {
  /** Every requirement, approvals included. */
  satisfied: boolean;
  /** Every requirement except approvals (approvals are requested once these are met). */
  autoSatisfied: boolean;
  requirements: RequirementItem[];
  metCount: number;
  totalCount: number;
}

function toItem(result: RuleResult, key: string, names: RuleLabelResolver): RequirementItem {
  return {
    key,
    type: result.rule.type,
    description: describeRule(result.rule, names),
    satisfied: result.satisfied,
    unknown: Boolean(result.unknown),
    progress: result.progress ?? null,
  };
}

/** Evaluate a rule against preloaded facts and flatten it into a checklist ("6 / 8 complete"). */
export function computeEligibility(rule: Rule, facts: RuleFacts, names: RuleLabelResolver): EligibilityOutcome {
  const result = evaluateRule(rule, facts);
  const auto = evaluateRule(rule, { ...facts, approval: () => true });
  const items = isEmptyRule(rule) ? [] : checklist(result).map((r, i) => toItem(r, String(i), names));
  return {
    satisfied: !isEmptyRule(rule) && result.satisfied,
    autoSatisfied: !isEmptyRule(rule) && auto.satisfied,
    requirements: items,
    metCount: items.filter((i) => i.satisfied).length,
    totalCount: items.length,
  };
}

/** Renewal requirements may be empty (renewal granted on approval or automatically). */
export function computeRenewalEligibility(rule: Rule, facts: RuleFacts, names: RuleLabelResolver): EligibilityOutcome {
  if (!isEmptyRule(rule)) return computeEligibility(rule, facts, names);
  return { satisfied: true, autoSatisfied: true, requirements: [], metCount: 0, totalCount: 0 };
}

export function isEmptyRule(rule: Rule): boolean {
  return isGroup(rule) && rule.type === 'all' && rule.rules.length === 0;
}

export function approvalKinds(rule: Rule): ApprovalKind[] {
  return [...new Set(leaves(rule).flatMap((l) => (l.type === 'approval' ? [l.kind] : [])))];
}

/**
 * Make the approval policy and the rule agree: a policy other than `none` must appear as an
 * approval requirement (appended when missing) and the rule may not ask for another approval kind.
 * Returns the normalized rule or a list of problems.
 */
export function normalizeApprovalRule(rule: Rule, policy: certification.ApprovalPolicy): { rule: Rule; problems: string[] } {
  const kinds = approvalKinds(rule);
  const problems: string[] = [];
  if (policy === 'none') {
    if (kinds.length) problems.push('The requirements include an approval, but the approval policy is "none". Choose an approval policy or remove the approval requirement.');
    return { rule, problems };
  }
  const other = kinds.filter((k) => k !== policy);
  if (other.length) problems.push(`The requirements ask for a ${other.join(' / ').replace('_', ' ')} approval, but the approval policy is ${policy.replace('_', ' ')}.`);
  if (kinds.includes(policy)) return { rule, problems };
  const approvalLeaf: Rule = { type: 'approval', kind: policy };
  if (rule.type === 'all') return { rule: { ...rule, rules: [...rule.rules, approvalLeaf] }, problems };
  return { rule: { type: 'all', rules: [rule, approvalLeaf] }, problems };
}

/** Leaf types in a rule that certification cannot evaluate (no projected facts). */
export function unsupportedLeafTypes(rule: Rule): string[] {
  return [...new Set(leaves(rule).map((l) => l.type).filter((t) => !SUPPORTED_LEAF_TYPES.has(t)))];
}

/** Plain-language requirement list for definitions. */
export function describeRequirements(rule: Rule, names: RuleLabelResolver): Array<{ type: string; description: string }> {
  if (isEmptyRule(rule)) return [];
  const items = rule.type === 'all' ? rule.rules : [rule];
  return items.map((r) => ({ type: r.type, description: describeRule(r, names) }));
}
