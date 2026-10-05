import type { learning } from '@a5/contracts';

/**
 * Pure helpers for reordering the Program → Phase → Module → Lesson tree. They turn a user
 * gesture (drag, "move up", "move to…") into the one API call that performs it, using the
 * server's rule: positions are 1-based among all siblings (archived ones included) with the moved
 * node removed. Nothing here touches React or the network, so every gesture is unit-tested.
 */
export type Phase = learning.AdminPhase;
export type Module = learning.AdminModule;
export type Lesson = learning.AdminLesson;
export type NodeKind = 'phase' | 'module' | 'lesson';

export type MovePlan =
  | { kind: 'phase'; phaseId: string; position: number }
  | { kind: 'module'; moduleId: string; phaseId: string; position: number }
  | { kind: 'lesson'; lessonId: string; moduleId: string; position: number };

interface Positioned {
  id: string;
  position: number;
  status: learning.NodeStatus;
}

/** Siblings in display order. The API already sorts them; this keeps the helpers independent of that. */
export function ordered<T extends Positioned>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.position - b.position);
}

/** Position to send so that `id` lands directly before/after `anchorId` among `siblings`. */
export function positionBeside(
  siblings: readonly Positioned[],
  id: string,
  anchorId: string,
  where: 'before' | 'after',
): number | null {
  const rest = ordered(siblings).filter((s) => s.id !== id);
  const anchor = rest.findIndex((s) => s.id === anchorId);
  if (anchor === -1) return null;
  return (where === 'before' ? anchor : anchor + 1) + 1;
}

/** Position that puts a node last in a list it is not part of yet. */
export function positionAtEnd(siblings: readonly Positioned[], id: string): number {
  return siblings.filter((s) => s.id !== id).length + 1;
}

/** Index of the node in the full sibling list, or -1. */
function indexOf(siblings: readonly Positioned[], id: string): number {
  return ordered(siblings).findIndex((s) => s.id === id);
}

function isNoop(siblings: readonly Positioned[], id: string, position: number): boolean {
  return indexOf(siblings, id) + 1 === position;
}

export interface Located {
  kind: NodeKind;
  id: string;
  phase: Phase;
  module?: Module;
  lesson?: Lesson;
}

export function findNode(phases: readonly Phase[], kind: NodeKind, id: string): Located | null {
  for (const phase of phases) {
    if (kind === 'phase' && phase.id === id) return { kind, id, phase };
    for (const module of phase.modules) {
      if (kind === 'module' && module.id === id) return { kind, id, phase, module };
      for (const lesson of module.lessons) {
        if (kind === 'lesson' && lesson.id === id) return { kind, id, phase, module, lesson };
      }
    }
  }
  return null;
}

function siblingsOf(phases: readonly Phase[], at: Located): readonly Positioned[] {
  if (at.kind === 'phase') return phases;
  if (at.kind === 'module') return at.phase.modules;
  return at.module!.lessons;
}

/**
 * "Move up" / "move down": swap with the nearest sibling that is not archived. Returns null when
 * the node is already first/last among visible siblings.
 */
export function planStep(
  phases: readonly Phase[],
  kind: NodeKind,
  id: string,
  direction: -1 | 1,
  options: { includeArchived?: boolean } = {},
): MovePlan | null {
  const at = findNode(phases, kind, id);
  if (!at) return null;
  const siblings = ordered(siblingsOf(phases, at));
  const index = siblings.findIndex((s) => s.id === id);
  let j = index + direction;
  while (
    j >= 0 &&
    j < siblings.length &&
    !options.includeArchived &&
    siblings[j]!.status === 'archived'
  ) {
    j += direction;
  }
  const neighbour = siblings[j];
  if (!neighbour) return null;
  const position = positionBeside(siblings, id, neighbour.id, direction < 0 ? 'before' : 'after');
  if (position === null || isNoop(siblings, id, position)) return null;
  return toPlan(at, position);
}

