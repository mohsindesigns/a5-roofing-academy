import {
  approvalKindSchema,
  assessmentKindSchema,
  isGroup,
  leafRuleSchema,
  ruleSchema,
  type LeafRuleType,
  type Rule,
} from '@a5/rules';
import { unionBounds, type FieldBounds } from './schema-bounds';

/**
 * Editing model for unlock rules. The persisted shape and every threshold come from
 * `@a5/rules`: new requirements start from the schema's own defaults, number inputs take their
 * limits from the schema, and a rule is only saved once `ruleSchema` accepts it. This file adds
 * only what a form needs on top: labels, which kind of control each field uses, and a draft tree
 * that tolerates half-filled requirements.
 */
export type RefKind =
  'lesson' | 'module' | 'phase' | 'program' | 'assessment' | 'scenario' | 'certification';

export type FieldKind =
  | { kind: 'ref'; ref: RefKind }
  | { kind: 'refs'; ref: 'scenario' }
  | { kind: 'number' }
  | { kind: 'choice'; options: readonly string[] }
  | { kind: 'choices'; options: readonly string[] }
  | { kind: 'datetime' };

export interface FieldSpec {
  name: string;
  label: string;
  field: FieldKind;
  /** Optional fields may be left empty; the key is then omitted from the rule. */
  optional?: boolean;
  unit?: '%' | 'days' | 'sessions';
}

export interface LeafMeta {
  label: string;
  /** Heading in the "Add requirement" menu. */
  group: 'Progress' | 'Assessments' | 'AI practice' | 'Approvals and certificates' | 'Timing';
  fields: FieldSpec[];
}

/** Exhaustive over the schema's leaf types: adding a rule type to `@a5/rules` fails the build here. */
export const LEAF_META: Record<LeafRuleType, LeafMeta> = {
  lesson_completed: {
    label: 'Complete a lesson',
    group: 'Progress',
    fields: [{ name: 'lessonId', label: 'Lesson', field: { kind: 'ref', ref: 'lesson' } }],
  },
  module_completed: {
    label: 'Complete a module',
    group: 'Progress',
    fields: [{ name: 'moduleId', label: 'Module', field: { kind: 'ref', ref: 'module' } }],
  },
  phase_completed: {
    label: 'Complete a phase',
    group: 'Progress',
    fields: [{ name: 'phaseId', label: 'Phase', field: { kind: 'ref', ref: 'phase' } }],
  },
  program_completed: {
    label: 'Reach progress in a program',
    group: 'Progress',
    fields: [
      { name: 'programId', label: 'Program', field: { kind: 'ref', ref: 'program' } },
      { name: 'minPercent', label: 'Minimum progress', field: { kind: 'number' }, unit: '%' },
    ],
  },
  assessment_score: {
    label: 'Score on an assessment',
    group: 'Assessments',
    fields: [
      { name: 'assessmentId', label: 'Assessment', field: { kind: 'ref', ref: 'assessment' } },
      { name: 'minPercent', label: 'Minimum score', field: { kind: 'number' }, unit: '%' },
    ],
  },
  program_assessments_score: {
    label: "Score across a program's assessments",
    group: 'Assessments',
    fields: [
      { name: 'programId', label: 'Program', field: { kind: 'ref', ref: 'program' } },
      { name: 'minPercent', label: 'Minimum score on each', field: { kind: 'number' }, unit: '%' },
      {
        name: 'kinds',
        label: 'Assessment types',
        field: { kind: 'choices', options: assessmentKindSchema.options },
      },
    ],
  },
  ai_scenario_score: {
    label: 'Score on an AI scenario',
    group: 'AI practice',
    fields: [
      { name: 'scenarioId', label: 'Scenario', field: { kind: 'ref', ref: 'scenario' } },
      { name: 'minScore', label: 'Minimum score', field: { kind: 'number' } },
    ],
  },
  ai_sessions_count: {
    label: 'Complete AI role-plays',
    group: 'AI practice',
    fields: [
      {
        name: 'minCount',
        label: 'Number of sessions',
        field: { kind: 'number' },
        unit: 'sessions',
      },
      {
        name: 'minScore',
        label: 'Minimum score per session',
        field: { kind: 'number' },
        optional: true,
      },
      {
        name: 'scenarioIds',
        label: 'Only these scenarios',
        field: { kind: 'refs', ref: 'scenario' },
        optional: true,
      },
    ],
  },
  ai_average_score: {
    label: 'Average AI role-play score',
    group: 'AI practice',
    fields: [
      { name: 'minScore', label: 'Minimum average', field: { kind: 'number' } },
      {
        name: 'lastN',
        label: 'Average over the latest sessions',
        field: { kind: 'number' },
        optional: true,
        unit: 'sessions',
      },
      {
        name: 'scenarioIds',
        label: 'Only these scenarios',
        field: { kind: 'refs', ref: 'scenario' },
        optional: true,
      },
    ],
  },
  approval: {
    label: 'Get an approval',
    group: 'Approvals and certificates',
    fields: [
      {
        name: 'kind',
        label: 'Approved by',
        field: { kind: 'choice', options: approvalKindSchema.options },
      },
    ],
  },
  certification_held: {
    label: 'Hold a certification',
    group: 'Approvals and certificates',
    fields: [
      {
        name: 'certificationId',
        label: 'Certification',
        field: { kind: 'ref', ref: 'certification' },
      },
    ],
  },
  date_reached: {
    label: 'Wait until a date',
    group: 'Timing',
    fields: [{ name: 'date', label: 'Available from', field: { kind: 'datetime' } }],
  },
  days_since_enrollment: {
    label: 'Wait after enrollment',
    group: 'Timing',
    fields: [
      { name: 'days', label: 'Days after enrollment', field: { kind: 'number' }, unit: 'days' },
    ],
  },
};

