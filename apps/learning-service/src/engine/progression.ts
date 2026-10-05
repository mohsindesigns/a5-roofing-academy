import type { learning } from '@a5/contracts';
import { describeRule, evaluateRule, type RuleFacts, type RuleLabelResolver, type RuleResult, type Rule } from '@a5/rules';
import type { LessonProgressData } from '../database/schema.js';
import { lessonTypes } from '../lesson-types/registry.js';
import {
  completionSet,
  orderedLessons,
  phaseLabel,
  phaseName,
  type IndexedLesson,
  type ProgramTree,
  type TreeLesson,
  type TreeModule,
  type TreePhase,
} from './tree.js';

type Requirement = learning.Requirement;
type NodeState = learning.NodeState;

export interface LessonProgressFact {
  status: learning.LessonProgressStatus;
  percent: number;
  startedAt: Date | null;
  completedAt: Date | null;
  source: learning.CompletionSource | null;
  data: LessonProgressData;
}

export interface ScoreFact {
  bestScore: number;
  lastScore: number;
  passed: boolean;
  attempts: number;
  title: string;
  kind?: string;
  lastAt: Date;
}

/** Everything the evaluator needs to know about one learner in one program. */
export interface LearnerFacts {
  progress: Map<string, LessonProgressFact>;
  assessmentScores: Map<string, ScoreFact>;
  aiScores: Map<string, ScoreFact>;
  /** Scored AI sessions, newest first (loaded only when rules need them). */
  aiSessions: Array<{ scenarioId: string; score: number }>;
  approvals: Set<'manager' | 'trainer' | 'manual_review'>;
  enrolledAt: Date | null;
  /** Percent complete of the learner's other programs (completed enrollments count as 100). */
  programProgress: Map<string, number>;
  programTitles: Map<string, string>;
  prerequisites: Array<{ programId: string; title: string; percent: number; completed: boolean }>;
  phaseCompletedAt: Map<string, Date>;
  availability: { startsAt: Date | null; endsAt: Date | null };
  now: Date;
}

export function emptyFacts(now: Date = new Date()): LearnerFacts {
  return {
    progress: new Map(),
    assessmentScores: new Map(),
    aiScores: new Map(),
    aiSessions: [],
    approvals: new Set(),
    enrolledAt: null,
    programProgress: new Map(),
    programTitles: new Map(),
    prerequisites: [],
    phaseCompletedAt: new Map(),
    availability: { startsAt: null, endsAt: null },
    now,
  };
}

export interface LessonEval extends IndexedLesson {
  state: NodeState;
  percent: number;
  completed: boolean;
  completedAt: Date | null;
  requirements: Requirement[];
}

export interface ModuleEval {
  module: TreeModule;
  state: NodeState;
  complete: boolean;
  percent: number;
  requiredTotal: number;
  requiredCompleted: number;
  requirements: Requirement[];
  lessons: LessonEval[];
}

export interface PhaseEval {
  phase: TreePhase;
  index: number;
  label: string;
  name: string;
  state: NodeState;
  complete: boolean;
  completedAt: Date | null;
  percent: number;
  requiredTotal: number;
  requiredCompleted: number;
  requirements: Requirement[];
  modules: ModuleEval[];
}

export interface ProgramEval {
  state: NodeState;
  complete: boolean;
  requirements: Requirement[];
  percent: number;
  requiredTotal: number;
  requiredCompleted: number;
  remainingMinutes: number;
  phases: PhaseEval[];
  lessons: Map<string, LessonEval>;
  ordered: LessonEval[];
  /** First unlocked, incomplete lesson in program order. */
  nextLesson: LessonEval | null;
  /** Next lesson, or the first incomplete one when everything left is locked. */
  currentLesson: LessonEval | null;
  currentPhase: PhaseEval | null;
}

function pct(done: number, total: number): number {
  return total === 0 ? 0 : Math.round((done / total) * 1000) / 10;
}

function counts(lessons: readonly TreeLesson[], done: (id: string) => boolean) {
  const set = completionSet(lessons);
  const completed = set.filter((l) => done(l.id)).length;
  return { requiredTotal: set.length, requiredCompleted: completed, complete: set.length > 0 && completed === set.length, percent: pct(completed, set.length) };
}

/** Turn a rule result into checklist entries (a root `all` group is flattened). */
function requirementsOf(result: RuleResult, names: RuleLabelResolver): Requirement[] {
  if (result.rule.type === 'all' && !result.rule.label && result.children) {
    return result.children.flatMap((c) => requirementsOf(c, names));
  }
  return [{ description: describeRule(result.rule, names), satisfied: result.satisfied, progress: result.progress ?? null }];
}

