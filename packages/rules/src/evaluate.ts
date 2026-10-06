import {
  isGroup,
  type ApprovalKind,
  type AssessmentKind,
  type LeafRule,
  type Rule,
} from './schema.js';

/**
 * Facts available to the evaluator. Callers preload facts (one query per fact family) and expose
 * them synchronously; evaluation itself is pure and cheap. A missing provider means the fact is
 * unknown in this context, and the requirement evaluates as unmet with `unknown: true`.
 */
export interface RuleFacts {
  lessonCompleted?(lessonId: string): boolean;
  moduleCompleted?(moduleId: string): boolean;
  phaseCompleted?(phaseId: string): boolean;
  /** Percent complete (0-100) of a program for the subject, or null when not enrolled. */
  programProgress?(programId: string): number | null;
  /** Best score percent for an assessment, or null when never graded. */
  assessmentBestScore?(assessmentId: string): number | null;
  /** Required assessments of a program with the subject's best scores. */
  programAssessments?(
    programId: string,
    kinds: readonly AssessmentKind[],
  ): Array<{ assessmentId: string; bestScore: number | null }>;
  aiScenarioBestScore?(scenarioId: string): number | null;
  /** Scored AI sessions, newest first. */
  aiSessions?(scenarioIds?: readonly string[]): Array<{ scenarioId: string; score: number }>;
  approval?(kind: ApprovalKind): boolean;
  certificationHeld?(certificationId: string): boolean;
  enrolledAt?(): Date | null;
  now?(): Date;
}

export interface RuleProgress {
  current: number;
  target: number;
  unit: 'percent' | 'count' | 'days' | 'boolean';
}

export interface RuleResult {
  rule: Rule;
  satisfied: boolean;
  /** True when the facts needed to evaluate this rule were not available. */
  unknown?: boolean;
  progress?: RuleProgress;
  children?: RuleResult[];
}

const bool = (satisfied: boolean): RuleProgress => ({
  current: satisfied ? 1 : 0,
  target: 1,
  unit: 'boolean',
});

