import { describe, expect, it } from 'vitest';
import type { learning } from '@a5/contracts';
import {
  describeLocation,
  findNode,
  planDrop,
  planMoveTo,
  planStep,
  positionAtEnd,
  positionBeside,
  type Phase,
} from './tree';

type Status = learning.NodeStatus;

function lesson(
  id: string,
  position: number,
  status: Status = 'published',
): Phase['modules'][number]['lessons'][number] {
  return { id, position, status, title: `Lesson ${id}` } as never;
}
function mod(
  id: string,
  position: number,
  lessons: Array<[string, Status?]>,
  status: Status = 'published',
): Phase['modules'][number] {
  return {
    id,
    position,
    status,
    title: `Module ${id}`,
    lessons: lessons.map(([lid, st], i) => lesson(lid, i + 1, st)),
  } as never;
}
function phase(
  id: string,
  position: number,
  modules: Phase['modules'],
  status: Status = 'published',
): Phase {
  return { id, position, status, title: `Phase ${id}`, modules } as never;
}

// Phase P1: M1 [a, b, c, d], M2 [e]; Phase P2: M3 [f]; Phase P3 (empty module M4)
const tree = (): Phase[] => [
  phase('P1', 1, [mod('M1', 1, [['a'], ['b'], ['c'], ['d']]), mod('M2', 2, [['e']])]),
  phase('P2', 2, [mod('M3', 1, [['f']])]),
  phase('P3', 3, [mod('M4', 1, [])]),
];

describe('positions', () => {
  const siblings = [
    { id: 'a', position: 1, status: 'published' as const },
    { id: 'b', position: 2, status: 'published' as const },
    { id: 'c', position: 3, status: 'published' as const },
  ];

  it('counts positions with the moved node removed, as the API does', () => {
    expect(positionBeside(siblings, 'a', 'c', 'after')).toBe(3);
    expect(positionBeside(siblings, 'c', 'a', 'before')).toBe(1);
    expect(positionBeside(siblings, 'a', 'b', 'before')).toBe(1);
    expect(positionBeside(siblings, 'a', 'missing', 'before')).toBeNull();
  });

  it('appends to another list or to the end of its own', () => {
    expect(positionAtEnd(siblings, 'x')).toBe(4);
    expect(positionAtEnd(siblings, 'a')).toBe(3);
  });
});

describe('planStep (move up / down)', () => {
  it('moves a lesson one place up or down', () => {
    expect(planStep(tree(), 'lesson', 'c', -1)).toEqual({
      kind: 'lesson',
      lessonId: 'c',
      moduleId: 'M1',
      position: 2,
    });
    expect(planStep(tree(), 'lesson', 'b', 1)).toEqual({
      kind: 'lesson',
      lessonId: 'b',
      moduleId: 'M1',
      position: 3,
    });
  });

  it('does nothing at the ends', () => {
    expect(planStep(tree(), 'lesson', 'a', -1)).toBeNull();
    expect(planStep(tree(), 'lesson', 'd', 1)).toBeNull();
    expect(planStep(tree(), 'module', 'M1', -1)).toBeNull();
    expect(planStep(tree(), 'phase', 'P3', 1)).toBeNull();
  });

  it('moves modules and phases within their parent', () => {
    expect(planStep(tree(), 'module', 'M2', -1)).toEqual({
      kind: 'module',
      moduleId: 'M2',
      phaseId: 'P1',
      position: 1,
    });
    expect(planStep(tree(), 'phase', 'P1', 1)).toEqual({
      kind: 'phase',
      phaseId: 'P1',
      position: 2,
    });
  });

  it('steps over archived siblings so one press always changes what the user sees', () => {
    const t: Phase[] = [phase('P1', 1, [mod('M1', 1, [['a'], ['b', 'archived'], ['c']])])];
    // Moving c up passes the archived b and lands before a.
    expect(planStep(t, 'lesson', 'c', -1)).toEqual({
      kind: 'lesson',
      lessonId: 'c',
      moduleId: 'M1',
      position: 1,
    });
    // Moving a down lands after c (past the archived b).
    expect(planStep(t, 'lesson', 'a', 1)).toEqual({
      kind: 'lesson',
      lessonId: 'a',
      moduleId: 'M1',
      position: 3,
    });
    // When only archived siblings are left in a direction, there is nowhere to go.
    const onlyArchived: Phase[] = [phase('P1', 1, [mod('M1', 1, [['a'], ['b', 'archived']])])];
    expect(planStep(onlyArchived, 'lesson', 'a', 1)).toBeNull();
  });

  it('sorts by position even if the list arrives unordered', () => {
    const t = tree();
    t[0]!.modules[0]!.lessons.reverse();
    expect(planStep(t, 'lesson', 'c', -1)).toEqual({
      kind: 'lesson',
      lessonId: 'c',
      moduleId: 'M1',
      position: 2,
    });
  });

  it('returns null for unknown nodes', () => {
    expect(planStep(tree(), 'lesson', 'nope', 1)).toBeNull();
  });
});

