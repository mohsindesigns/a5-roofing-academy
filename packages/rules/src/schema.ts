import { z } from 'zod';

/**
 * Rule trees describe unlock conditions (learning) and eligibility requirements (certification).
 * Every threshold is a parameter of a rule; nothing is hard-coded in evaluators.
 */
const uuid = z.uuid();
const percent = z.number().min(0).max(100);
const label = z.string().trim().min(1).max(200).optional();

export const assessmentKindSchema = z.enum(['quiz', 'exam', 'final', 'practice']);
export type AssessmentKind = z.infer<typeof assessmentKindSchema>;

export const approvalKindSchema = z.enum(['manager', 'trainer', 'manual_review']);
export type ApprovalKind = z.infer<typeof approvalKindSchema>;

export const leafRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('lesson_completed'), lessonId: uuid, label }),
  z.object({ type: z.literal('module_completed'), moduleId: uuid, label }),
  z.object({ type: z.literal('phase_completed'), phaseId: uuid, label }),
  z.object({
    type: z.literal('program_completed'),
    programId: uuid,
    minPercent: percent.default(100),
    label,
  }),
  z.object({
    type: z.literal('assessment_score'),
    assessmentId: uuid,
    minPercent: percent,
    label,
  }),
  z.object({
    type: z.literal('program_assessments_score'),
    programId: uuid,
    minPercent: percent,
    kinds: z.array(assessmentKindSchema).min(1).default(['quiz']),
    label,
  }),
  z.object({
    type: z.literal('ai_scenario_score'),
    scenarioId: uuid,
    minScore: percent,
    label,
  }),
  z.object({
    type: z.literal('ai_sessions_count'),
    minCount: z.int().min(1).max(1000),
    minScore: percent.optional(),
    scenarioIds: z.array(uuid).optional(),
    label,
  }),
  z.object({
    type: z.literal('ai_average_score'),
    minScore: percent,
    scenarioIds: z.array(uuid).optional(),
    /** Average over the most recent N scored sessions. Omit for all sessions. */
    lastN: z.int().min(1).max(1000).optional(),
    label,
  }),
  z.object({ type: z.literal('approval'), kind: approvalKindSchema, label }),
  z.object({ type: z.literal('certification_held'), certificationId: uuid, label }),
  z.object({ type: z.literal('date_reached'), date: z.iso.datetime({ offset: true }), label }),
  z.object({
    type: z.literal('days_since_enrollment'),
    days: z.int().min(0).max(3650),
    label,
  }),
]);

export type LeafRule = z.infer<typeof leafRuleSchema>;
export type LeafRuleType = LeafRule['type'];

export type Rule =
  | { type: 'all'; rules: Rule[]; label?: string | undefined }
  | { type: 'any'; rules: Rule[]; label?: string | undefined }
  | LeafRule;

export const ruleSchema: z.ZodType<Rule> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('all'), rules: z.array(ruleSchema).max(100), label }),
    z.object({ type: z.literal('any'), rules: z.array(ruleSchema).min(1).max(100), label }),
    leafRuleSchema,
  ]),
) as z.ZodType<Rule>;

export function isGroup(rule: Rule): rule is Extract<Rule, { type: 'all' | 'any' }> {
  return rule.type === 'all' || rule.type === 'any';
}

/** Collect every leaf rule in a tree (depth-first). */
export function leaves(rule: Rule): LeafRule[] {
  return isGroup(rule) ? rule.rules.flatMap(leaves) : [rule];
}

export const EMPTY_RULE: Rule = { type: 'all', rules: [] };
