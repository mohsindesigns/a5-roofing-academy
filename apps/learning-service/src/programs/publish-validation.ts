import type { learning } from '@a5/contracts';
import type { Rule } from '@a5/rules';
import { orderedLessons, phaseName, ruleReferences, type ProgramTree } from '../engine/tree.js';
import { lessonTypes } from '../lesson-types/registry.js';

/**
 * Problems that must be fixed before the working copy can be published. Shown in the program
 * builder and enforced by "Publish changes".
 */
export function publishIssues(tree: ProgramTree): learning.PublishIssue[] {
  const issues: learning.PublishIssue[] = [];
  const lessons = orderedLessons(tree);
  const lessonIds = new Set(lessons.map((l) => l.lesson.id));
  const moduleIds = new Set(tree.phases.flatMap((p) => p.modules.map((m) => m.id)));
  const phaseIds = new Set(tree.phases.map((p) => p.id));

  if (lessons.length === 0) {
    issues.push({
      nodeType: 'program',
      nodeId: tree.programId,
      message: 'Add at least one lesson before publishing.',
    });
  }

  const checkRule = (
    rule: Rule | null,
    nodeType: learning.PublishIssue['nodeType'],
    nodeId: string,
    label: string,
  ) => {
    if (!rule) return;
    const refs = ruleReferences([rule]);
    const self = [...refs.lessonIds, ...refs.moduleIds, ...refs.phaseIds].includes(nodeId);
    if (self)
      issues.push({
        nodeType,
        nodeId,
        message: `${label}: the unlock rule cannot depend on the item itself.`,
      });
    const missing =
      refs.lessonIds.filter((id) => !lessonIds.has(id)).length +
      refs.moduleIds.filter((id) => !moduleIds.has(id)).length +
      refs.phaseIds.filter((id) => !phaseIds.has(id)).length;
    if (missing > 0) {
      issues.push({
        nodeType,
        nodeId,
        message: `${label}: the unlock rule refers to ${missing === 1 ? 'an item that is' : `${missing} items that are`} archived or no longer exist. Update the rule.`,
      });
    }
  };

  tree.phases.forEach((phase, index) => {
    const name = phaseName(tree, index, phase.title);
    if (!phase.modules.some((m) => m.lessons.length > 0)) {
      issues.push({
        nodeType: 'phase',
        nodeId: phase.id,
        message: `${name} has no lessons. Add a lesson or archive it.`,
      });
    }
    checkRule(phase.unlockRule, 'phase', phase.id, name);
    for (const module of phase.modules) {
      if (module.lessons.length === 0) {
        issues.push({
          nodeType: 'module',
          nodeId: module.id,
          message: `Module "${module.title}" has no lessons. Add a lesson or archive it.`,
        });
      }
      checkRule(module.unlockRule, 'module', module.id, `Module "${module.title}"`);
      for (const lesson of module.lessons) {
        const label = `Lesson "${lesson.title}"`;
        if (!lessonTypes.has(lesson.type)) {
          issues.push({
            nodeType: 'lesson',
            nodeId: lesson.id,
            message: `${label}: unknown lesson type "${lesson.type}".`,
          });
          continue;
        }
        const handler = lessonTypes.get(lesson.type);
        const parsed = handler.configSchema.safeParse(lesson.config);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            issues.push({
              nodeType: 'lesson',
              nodeId: lesson.id,
              message: `${label}: ${issue.message} (${['config', ...issue.path.map(String)].join('.')}).`,
            });
          }
        } else {
          for (const message of handler.publishIssues?.({
            body: lesson.body,
            config: parsed.data,
          }) ?? []) {
            issues.push({ nodeType: 'lesson', nodeId: lesson.id, message: `${label}: ${message}` });
          }
        }
        checkRule(lesson.unlockRule, 'lesson', lesson.id, label);
      }
    }
  });
  return issues;
}
