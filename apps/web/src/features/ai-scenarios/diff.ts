export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };

/**
 * Line diff of two texts (longest common subsequence). Prompts are a few hundred lines at most,
 * so the quadratic table is fine and keeps the result easy to reason about.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      out.push({ kind: 'removed', text: a[i++]! });
    } else {
      out.push({ kind: 'added', text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'added', text: b[j++]! });
  return out;
}

/** Plain-language name for a diff field such as `scenario.openingLine`. */
export function fieldLabel(field: string): { group: string; label: string } {
  const [head, ...rest] = field.split('.');
  const split = (s: string) => {
    const words = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  };
  if ((head === 'persona' || head === 'scenario') && rest.length > 0)
    return { group: head === 'persona' ? 'Persona' : 'Scenario', label: split(rest.join(' ')) };
  return { group: 'Prompt and model', label: split(field) };
}

/** Text form of a value from a version snapshot, for display and diffing. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join('\n');
  return JSON.stringify(value, null, 2);
}
