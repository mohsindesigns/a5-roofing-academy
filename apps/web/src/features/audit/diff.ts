/**
 * Field-level comparison of the `before` and `after` snapshots stored on an audit entry. Both are
 * arbitrary JSON; objects are flattened to dotted paths ("settings.navigationMode") and arrays to
 * indexed paths ("tags[1]") so every changed leaf gets its own row.
 */
export type DiffKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface DiffRow {
  path: string;
  kind: DiffKind;
  before: unknown;
  after: unknown;
}

type Leaves = Map<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function flatten(value: unknown, path: string, out: Leaves): void {
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(path, value);
    value.forEach((item, i) => flatten(item, `${path}[${i}]`, out));
    return;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) out.set(path, value);
    for (const key of keys) flatten(value[key], path ? `${path}.${key}` : key, out);
    return;
  }
  out.set(path, value);
}

function leaves(value: unknown): Leaves {
  const out: Leaves = new Map();
  if (value === null || value === undefined) return out;
  flatten(value, '', out);
  // A scalar snapshot has no path; show it under a neutral label.
  if (out.has('')) {
    out.set('(value)', out.get(''));
    out.delete('');
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Rows for every path present in either snapshot, in the order the fields appear (before first,
 * then paths only present after).
 */
export function diffSnapshots(before: unknown, after: unknown): DiffRow[] {
  const a = leaves(before);
  const b = leaves(after);
  const rows: DiffRow[] = [];
  for (const [path, value] of a) {
    if (!b.has(path)) rows.push({ path, kind: 'removed', before: value, after: undefined });
    else {
      const next = b.get(path);
      rows.push({
        path,
        kind: same(value, next) ? 'unchanged' : 'changed',
        before: value,
        after: next,
      });
    }
  }
  for (const [path, value] of b) {
    if (!a.has(path)) rows.push({ path, kind: 'added', before: undefined, after: value });
  }
  return rows;
}

export function summarizeDiff(rows: DiffRow[]): {
  added: number;
  removed: number;
  changed: number;
} {
  return {
    added: rows.filter((r) => r.kind === 'added').length,
    removed: rows.filter((r) => r.kind === 'removed').length,
    changed: rows.filter((r) => r.kind === 'changed').length,
  };
}

/** Readable text for a snapshot value. Strings are shown as-is, everything else as compact JSON. */
export function formatValue(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return value === '' ? '(empty text)' : value;
  return JSON.stringify(value);
}