function nodeState(complete: boolean, locked: boolean, touched: boolean): NodeState {
  if (complete) return 'completed';
  if (locked) return 'locked';
  return touched ? 'in_progress' : 'available';
}

const dateLabel = (d: Date) => d.toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

/**
 * Evaluate a learner's position in a program: per-node state, progress numbers and, for locked
 * nodes, the requirements in plain language. Pure: all facts are preloaded.
 */
export function evaluateProgram(tree: ProgramTree, facts: LearnerFacts): ProgramEval {
  const settings = tree.settings;
  const sequential = settings.navigationMode === 'sequential';
  const lessonChain = sequential && !settings.allowSkipAhead;
  const indexed = orderedLessons(tree);
  const done = (id: string) => facts.progress.get(id)?.status === 'completed';

  // Completion of modules, phases and the program does not depend on locks: compute it first so
  // rules can refer to it.
  const moduleCounts = new Map<string, ReturnType<typeof counts>>();
  const phaseCounts = new Map<string, ReturnType<typeof counts>>();
  for (const phase of tree.phases) {
    for (const module of phase.modules) moduleCounts.set(module.id, counts(module.lessons, done));
    const measured = counts(phase.modules.flatMap((m) => m.lessons), done);
    // A phase the learner already completed stays completed (and unlocked) even if a required
    // lesson is added to it later; the new lesson still counts toward program completion.
    phaseCounts.set(phase.id, facts.phaseCompletedAt.has(phase.id) ? { ...measured, complete: true } : measured);
  }
  const programCounts = counts(
    indexed.map((l) => l.lesson),
    done,
  );

  const assessmentLessons = indexed.flatMap(({ lesson }) => {
    const ref = lessonTypes.get(lesson.type).references(lesson.config).assessment;
    return ref ? [{ ...ref, title: lesson.title }] : [];
  });
  const scenarioLessons = new Map<string, string>();
  for (const { lesson } of indexed) {
    const ref = lessonTypes.get(lesson.type).references(lesson.config).aiScenario;
    if (ref && !scenarioLessons.has(ref.scenarioId)) scenarioLessons.set(ref.scenarioId, lesson.title);
  }

  const ruleFacts: RuleFacts = {
    lessonCompleted: done,
    moduleCompleted: (id) => moduleCounts.get(id)?.complete ?? false,
    phaseCompleted: (id) => phaseCounts.get(id)?.complete ?? false,
    programProgress: (id) => (id === tree.programId ? programCounts.percent : (facts.programProgress.get(id) ?? null)),
    assessmentBestScore: (id) => facts.assessmentScores.get(id)?.bestScore ?? null,
    programAssessments: (programId, kinds) =>
      programId === tree.programId
        ? assessmentLessons
            .filter((a) => kinds.includes(a.kind))
            .map((a) => ({ assessmentId: a.assessmentId, bestScore: facts.assessmentScores.get(a.assessmentId)?.bestScore ?? null }))
        : [],
    aiScenarioBestScore: (id) => facts.aiScores.get(id)?.bestScore ?? null,
    aiSessions: (ids) => (ids?.length ? facts.aiSessions.filter((s) => ids.includes(s.scenarioId)) : facts.aiSessions),
    approval: (kind) => facts.approvals.has(kind),
    enrolledAt: () => facts.enrolledAt,
    now: () => facts.now,
  };

  const lessonById = new Map(indexed.map((l) => [l.lesson.id, l]));
  const moduleById = new Map(tree.phases.flatMap((p) => p.modules.map((m) => [m.id, m] as const)));
  const phaseIndexById = new Map(tree.phases.map((p, i) => [p.id, i] as const));
  const names: RuleLabelResolver = {
    lesson: (id) => lessonById.get(id)?.lesson.title,
    module: (id) => moduleById.get(id)?.title,
    phase: (id) => {
      const i = phaseIndexById.get(id);
      return i === undefined ? undefined : phaseName(tree, i, tree.phases[i]!.title);
    },
    program: (id) => (id === tree.programId ? tree.title : facts.programTitles.get(id)),
    assessment: (id) => assessmentLessons.find((a) => a.assessmentId === id)?.title ?? facts.assessmentScores.get(id)?.title,
    scenario: (id) => scenarioLessons.get(id) ?? facts.aiScores.get(id)?.title,
  };
  const evaluate = (rule: Rule | null): Requirement[] | null => {
    if (!rule) return null;
    const result = evaluateRule(rule, ruleFacts);
    return result.satisfied ? null : requirementsOf(result, names);
  };

  // Program-level gate: prerequisite programs and the availability window.
  const programRequirements: Requirement[] = [];
  for (const pre of facts.prerequisites) {
    programRequirements.push({
      description: `Complete "${pre.title}"`,
      satisfied: pre.completed,
      progress: { current: Math.round(pre.percent * 10) / 10, target: 100, unit: 'percent' },
    });
  }
  if (facts.availability.startsAt) {
    const open = facts.now >= facts.availability.startsAt;
    programRequirements.push({
      description: `Opens on ${dateLabel(facts.availability.startsAt)}`,
      satisfied: open,
      progress: { current: open ? 1 : 0, target: 1, unit: 'boolean' },
    });
  }
  if (facts.availability.endsAt && !programCounts.complete) {
    const open = facts.now < facts.availability.endsAt;
    programRequirements.push({
      description: open ? `Finish before ${dateLabel(facts.availability.endsAt)}` : `This program closed on ${dateLabel(facts.availability.endsAt)}`,
      satisfied: open,
      progress: { current: open ? 1 : 0, target: 1, unit: 'boolean' },
    });
  }
  const programLocked = programRequirements.some((r) => !r.satisfied);

  const phases: PhaseEval[] = [];
  const lessons = new Map<string, LessonEval>();
  const ordered: LessonEval[] = [];
  let previousPhase: PhaseEval | null = null;
  let previousRequired: { lesson: TreeLesson; done: boolean } | null = null;

  tree.phases.forEach((phase, index) => {
    const pc = phaseCounts.get(phase.id)!;
    const name = phaseName(tree, index, phase.title);
    const own: Requirement[] = [];
    if (sequential && previousPhase && !previousPhase.complete) {
      own.push({
        description: `Complete ${previousPhase.name}`,
        satisfied: false,
        progress: { current: previousPhase.requiredCompleted, target: previousPhase.requiredTotal, unit: 'count' },
      });
    }
    const ruleReqs = evaluate(phase.unlockRule);
    if (ruleReqs) own.push(...ruleReqs);
    const phaseLocked = programLocked || own.some((r) => !r.satisfied);
    const phaseRequirements = programLocked
      ? [{ description: 'Available once the program requirements are met', satisfied: false, progress: null }]
      : phaseLocked
        ? own
        : [];

    const modules: ModuleEval[] = phase.modules.map((module) => {
      const mc = moduleCounts.get(module.id)!;
      const moduleOwn = evaluate(module.unlockRule) ?? [];
      const moduleLocked = phaseLocked || moduleOwn.some((r) => !r.satisfied);
      const moduleRequirements = phaseLocked
        ? [{ description: `Unlocks with ${name}`, satisfied: false, progress: null }]
        : moduleLocked
          ? moduleOwn
          : [];

      const lessonEvals: LessonEval[] = module.lessons.map((lesson) => {
        const info = lessonById.get(lesson.id)!;
        const progress = facts.progress.get(lesson.id);
        const isDone = progress?.status === 'completed';
        const lessonOwn: Requirement[] = [];
        if (lessonChain && previousRequired && !previousRequired.done) {
          lessonOwn.push({ description: `Complete "${previousRequired.lesson.title}"`, satisfied: false, progress: { current: 0, target: 1, unit: 'boolean' } });
        }
        const lessonRule = evaluate(lesson.unlockRule);
        if (lessonRule) lessonOwn.push(...lessonRule);
        const locked = moduleLocked || lessonOwn.some((r) => !r.satisfied);
        const requirements = isDone
          ? []
          : moduleLocked
            ? [{ description: phaseLocked ? `Unlocks with ${name}` : `Unlocks with "${module.title}"`, satisfied: false, progress: null }]
            : locked
              ? lessonOwn
              : [];
        const evaluation: LessonEval = {
          ...info,
          state: nodeState(isDone, locked, Boolean(progress && (progress.status === 'in_progress' || progress.startedAt))),
          percent: isDone ? 100 : (progress?.percent ?? 0),
          completed: isDone,
          completedAt: progress?.completedAt ?? null,
          requirements,
        };
        if (lesson.isRequired) previousRequired = { lesson, done: isDone };
        lessons.set(lesson.id, evaluation);
        ordered.push(evaluation);
        return evaluation;
      });

      const touched = lessonEvals.some((l) => l.state === 'completed' || l.state === 'in_progress');
      return {
        module,
        state: nodeState(mc.complete, moduleLocked, touched),
        complete: mc.complete,
        percent: mc.percent,
        requiredTotal: mc.requiredTotal,
        requiredCompleted: mc.requiredCompleted,
        requirements: mc.complete ? [] : moduleRequirements,
        lessons: lessonEvals,
      };
    });

    const touched = modules.some((m) => m.state === 'completed' || m.state === 'in_progress');
    const evaluation: PhaseEval = {
      phase,
      index,
      label: phaseLabel(tree, index),
      name,
      state: nodeState(pc.complete, phaseLocked, touched),
      complete: pc.complete,
      completedAt: facts.phaseCompletedAt.get(phase.id) ?? null,
      percent: pc.percent,
      requiredTotal: pc.requiredTotal,
      requiredCompleted: pc.requiredCompleted,
      requirements: pc.complete ? [] : phaseRequirements,
      modules,
    };
    phases.push(evaluation);
    previousPhase = evaluation;
  });

  // Once every required lesson is done there is nothing left to continue with, even if optional
  // lessons remain.
  const requiredIds = new Set(completionSet(indexed.map((l) => l.lesson)).map((l) => l.id));
  const nextLesson = programCounts.complete ? null : (ordered.find((l) => l.state === 'available' || l.state === 'in_progress') ?? null);
  const currentLesson = programCounts.complete
    ? null
    : (nextLesson ?? ordered.find((l) => !l.completed && requiredIds.has(l.lesson.id)) ?? ordered.find((l) => !l.completed) ?? null);
  const currentPhase = currentLesson
    ? (phases.find((p) => p.phase.id === currentLesson.phase.id) ?? null)
    : programCounts.complete
      ? (phases[phases.length - 1] ?? null)
      : (phases[0] ?? null);
  const remainingMinutes = ordered
    .filter((l) => requiredIds.has(l.lesson.id) && !l.completed)
    .reduce((n, l) => n + l.lesson.estimatedMinutes, 0);
  const anyTouched = ordered.some((l) => l.state === 'completed' || l.state === 'in_progress');

  return {
    state: nodeState(programCounts.complete, programLocked, anyTouched),
    complete: programCounts.complete,
    requirements: programLocked ? programRequirements : [],
    percent: programCounts.percent,
    requiredTotal: programCounts.requiredTotal,
    requiredCompleted: programCounts.requiredCompleted,
    remainingMinutes,
    phases,
    lessons,
    ordered,
    nextLesson,
    currentLesson,
    currentPhase,
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Outline DTO for the learner (or a preview when `enrollment` is null). */
export function toOutline(tree: ProgramTree, ev: ProgramEval, enrollment: learning.EnrollmentProgress | null): learning.Outline {
  return {
    program: {
      id: tree.programId,
      title: tree.title,
      summary: tree.summary,
      phaseLabel: tree.phaseLabel,
      navigationMode: tree.settings.navigationMode,
      version: tree.version,
      coverMediaAssetId: tree.coverMediaAssetId,
    },
    enrollment,
    state: ev.state,
    requirements: ev.requirements,
    percent: ev.percent,
    requiredTotal: ev.requiredTotal,
    requiredCompleted: ev.requiredCompleted,
    estimatedRemainingMinutes: ev.remainingMinutes,
    nextLessonId: ev.nextLesson?.lesson.id ?? null,
    phases: ev.phases.map((p) => ({
      id: p.phase.id,
      title: p.phase.title,
      summary: p.phase.summary,
      position: p.phase.position,
      label: p.label,
      state: p.state,
      percent: p.percent,
      requiredTotal: p.requiredTotal,
      requiredCompleted: p.requiredCompleted,
      completedAt: iso(p.completedAt),
      requirements: p.requirements,
      modules: p.modules.map((m) => ({
        id: m.module.id,
        title: m.module.title,
        summary: m.module.summary,
        position: m.module.position,
        state: m.state,
        percent: m.percent,
        requiredTotal: m.requiredTotal,
        requiredCompleted: m.requiredCompleted,
        requirements: m.requirements,
        lessons: m.lessons.map((l) => ({
          id: l.lesson.id,
          type: l.lesson.type,
          title: l.lesson.title,
          summary: l.lesson.summary,
          position: l.lesson.position,
          isRequired: l.lesson.isRequired,
          estimatedMinutes: l.lesson.estimatedMinutes,
          state: l.state,
          percent: l.percent,
          completedAt: iso(l.completedAt),
          requirements: l.requirements,
        })),
      })),
    })),
  };
}