export const LEAF_TYPES = Object.keys(LEAF_META) as LeafRuleType[];

export const LEAF_GROUPS: LeafMeta['group'][] = [
  'Progress',
  'Assessments',
  'AI practice',
  'Approvals and certificates',
  'Timing',
];

/** Limits per leaf type and field, from the `@a5/rules` schema. */
export const RULE_BOUNDS = unionBounds(leafRuleSchema, 'type');

export function boundsFor(type: LeafRuleType, field: string): FieldBounds | undefined {
  return RULE_BOUNDS[type]?.[field];
}

// ------------------------------------------------------------------ draft tree

export interface DraftGroup {
  uid: string;
  type: 'all' | 'any';
  label?: string;
  rules: DraftNode[];
}
export interface DraftLeaf {
  uid: string;
  type: LeafRuleType;
  /** Field values as the form holds them (numbers may be empty strings while typing). */
  values: Record<string, unknown>;
}
export type DraftNode = DraftGroup | DraftLeaf;

export function isDraftGroup(n: DraftNode): n is DraftGroup {
  return n.type === 'all' || n.type === 'any';
}

let counter = 0;
const uid = () => `n${++counter}`;

export function emptyGroup(type: 'all' | 'any' = 'all'): DraftGroup {
  return { uid: uid(), type, rules: [] };
}

/** A new requirement. Only values the schema itself defaults are filled in. */
export function newLeaf(type: LeafRuleType): DraftLeaf {
  const values: Record<string, unknown> = {};
  for (const spec of LEAF_META[type].fields) {
    const def = boundsFor(type, spec.name)?.default;
    if (def !== undefined) values[spec.name] = def;
    else if (spec.field.kind === 'choices') {
      // Required lists start from the schema default when it has one (kinds → ['quiz']).
      values[spec.name] = [];
    }
  }
  return { uid: uid(), type, values };
}

export function toDraft(rule: Rule | null | undefined): DraftGroup {
  const convert = (r: Rule): DraftNode => {
    if (isGroup(r)) {
      return {
        uid: uid(),
        type: r.type,
        ...(r.label ? { label: r.label } : {}),
        rules: r.rules.map(convert),
      };
    }
    const { type, ...values } = r as unknown as { type: LeafRuleType } & Record<string, unknown>;
    return { uid: uid(), type, values };
  };
  if (!rule) return emptyGroup('all');
  const node = convert(rule);
  return isDraftGroup(node) ? node : { uid: uid(), type: 'all', rules: [node] };
}

function leafToRule(leaf: DraftLeaf): Record<string, unknown> {
  const out: Record<string, unknown> = { type: leaf.type };
  for (const spec of LEAF_META[leaf.type].fields) {
    const v = leaf.values[spec.name];
    const empty =
      v === undefined ||
      v === null ||
      v === '' ||
      (Array.isArray(v) && v.length === 0 && spec.optional);
    if (empty) continue;
    if (spec.field.kind === 'number') out[spec.name] = typeof v === 'number' ? v : Number(v);
    else out[spec.name] = v;
  }
  if (typeof leaf.values.label === 'string' && leaf.values.label.trim())
    out.label = leaf.values.label.trim();
  return out;
}

