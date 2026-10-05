import type { Selectable } from '@a5/database';
import { learning } from '@a5/contracts';
import { isGroup, type Rule } from '@a5/rules';
import type {
  LessonResourcesTable,
  LessonsTable,
  ProgramModulesTable,
  ProgramPhasesTable,
  ProgramsTable,
} from '../database/schema.js';
import { lessonTypes } from '../lesson-types/registry.js';

/**
 * A program as learners see it: the published snapshot (or, for previews and publishing, the
 * working copy without archived nodes). Plain JSON so it can be stored in `program_versions` and
 * cached in Redis.
 */
export interface TreeResource {
  id: string;
  position: number;
  title: string;
  description: string | null;
  kind: 'link' | 'media';
  url: string | null;
  mediaAssetId: string | null;
}

export interface TreeLesson {
  id: string;
  phaseId: string;
  moduleId: string;
  position: number;
  type: learning.LessonType;
  title: string;
  summary: string | null;
  body: string | null;
  config: Record<string, unknown>;
  isRequired: boolean;
  estimatedMinutes: number;
  unlockRule: Rule | null;
  resources: TreeResource[];
}

export interface TreeModule {
  id: string;
  phaseId: string;
  position: number;
  title: string;
  summary: string | null;
  unlockRule: Rule | null;
  lessons: TreeLesson[];
}

export interface TreePhase {
  id: string;
  position: number;
  title: string;
  summary: string | null;
  unlockRule: Rule | null;
  modules: TreeModule[];
}

export interface ProgramTree {
  schemaVersion: 1;
  programId: string;
  organizationId: string;
  /** Published version, or 0 for a working-copy preview. */
  version: number;
  title: string;
  summary: string | null;
  description: string | null;
  category: string | null;
  coverMediaAssetId: string | null;
  phaseLabel: string;
  settings: learning.ProgramSettings;
  estimatedMinutes: number | null;
  phases: TreePhase[];
}

export interface IndexedLesson {
  lesson: TreeLesson;
  module: TreeModule;
  phase: TreePhase;
  phaseIndex: number;
  /** Position in program order (0-based). */
  order: number;
}

type ProgramRow = Selectable<ProgramsTable>;
type PhaseRow = Selectable<ProgramPhasesTable>;
type ModuleRow = Selectable<ProgramModulesTable>;
type LessonRow = Selectable<LessonsTable>;
type ResourceRow = Selectable<LessonResourcesTable>;

export function parseSettings(raw: unknown): learning.ProgramSettings {
  const parsed = learning.programSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : learning.programSettingsSchema.parse({});
}

const byPosition = <T extends { position: number; created_at: Date; id: string }>(a: T, b: T) =>
  a.position - b.position || a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id);

/**
 * Assemble the learner-facing tree from working-copy rows. Archived nodes (and everything below
 * them) are left out; positions are renumbered densely in display order.
 */
export function assembleTree(
  program: ProgramRow,
  rows: { phases: PhaseRow[]; modules: ModuleRow[]; lessons: LessonRow[]; resources: ResourceRow[] },
  version: number,
): ProgramTree {
  const live = <T extends { status: string }>(r: T) => r.status !== 'archived';
  const resources = new Map<string, ResourceRow[]>();
  for (const r of rows.resources) resources.set(r.lesson_id, [...(resources.get(r.lesson_id) ?? []), r]);

  const phases = rows.phases.filter(live).sort(byPosition);
  return {
    schemaVersion: 1,
    programId: program.id,
    organizationId: program.organization_id,
    version,
    title: program.title,
    summary: program.summary,
    description: program.description,
    category: program.category,
    coverMediaAssetId: program.cover_media_asset_id,
    phaseLabel: program.phase_label,
    settings: parseSettings(program.settings),
    estimatedMinutes: program.estimated_minutes,
    phases: phases.map((phase, pi) => ({
      id: phase.id,
      position: pi + 1,
      title: phase.title,
      summary: phase.summary,
      unlockRule: phase.unlock_rule,
      modules: rows.modules
        .filter((m) => m.phase_id === phase.id && live(m))
        .sort(byPosition)
        .map((module, mi) => ({
          id: module.id,
          phaseId: phase.id,
          position: mi + 1,
          title: module.title,
          summary: module.summary,
          unlockRule: module.unlock_rule,
          lessons: rows.lessons
            .filter((l) => l.module_id === module.id && live(l))
            .sort(byPosition)
            .map((lesson, li) => ({
              id: lesson.id,
              phaseId: phase.id,
              moduleId: module.id,
              position: li + 1,
              type: lesson.type,
              title: lesson.title,
              summary: lesson.summary,
              body: lesson.body,
              config: lessonTypes.has(lesson.type) ? lessonTypes.readConfig(lesson.type, lesson.config) : lesson.config,
              isRequired: lesson.is_required,
              estimatedMinutes: lesson.estimated_minutes,
              unlockRule: lesson.unlock_rule,
              resources: (resources.get(lesson.id) ?? [])
                .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
                .map((r, ri) => ({
                  id: r.id,
                  position: ri + 1,
                  title: r.title,
                  description: r.description,
                  kind: r.kind,
                  url: r.url,
                  mediaAssetId: r.media_asset_id,
                })),
            })),
        })),
    })),
  };
}

