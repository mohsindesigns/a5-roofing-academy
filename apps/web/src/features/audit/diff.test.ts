import { describe, expect, it } from 'vitest';
import { diffSnapshots, formatValue, summarizeDiff } from './diff';

describe('diffSnapshots', () => {
  it('marks changed, added, removed and unchanged fields', () => {
    const rows = diffSnapshots(
      { name: 'Roofing 101', status: 'draft', category: 'Sales', summary: 'Old' },
      { name: 'Roofing 101', status: 'published', category: 'Sales', ownerId: 'u1' },
    );
    expect(Object.fromEntries(rows.map((r) => [r.path, r.kind]))).toEqual({
      name: 'unchanged',
      status: 'changed',
      category: 'unchanged',
      summary: 'removed',
      ownerId: 'added',
    });
    expect(rows.find((r) => r.path === 'status')).toMatchObject({
      before: 'draft',
      after: 'published',
    });
    expect(summarizeDiff(rows)).toEqual({ added: 1, removed: 1, changed: 1 });
  });

  it('flattens nested objects and arrays into paths', () => {
    const rows = diffSnapshots(
      { settings: { navigationMode: 'sequential', dueDays: 14 }, tags: ['a', 'b'] },
      { settings: { navigationMode: 'free', dueDays: 14 }, tags: ['a', 'c', 'd'] },
    );
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r.kind]));
    expect(byPath['settings.navigationMode']).toBe('changed');
    expect(byPath['settings.dueDays']).toBe('unchanged');
    expect(byPath['tags[0]']).toBe('unchanged');
    expect(byPath['tags[1]']).toBe('changed');
    expect(byPath['tags[2]']).toBe('added');
  });

  it('treats a missing snapshot as an empty side', () => {
    const created = diffSnapshots(null, { title: 'New' });
    expect(created).toEqual([{ path: 'title', kind: 'added', before: undefined, after: 'New' }]);
    const deleted = diffSnapshots({ title: 'Old' }, undefined);
    expect(deleted).toEqual([{ path: 'title', kind: 'removed', before: 'Old', after: undefined }]);
    expect(diffSnapshots(null, null)).toEqual([]);
  });

  it('keeps null distinct from a missing field', () => {
    const rows = diffSnapshots({ dueAt: null }, { dueAt: '2026-10-12' });
    expect(rows).toEqual([{ path: 'dueAt', kind: 'changed', before: null, after: '2026-10-12' }]);
  });

  it('handles scalar and empty snapshots', () => {
    expect(diffSnapshots('a', 'b')).toEqual([
      { path: '(value)', kind: 'changed', before: 'a', after: 'b' },
    ]);
    const rows = diffSnapshots({ tags: [] }, { tags: ['x'] });
    expect(rows.map((r) => r.kind).sort()).toEqual(['added', 'removed']);
  });
});

describe('formatValue', () => {
  it('shows strings plainly and everything else as compact JSON', () => {
    expect(formatValue('published')).toBe('published');
    expect(formatValue('')).toBe('(empty text)');
    expect(formatValue(null)).toBe('null');
    expect(formatValue(undefined)).toBe('');
    expect(formatValue(14)).toBe('14');
    expect(formatValue({ a: [1, 2] })).toBe('{"a":[1,2]}');
  });
});