function nodeToRule(n: DraftNode): unknown {
  if (isDraftGroup(n)) {
    return {
      type: n.type,
      rules: n.rules.map(nodeToRule),
      ...(n.label?.trim() ? { label: n.label.trim() } : {}),
    };
  }
  return leafToRule(n);
}

/**
 * The rule to save. An empty "all of" at the top means "no explicit rule" (null), and a group with
 * a single requirement collapses to that requirement.
 */
export function fromDraft(root: DraftGroup): unknown | null {
  if (root.type === 'all' && root.rules.length === 0 && !root.label?.trim()) return null;
  if (root.rules.length === 1 && !root.label?.trim()) return nodeToRule(root.rules[0]!);
  return nodeToRule(root);
}

// ------------------------------------------------------------------ validation

function limitText(b: FieldBounds | undefined, unit: string): string | undefined {
  if (!b) return undefined;
  if (b.min !== undefined && b.max !== undefined)
    return `between ${b.min}${unit} and ${b.max}${unit}`;
  if (b.min !== undefined) return `at least ${b.min}${unit}`;
  if (b.max !== undefined) return `at most ${b.max}${unit}`;
  return undefined;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

function fieldMessage(
  type: LeafRuleType,
  name: string,
  issue: { code: string; message: string },
): string {
  const spec = LEAF_META[type].fields.find((f) => f.name === name);
  const label = spec?.label ?? name;
  const bounds = boundsFor(type, name);
  if (issue.code === 'invalid_type' || issue.code === 'invalid_value') {
    if (spec?.field.kind === 'ref') return `Choose ${article(label)} ${label.toLowerCase()}.`;
    if (spec?.field.kind === 'number') return `Enter ${label.toLowerCase()}.`;
    return `${label} is required.`;
  }
  if (issue.code === 'too_small' || issue.code === 'too_big') {
    if (spec?.field.kind === 'choices' || spec?.field.kind === 'refs')
      return `Choose at least one ${label.toLowerCase()}.`;
    const limit = limitText(bounds, spec?.unit === '%' ? '%' : '');
    if (limit) return `${label} must be ${limit}.`;
  }
  if (issue.code === 'invalid_format') {
    return spec?.field.kind === 'ref'
      ? `Choose ${article(label)} ${label.toLowerCase()}.`
      : `${label} is not valid.`;
  }
  return `${label}: ${issue.message}`;
}

/** Problems per node uid, in words a content editor can act on. Empty map = valid. */
export function validateDraft(root: DraftGroup): Map<string, string[]> {
  const problems = new Map<string, string[]>();
  const add = (id: string, message: string) =>
    problems.set(id, [...(problems.get(id) ?? []), message]);
  const visit = (n: DraftNode) => {
    if (isDraftGroup(n)) {
      if (n.type === 'any' && n.rules.length === 0)
        add(n.uid, 'Add at least one requirement, or remove this group.');
      n.rules.forEach(visit);
      return;
    }
    const parsed = leafRuleSchema.safeParse(leafToRule(n));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const name = String(issue.path[0] ?? '');
        if (name === 'type') continue;
        add(n.uid, fieldMessage(n.type, name, issue));
      }
    }
  };
  visit(root);
  // The whole tree must also satisfy the persisted schema (depth, sizes).
  if (problems.size === 0) {
    const whole = fromDraft(root);
    if (whole !== null && !ruleSchema.safeParse(whole).success)
      add(root.uid, 'This rule is not valid.');
  }
  return problems;
}

/** Number of requirements (leaves) in a draft. */
export function countRequirements(n: DraftNode): number {
  return isDraftGroup(n) ? n.rules.reduce((sum, r) => sum + countRequirements(r), 0) : 1;
}

// ------------------------------------------------------------------ immutable updates

export function updateNode(
  root: DraftGroup,
  id: string,
  change: (n: DraftNode) => DraftNode,
): DraftGroup {
  const walk = (n: DraftNode): DraftNode => {
    if (n.uid === id) return change(n);
    return isDraftGroup(n) ? { ...n, rules: n.rules.map(walk) } : n;
  };
  return walk(root) as DraftGroup;
}

export function removeNode(root: DraftGroup, id: string): DraftGroup {
  const walk = (n: DraftGroup): DraftGroup => ({
    ...n,
    rules: n.rules.filter((r) => r.uid !== id).map((r) => (isDraftGroup(r) ? walk(r) : r)),
  });
  return walk(root);
}

export function addChild(root: DraftGroup, groupId: string, child: DraftNode): DraftGroup {
  return updateNode(root, groupId, (n) =>
    isDraftGroup(n) ? { ...n, rules: [...n.rules, child] } : n,
  ) as DraftGroup;
}