function unknown(rule: Rule): RuleResult {
  return { rule, satisfied: false, unknown: true };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function evaluateLeaf(rule: LeafRule, facts: RuleFacts): RuleResult {
  switch (rule.type) {
    case 'lesson_completed': {
      if (!facts.lessonCompleted) return unknown(rule);
      const ok = facts.lessonCompleted(rule.lessonId);
      return { rule, satisfied: ok, progress: bool(ok) };
    }
    case 'module_completed': {
      if (!facts.moduleCompleted) return unknown(rule);
      const ok = facts.moduleCompleted(rule.moduleId);
      return { rule, satisfied: ok, progress: bool(ok) };
    }
    case 'phase_completed': {
      if (!facts.phaseCompleted) return unknown(rule);
      const ok = facts.phaseCompleted(rule.phaseId);
      return { rule, satisfied: ok, progress: bool(ok) };
    }
    case 'program_completed': {
      if (!facts.programProgress) return unknown(rule);
      const value = facts.programProgress(rule.programId) ?? 0;
      return {
        rule,
        satisfied: value >= rule.minPercent,
        progress: { current: round(value), target: rule.minPercent, unit: 'percent' },
      };
    }
    case 'assessment_score': {
      if (!facts.assessmentBestScore) return unknown(rule);
      const best = facts.assessmentBestScore(rule.assessmentId);
      return {
        rule,
        satisfied: best !== null && best >= rule.minPercent,
        progress: { current: round(best ?? 0), target: rule.minPercent, unit: 'percent' },
      };
    }
    case 'program_assessments_score': {
      if (!facts.programAssessments) return unknown(rule);
      const items = facts.programAssessments(rule.programId, rule.kinds);
      const passed = items.filter((i) => i.bestScore !== null && i.bestScore >= rule.minPercent);
      // A program with no matching assessments cannot satisfy the requirement: it is almost
      // certainly misconfigured, and silently passing would issue certificates incorrectly.
      return {
        rule,
        satisfied: items.length > 0 && passed.length === items.length,
        progress: { current: passed.length, target: items.length, unit: 'count' },
      };
    }
    case 'ai_scenario_score': {
      if (!facts.aiScenarioBestScore) return unknown(rule);
      const best = facts.aiScenarioBestScore(rule.scenarioId);
      return {
        rule,
        satisfied: best !== null && best >= rule.minScore,
        progress: { current: round(best ?? 0), target: rule.minScore, unit: 'percent' },
      };
    }
    case 'ai_sessions_count': {
      if (!facts.aiSessions) return unknown(rule);
      const sessions = facts
        .aiSessions(rule.scenarioIds)
        .filter((s) => rule.minScore === undefined || s.score >= rule.minScore);
      return {
        rule,
        satisfied: sessions.length >= rule.minCount,
        progress: {
          current: Math.min(sessions.length, rule.minCount),
          target: rule.minCount,
          unit: 'count',
        },
      };
    }
    case 'ai_average_score': {
      if (!facts.aiSessions) return unknown(rule);
      const all = facts.aiSessions(rule.scenarioIds);
      const sample = rule.lastN ? all.slice(0, rule.lastN) : all;
      const avg = sample.length ? sample.reduce((s, x) => s + x.score, 0) / sample.length : 0;
      return {
        rule,
        satisfied: sample.length > 0 && avg >= rule.minScore,
        progress: { current: round(avg), target: rule.minScore, unit: 'percent' },
      };
    }
    case 'approval': {
      if (!facts.approval) return unknown(rule);
      const ok = facts.approval(rule.kind);
      return { rule, satisfied: ok, progress: bool(ok) };
    }
    case 'certification_held': {
      if (!facts.certificationHeld) return unknown(rule);
      const ok = facts.certificationHeld(rule.certificationId);
      return { rule, satisfied: ok, progress: bool(ok) };
    }
    case 'date_reached': {
      const now = facts.now?.() ?? new Date();
      const ok = now.getTime() >= new Date(rule.date).getTime();
      return { rule, satisfied: ok, progress: bool(ok) };
    }
    case 'days_since_enrollment': {
      if (!facts.enrolledAt) return unknown(rule);
      const enrolled = facts.enrolledAt();
      if (!enrolled)
        return {
          rule,
          satisfied: false,
          progress: { current: 0, target: rule.days, unit: 'days' },
        };
      const now = facts.now?.() ?? new Date();
      const days = Math.floor((now.getTime() - enrolled.getTime()) / 86_400_000);
      return {
        rule,
        satisfied: days >= rule.days,
        progress: {
          current: Math.max(0, Math.min(days, rule.days)),
          target: rule.days,
          unit: 'days',
        },
      };
    }
  }
}

export function evaluateRule(rule: Rule, facts: RuleFacts): RuleResult {
  if (!isGroup(rule)) return evaluateLeaf(rule, facts);
  const children = rule.rules.map((r) => evaluateRule(r, facts));
  const satisfied =
    rule.type === 'all' ? children.every((c) => c.satisfied) : children.some((c) => c.satisfied);
  const met = children.filter((c) => c.satisfied).length;
  return {
    rule,
    satisfied,
    children,
    progress: {
      current: met,
      target: rule.type === 'all' ? children.length : Math.min(1, children.length),
      unit: 'count',
    },
  };
}

/**
 * Flatten a result into checklist items: children of a root `all` group, or the root itself.
 * Used for "6 / 8 requirements complete" style displays.
 */
export function checklist(result: RuleResult): RuleResult[] {
  if (result.rule.type === 'all' && result.children) return result.children;
  return [result];
}

/** Collect the rules of a tree that are not yet satisfied (leaves only). */
export function unmetLeaves(result: RuleResult): RuleResult[] {
  if (!result.children) return result.satisfied ? [] : [result];
  if (result.rule.type === 'any' && result.satisfied) return [];
  return result.children.flatMap(unmetLeaves);
}