/** Restore a tree from a stored snapshot, applying current defaults to settings and configs. */
export function treeFromSnapshot(snapshot: unknown): ProgramTree {
  const tree = snapshot as ProgramTree;
  return {
    ...tree,
    settings: parseSettings(tree.settings),
    phases: tree.phases.map((p) => ({
      ...p,
      modules: p.modules.map((m) => ({
        ...m,
        lessons: m.lessons.map((l) => ({
          ...l,
          config: lessonTypes.has(l.type) ? lessonTypes.readConfig(l.type, l.config) : l.config,
        })),
      })),
    })),
  };
}

/** Lessons in program order with their parents. */
export function orderedLessons(tree: ProgramTree): IndexedLesson[] {
  const out: IndexedLesson[] = [];
  tree.phases.forEach((phase, phaseIndex) => {
    for (const module of phase.modules) {
      for (const lesson of module.lessons) out.push({ lesson, module, phase, phaseIndex, order: out.length });
    }
  });
  return out;
}

export function lessonIndex(tree: ProgramTree): Map<string, IndexedLesson> {
  return new Map(orderedLessons(tree).map((l) => [l.lesson.id, l]));
}

/** "Week 2" */
export function phaseLabel(tree: Pick<ProgramTree, 'phaseLabel'>, phaseIndex: number): string {
  return `${tree.phaseLabel} ${phaseIndex + 1}`;
}

/** `{ id, title, label: "Week 2", position }` for a phase of the tree, or null. */
export function phaseRef(
  tree: ProgramTree | null,
  phaseId: string | null,
): { id: string; title: string; label: string; position: number } | null {
  if (!tree || !phaseId) return null;
  const index = tree.phases.findIndex((p) => p.id === phaseId);
  if (index === -1) return null;
  return { id: phaseId, title: tree.phases[index]!.title, label: phaseLabel(tree, index), position: index + 1 };
}

/** "Week 2: Roofing & Insurance Fundamentals" */
export function phaseName(tree: Pick<ProgramTree, 'phaseLabel'>, phaseIndex: number, title: string): string {
  return `${phaseLabel(tree, phaseIndex)}: ${title}`;
}

/** Lessons that count toward completion: the required ones, or every lesson when none is required. */
export function completionSet<T extends { isRequired: boolean }>(lessons: readonly T[]): T[] {
  const required = lessons.filter((l) => l.isRequired);
  return required.length ? required : [...lessons];
}

export interface PublishedRequirementMap {
  requiredLessonIds: string[];
  phases: Array<{ phaseId: string; title: string; position: number; requiredLessonIds: string[] }>;
  assessments: Array<{ assessmentId: string; lessonId: string; kind: 'quiz' | 'exam' | 'final' | 'practice'; required: boolean; title: string }>;
  aiScenarios: Array<{ scenarioId: string; lessonId: string; minScore: number | null }>;
}