describe('planMoveTo (move to another parent)', () => {
  it('appends a lesson to another module', () => {
    expect(planMoveTo(tree(), 'lesson', 'a', 'M2')).toEqual({
      kind: 'lesson',
      lessonId: 'a',
      moduleId: 'M2',
      position: 2,
    });
    expect(planMoveTo(tree(), 'lesson', 'a', 'M4')).toEqual({
      kind: 'lesson',
      lessonId: 'a',
      moduleId: 'M4',
      position: 1,
    });
  });

  it('appends a module to another phase', () => {
    expect(planMoveTo(tree(), 'module', 'M2', 'P2')).toEqual({
      kind: 'module',
      moduleId: 'M2',
      phaseId: 'P2',
      position: 2,
    });
  });

  it('moves to the end of the same parent, or nothing when already last', () => {
    expect(planMoveTo(tree(), 'lesson', 'a', 'M1')).toEqual({
      kind: 'lesson',
      lessonId: 'a',
      moduleId: 'M1',
      position: 4,
    });
    expect(planMoveTo(tree(), 'lesson', 'd', 'M1')).toBeNull();
  });

  it('rejects unknown targets', () => {
    expect(planMoveTo(tree(), 'lesson', 'a', 'nope')).toBeNull();
    expect(planMoveTo(tree(), 'module', 'M1', 'nope')).toBeNull();
  });
});

describe('planDrop (drag and drop)', () => {
  it('reorders within a module', () => {
    expect(
      planDrop(tree(), { kind: 'lesson', id: 'a' }, { kind: 'lesson', id: 'c', where: 'after' }),
    ).toEqual({
      kind: 'lesson',
      lessonId: 'a',
      moduleId: 'M1',
      position: 3,
    });
    expect(
      planDrop(tree(), { kind: 'lesson', id: 'd' }, { kind: 'lesson', id: 'b', where: 'before' }),
    ).toEqual({
      kind: 'lesson',
      lessonId: 'd',
      moduleId: 'M1',
      position: 2,
    });
  });

  it('moves a lesson between modules and phases', () => {
    expect(
      planDrop(tree(), { kind: 'lesson', id: 'a' }, { kind: 'lesson', id: 'f', where: 'before' }),
    ).toEqual({
      kind: 'lesson',
      lessonId: 'a',
      moduleId: 'M3',
      position: 1,
    });
    expect(
      planDrop(tree(), { kind: 'lesson', id: 'a' }, { kind: 'module', id: 'M4', where: 'into' }),
    ).toEqual({
      kind: 'lesson',
      lessonId: 'a',
      moduleId: 'M4',
      position: 1,
    });
  });

  it('moves a module to another phase before a module there', () => {
    expect(
      planDrop(tree(), { kind: 'module', id: 'M2' }, { kind: 'module', id: 'M3', where: 'before' }),
    ).toEqual({
      kind: 'module',
      moduleId: 'M2',
      phaseId: 'P2',
      position: 1,
    });
    expect(
      planDrop(tree(), { kind: 'module', id: 'M1' }, { kind: 'phase', id: 'P3', where: 'into' }),
    ).toEqual({
      kind: 'module',
      moduleId: 'M1',
      phaseId: 'P3',
      position: 2,
    });
  });

  it('reorders phases', () => {
    expect(
      planDrop(tree(), { kind: 'phase', id: 'P3' }, { kind: 'phase', id: 'P1', where: 'before' }),
    ).toEqual({
      kind: 'phase',
      phaseId: 'P3',
      position: 1,
    });
  });

  it('ignores drops that change nothing or make no sense', () => {
    // Dropping onto itself, or into the place it already is.
    expect(
      planDrop(tree(), { kind: 'lesson', id: 'a' }, { kind: 'lesson', id: 'a', where: 'after' }),
    ).toBeNull();
    expect(
      planDrop(tree(), { kind: 'lesson', id: 'a' }, { kind: 'lesson', id: 'b', where: 'before' }),
    ).toBeNull();
    // A lesson cannot become a sibling of a module, and a phase cannot go inside a module.
    expect(
      planDrop(tree(), { kind: 'lesson', id: 'a' }, { kind: 'module', id: 'M2', where: 'before' }),
    ).toBeNull();
    expect(
      planDrop(tree(), { kind: 'phase', id: 'P1' }, { kind: 'module', id: 'M2', where: 'into' }),
    ).toBeNull();
    expect(
      planDrop(
        tree(),
        { kind: 'lesson', id: 'missing' },
        { kind: 'lesson', id: 'a', where: 'after' },
      ),
    ).toBeNull();
  });
});

describe('lookup and announcements', () => {
  it('finds nodes with their parents', () => {
    const at = findNode(tree(), 'lesson', 'f');
    expect(at?.module?.id).toBe('M3');
    expect(at?.phase.id).toBe('P2');
    expect(findNode(tree(), 'module', 'zzz')).toBeNull();
  });

  it('describes where a node is for screen readers, ignoring archived siblings', () => {
    const t: Phase[] = [phase('P1', 1, [mod('M1', 1, [['a'], ['b', 'archived'], ['c']])])];
    expect(describeLocation(t, 'lesson', 'c')).toBe('position 2 of 2 in Module M1');
    expect(describeLocation(t, 'phase', 'P1')).toBe('position 1 of 1 in the program');
  });
});
