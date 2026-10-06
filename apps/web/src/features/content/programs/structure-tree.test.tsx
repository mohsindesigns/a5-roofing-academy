import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructureTree, type TreeActions } from './structure-tree';
import type { Phase } from './tree';

afterEach(cleanup);

const lesson = (id: string, position: number, status = 'published') =>
  ({
    id,
    position,
    status,
    title: `Lesson ${id}`,
    type: 'article',
    estimatedMinutes: 5,
    isRequired: true,
    hasUnpublishedChanges: false,
    unlockRule: null,
  }) as never;

const phases: Phase[] = [
  {
    id: 'P1',
    position: 1,
    label: 'Week 1',
    title: 'Basics',
    summary: null,
    status: 'published',
    hasUnpublishedChanges: false,
    unlockRule: null,
    modules: [
      {
        id: 'M1',
        position: 1,
        title: 'Start here',
        summary: null,
        status: 'published',
        hasUnpublishedChanges: false,
        unlockRule: null,
        lessons: [lesson('a', 1), lesson('b', 2), lesson('c', 3, 'archived')],
      },
    ],
  },
] as never;

function actions(): TreeActions {
  return {
    move: vi.fn(),
    step: vi.fn(),
    moveTo: vi.fn(),
    editLesson: vi.fn(),
    addLesson: vi.fn(),
    addModule: vi.fn(),
    editNode: vi.fn(),
    editRule: vi.fn(),
    setArchived: vi.fn(),
    duplicateLesson: vi.fn(),
    remove: vi.fn(),
  };
}

const renderTree = (a: TreeActions, extra: { canEdit?: boolean; showArchived?: boolean } = {}) =>
  render(
    <StructureTree
      phases={phases}
      canEdit={extra.canEdit ?? true}
      showArchived={extra.showArchived ?? false}
      actions={a}
      resolver={{}}
    />,
  );

describe('StructureTree', () => {
  it('lists phases, modules and lessons, hiding archived items by default', () => {
    renderTree(actions());
    expect(screen.getByRole('region', { name: 'Week 1: Basics' })).toBeInTheDocument();
    expect(screen.getByText('Start here')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lesson a' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lesson c' })).not.toBeInTheDocument();
  });

  it('offers a keyboard alternative to dragging on every row', async () => {
    const a = actions();
    renderTree(a);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Move Lesson a down' }));
    expect(a.step).toHaveBeenCalledWith('lesson', 'a', 1);
    await user.click(screen.getByRole('button', { name: 'Move Lesson b up' }));
    expect(a.step).toHaveBeenCalledWith('lesson', 'b', -1);
  });

  it('disables moves that go nowhere, counting only visible siblings', () => {
    renderTree(actions());
    expect(screen.getByRole('button', { name: 'Move Lesson a up' })).toBeDisabled();
    // The only sibling after b is archived and hidden, so b cannot move down.
    expect(screen.getByRole('button', { name: 'Move Lesson b down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Lesson a down' })).toBeEnabled();
  });

  it('includes archived siblings in the order when they are shown', () => {
    renderTree(actions(), { showArchived: true });
    expect(screen.getByRole('button', { name: 'Move Lesson b down' })).toBeEnabled();
    expect(within(screen.getByRole('region')).getAllByText('Archived').length).toBeGreaterThan(0);
  });

  it('opens a lesson from its title', async () => {
    const a = actions();
    renderTree(a);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Lesson b' }));
    expect(a.editLesson).toHaveBeenCalledWith('b');
  });

  it('turns a drop on another lesson into the matching move', () => {
    const a = actions();
    renderTree(a);
    const source = screen.getByRole('button', { name: 'Lesson a' }).closest('[data-node]')!;
    const target = screen.getByRole('button', { name: 'Lesson b' }).closest('[data-node]')!;
    // Rows report their position through the bounding box; put the pointer in the lower half.
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      height: 40,
      bottom: 140,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    const data = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
    fireEvent.dragStart(source, { dataTransfer: data });
    fireEvent.dragOver(target, { dataTransfer: data, clientY: 130 });
    fireEvent.drop(target, { dataTransfer: data, clientY: 130 });
    expect(a.move).toHaveBeenCalledWith({
      kind: 'lesson',
      lessonId: 'a',
      moduleId: 'M1',
      position: 2,
    });
  });

  it('is read-only without edit permission', () => {
    renderTree(actions(), { canEdit: false });
    expect(screen.queryByRole('button', { name: /Move Lesson a/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /More actions/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add lesson/ })).not.toBeInTheDocument();
  });
});