/** What other services need to know about a published program (program.published payload). */
export function requirementMap(tree: ProgramTree): PublishedRequirementMap {
  const lessons = orderedLessons(tree);
  const assessments: PublishedRequirementMap['assessments'] = [];
  const aiScenarios: PublishedRequirementMap['aiScenarios'] = [];
  for (const { lesson } of lessons) {
    const refs = lessonTypes.get(lesson.type).references(lesson.config);
    if (refs.assessment) {
      assessments.push({
        assessmentId: refs.assessment.assessmentId,
        lessonId: lesson.id,
        kind: refs.assessment.kind,
        required: lesson.isRequired,
        title: lesson.title,
      });
    }
    if (refs.aiScenario) aiScenarios.push({ scenarioId: refs.aiScenario.scenarioId, lessonId: lesson.id, minScore: refs.aiScenario.minScore });
  }
  return {
    requiredLessonIds: completionSet(lessons.map((l) => ({ id: l.lesson.id, isRequired: l.lesson.isRequired }))).map((l) => l.id),
    phases: tree.phases.map((p) => ({
      phaseId: p.id,
      title: p.title,
      position: p.position,
      requiredLessonIds: completionSet(p.modules.flatMap((m) => m.lessons)).map((l) => l.id),
    })),
    assessments,
    aiScenarios,
  };
}

export function treeStats(tree: ProgramTree): { phases: number; modules: number; lessons: number; requiredLessons: number; estimatedMinutes: number } {
  const lessons = orderedLessons(tree).map((l) => l.lesson);
  return {
    phases: tree.phases.length,
    modules: tree.phases.reduce((n, p) => n + p.modules.length, 0),
    lessons: lessons.length,
    requiredLessons: lessons.filter((l) => l.isRequired).length,
    estimatedMinutes: lessons.reduce((n, l) => n + l.estimatedMinutes, 0),
  };
}

// ------------------------------------------------------------------ rule helpers

export interface RuleReferences {
  lessonIds: string[];
  moduleIds: string[];
  phaseIds: string[];
  programIds: string[];
  assessmentIds: string[];
  scenarioIds: string[];
  ruleTypes: Set<string>;
}

export function ruleReferences(rules: ReadonlyArray<Rule | null | undefined>): RuleReferences {
  const refs: RuleReferences = {
    lessonIds: [],
    moduleIds: [],
    phaseIds: [],
    programIds: [],
    assessmentIds: [],
    scenarioIds: [],
    ruleTypes: new Set(),
  };
  const visit = (rule: Rule) => {
    refs.ruleTypes.add(rule.type);
    if (isGroup(rule)) {
      rule.rules.forEach(visit);
      return;
    }
    switch (rule.type) {
      case 'lesson_completed':
        refs.lessonIds.push(rule.lessonId);
        break;
      case 'module_completed':
        refs.moduleIds.push(rule.moduleId);
        break;
      case 'phase_completed':
        refs.phaseIds.push(rule.phaseId);
        break;
      case 'program_completed':
      case 'program_assessments_score':
        refs.programIds.push(rule.programId);
        break;
      case 'assessment_score':
        refs.assessmentIds.push(rule.assessmentId);
        break;
      case 'ai_scenario_score':
        refs.scenarioIds.push(rule.scenarioId);
        break;
      case 'ai_sessions_count':
      case 'ai_average_score':
        refs.scenarioIds.push(...(rule.scenarioIds ?? []));
        break;
      default:
        break;
    }
  };
  for (const rule of rules) if (rule) visit(rule);
  return refs;
}

export function treeRules(tree: ProgramTree): Rule[] {
  const rules: Array<Rule | null> = [];
  for (const p of tree.phases) {
    rules.push(p.unlockRule);
    for (const m of p.modules) {
      rules.push(m.unlockRule);
      for (const l of m.lessons) rules.push(l.unlockRule);
    }
  }
  return rules.filter((r): r is Rule => r !== null);
}

/** Replace node ids inside a rule (used when duplicating a program). Unknown ids are kept. */
export function remapRule(rule: Rule | null, ids: ReadonlyMap<string, string>): Rule | null {
  if (!rule) return null;
  const map = (id: string) => ids.get(id) ?? id;
  if (isGroup(rule)) return { ...rule, rules: rule.rules.map((r) => remapRule(r, ids)!) };
  switch (rule.type) {
    case 'lesson_completed':
      return { ...rule, lessonId: map(rule.lessonId) };
    case 'module_completed':
      return { ...rule, moduleId: map(rule.moduleId) };
    case 'phase_completed':
      return { ...rule, phaseId: map(rule.phaseId) };
    case 'program_completed':
    case 'program_assessments_score':
      return { ...rule, programId: map(rule.programId) };
    default:
      return rule;
  }
}
