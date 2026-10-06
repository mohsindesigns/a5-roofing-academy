import { describe, expect, it } from 'vitest';
import {
  arrangeItems,
  filterLocal,
  isPaletteShortcut,
  matchesQuery,
  moveActive,
  type PaletteItem,
} from './commands';

describe('matchesQuery', () => {
  it('matches everything for an empty query', () => {
    expect(matchesQuery('Roles & permissions', '')).toBe(true);
    expect(matchesQuery('Roles & permissions', '   ')).toBe(true);
  });

  it('requires every typed word to start a word of the label', () => {
    expect(matchesQuery('Roles & permissions', 'perm')).toBe(true);
    expect(matchesQuery('Roles & permissions', 'role perm')).toBe(true);
    expect(matchesQuery('Roles & permissions', 'ssions')).toBe(false);
    expect(matchesQuery('Audit log', 'log audit')).toBe(true);
    expect(matchesQuery('Audit log', 'audits')).toBe(false);
  });

  it('filters lists by title', () => {
    const items = [{ title: 'Team' }, { title: 'Reports' }, { title: 'Roles & permissions' }];
    expect(filterLocal(items, 'r').map((i) => i.title)).toEqual(['Reports', 'Roles & permissions']);
  });
});

describe('arrangeItems', () => {
  const item = (id: string, group: PaletteItem['group']): PaletteItem => ({
    id,
    group,
    title: id,
    to: `/${id}`,
  });

  it('orders groups consistently and keeps the flat list in the same order', () => {
    const { groups, flat } = arrangeItems([
      item('lesson-1', 'Lessons'),
      item('nav-1', 'Go to'),
      item('person-1', 'People'),
      item('nav-2', 'Go to'),
    ]);
    expect(groups.map((g) => g.group)).toEqual(['Go to', 'People', 'Lessons']);
    expect(flat.map((i) => i.id)).toEqual(['nav-1', 'nav-2', 'person-1', 'lesson-1']);
  });

  it('drops empty groups', () => {
    expect(arrangeItems([]).groups).toEqual([]);
  });
});

describe('keyboard helpers', () => {
  it('wraps the active index', () => {
    expect(moveActive(0, -1, 4)).toBe(3);
    expect(moveActive(3, 1, 4)).toBe(0);
    expect(moveActive(1, 1, 4)).toBe(2);
    expect(moveActive(0, 1, 0)).toBe(0);
  });

  it('recognises Ctrl+K and Cmd+K only', () => {
    const base = { key: 'k', metaKey: false, ctrlKey: false, altKey: false };
    expect(isPaletteShortcut({ ...base, ctrlKey: true })).toBe(true);
    expect(isPaletteShortcut({ ...base, metaKey: true, key: 'K' })).toBe(true);
    expect(isPaletteShortcut(base)).toBe(false);
    expect(isPaletteShortcut({ ...base, ctrlKey: true, altKey: true })).toBe(false);
    expect(isPaletteShortcut({ ...base, ctrlKey: true, key: 'j' })).toBe(false);
  });
});