function toPlan(at: Located, position: number, parentId?: string): MovePlan {
  if (at.kind === 'phase') return { kind: 'phase', phaseId: at.id, position };
  if (at.kind === 'module') {
    return { kind: 'module', moduleId: at.id, phaseId: parentId ?? at.phase.id, position };
  }
  return { kind: 'lesson', lessonId: at.id, moduleId: parentId ?? at.module!.id, position };
}

/** "Move to…": append a module to another phase, or a lesson to another module. */
export function planMoveTo(
  phases: readonly Phase[],
  kind: 'module' | 'lesson',
  id: string,
  targetParentId: string,
): MovePlan | null {
  const at = findNode(phases, kind, id);
  if (!at) return null;
  if (kind === 'module') {
    const target = phases.find((p) => p.id === targetParentId);
    if (!target) return null;
    const position = positionAtEnd(target.modules, id);
    if (target.id === at.phase.id && isNoop(target.modules, id, position)) return null;
    return toPlan(at, position, target.id);
  }
  const target = phases.flatMap((p) => p.modules).find((m) => m.id === targetParentId);
  if (!target) return null;
  const position = positionAtEnd(target.lessons, id);
  if (target.id === at.module!.id && isNoop(target.lessons, id, position)) return null;
  return toPlan(at, position, target.id);
}

export type DropTarget =
  | { kind: NodeKind; id: string; where: 'before' | 'after' }
  | { kind: 'module' | 'phase'; id: string; where: 'into' };

/**
 * Drag and drop. Dropping on a sibling of the same kind places the dragged node before or after
 * it (in that sibling's parent). Dropping a lesson on a module, or a module on a phase, appends it.
 * Combinations that make no sense (a phase into a module, a node onto itself) return null.
 */
export function planDrop(
  phases: readonly Phase[],
  drag: { kind: NodeKind; id: string },
  drop: DropTarget,
): MovePlan | null {
  const source = findNode(phases, drag.kind, drag.id);
  if (!source) return null;
  if (drop.where === 'into') {
    if (drag.kind === 'lesson' && drop.kind === 'module')
      return planMoveTo(phases, 'lesson', drag.id, drop.id);
    if (drag.kind === 'module' && drop.kind === 'phase')
      return planMoveTo(phases, 'module', drag.id, drop.id);
    return null;
  }
  if (drop.kind !== drag.kind || drop.id === drag.id) return null;
  const target = findNode(phases, drop.kind, drop.id);
  if (!target) return null;
  const siblings = siblingsOf(phases, target);
  const position = positionBeside(siblings, drag.id, drop.id, drop.where);
  if (position === null) return null;
  const sameParent =
    drag.kind === 'phase' ||
    (drag.kind === 'module' && source.phase.id === target.phase.id) ||
    (drag.kind === 'lesson' && source.module!.id === target.module!.id);
  if (sameParent && isNoop(siblings, drag.id, position)) return null;
  const parentId =
    drag.kind === 'module'
      ? target.phase.id
      : drag.kind === 'lesson'
        ? target.module!.id
        : undefined;
  return toPlan(source, position, parentId);
}

/** Where the node ended up, in words, for the screen-reader announcement after a move. */
export function describeLocation(phases: readonly Phase[], kind: NodeKind, id: string): string {
  const at = findNode(phases, kind, id);
  if (!at) return '';
  const siblings = ordered(siblingsOf(phases, at)).filter((s) => s.status !== 'archived');
  const index = siblings.findIndex((s) => s.id === id) + 1;
  const where =
    kind === 'phase'
      ? 'in the program'
      : kind === 'module'
        ? `in ${at.phase.title}`
        : `in ${at.module!.title}`;
  return `position ${index} of ${siblings.length} ${where}`;
}

export function titleOf(phases: readonly Phase[], kind: NodeKind, id: string): string {
  const at = findNode(phases, kind, id);
  if (!at) return '';
  return kind === 'phase'
    ? at.phase.title
    : kind === 'module'
      ? at.module!.title
      : at.lesson!.title;
}
