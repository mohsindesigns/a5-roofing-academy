import type { notification } from '@a5/contracts';

/**
 * Editing model for notification rule conditions. The API stores conditions as a record of
 * payload field → literal | list | operator object; the editor works on flat rows
 * (field, operator, value) and converts both ways.
 */
export const CONDITION_OPERATORS = [
  { value: 'eq', label: 'is', symbol: '=' },
  { value: 'ne', label: 'is not', symbol: '≠' },
  { value: 'in', label: 'is one of', symbol: 'in' },
  { value: 'notIn', label: 'is none of', symbol: 'not in' },
  { value: 'gt', label: 'is greater than', symbol: '>' },
  { value: 'gte', label: 'is at least', symbol: '≥' },
  { value: 'lt', label: 'is less than', symbol: '<' },
  { value: 'lte', label: 'is at most', symbol: '≤' },
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number]['value'];

export interface ConditionRow {
  field: string;
  op: ConditionOperator;
  /** Raw text: a single value, or comma-separated values for list operators. */
  value: string;
}

type Literal = string | number | boolean | null;
const NUMERIC_OPS = new Set<ConditionOperator>(['gt', 'gte', 'lt', 'lte']);
const LIST_OPS = new Set<ConditionOperator>(['in', 'notIn']);

/** `true`, `false`, `null` and plain numbers keep their type; everything else is text. */
export function parseLiteral(text: string): Literal {
  const t = text.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function show(value: Literal): string {
  return value === null ? 'null' : String(value);
}

export function conditionsToRows(conditions: notification.RuleConditions): ConditionRow[] {
  const rows: ConditionRow[] = [];
  for (const [field, spec] of Object.entries(conditions)) {
    if (Array.isArray(spec)) {
      rows.push({ field, op: 'in', value: spec.map(show).join(', ') });
    } else if (spec !== null && typeof spec === 'object') {
      for (const op of CONDITION_OPERATORS) {
        const v = (spec as Record<string, unknown>)[op.value];
        if (v === undefined) continue;
        rows.push({
          field,
          op: op.value,
          value: Array.isArray(v)
            ? v.map((x) => show(x as Literal)).join(', ')
            : show(v as Literal),
        });
      }
    } else {
      rows.push({ field, op: 'eq', value: show(spec as Literal) });
    }
  }
  return rows;
}

/** Problems with the rows, keyed by row index. */
export function validateRows(rows: ConditionRow[]): Map<number, string> {
  const errors = new Map<number, string>();
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const field = r.field.trim();
    if (!field) errors.set(i, 'Enter the event field to check.');
    else if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){0,4}$/.test(field))
      errors.set(i, 'Use a field name such as passed or context.programId.');
    else if (!r.value.trim()) errors.set(i, 'Enter a value to compare with.');
    else if (NUMERIC_OPS.has(r.op) && Number.isNaN(Number(r.value.trim())))
      errors.set(i, 'This comparison needs a number.');
    else if (seen.has(`${field}:${r.op}`))
      errors.set(i, 'This check is already listed for the field.');
    seen.add(`${field}:${r.op}`);
  });
  if (rows.length > 10) errors.set(10, 'Use at most 10 conditions.');
  return errors;
}

/** Build the API record from valid rows. A lone "is" or "is one of" keeps the compact form. */
export function rowsToConditions(rows: ConditionRow[]): notification.RuleConditions {
  const byField = new Map<string, ConditionRow[]>();
  for (const r of rows) {
    const field = r.field.trim();
    byField.set(field, [...(byField.get(field) ?? []), r]);
  }
  const out: Record<string, unknown> = {};
  for (const [field, list] of byField) {
    const parsed = list.map((r) => {
      const v = r.value.trim();
      if (NUMERIC_OPS.has(r.op)) return [r.op, Number(v)] as const;
      if (LIST_OPS.has(r.op)) return [r.op, v.split(',').map(parseLiteral)] as const;
      return [r.op, parseLiteral(v)] as const;
    });
    if (parsed.length === 1) {
      const [op, value] = parsed[0]!;
      if (op === 'eq') out[field] = value;
      else if (op === 'in') out[field] = value;
      else out[field] = { [op]: value };
    } else {
      out[field] = Object.fromEntries(parsed);
    }
  }
  return out as notification.RuleConditions;
}

/** Plain-language lines for the fixed (non-editable) or current conditions. */
export function describeConditions(conditions: notification.RuleConditions): string[] {
  return conditionsToRows(conditions).map((r) => {
    const op = CONDITION_OPERATORS.find((o) => o.value === r.op)!;
    return `${r.field} ${op.label} ${r.value}`;
  });
}

/** Delay in the largest whole unit, for display and editing. */
export function splitDelay(minutes: number): { value: number; unit: 'minutes' | 'hours' | 'days' } {
  if (minutes > 0 && minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes > 0 && minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}

export function joinDelay(value: number, unit: 'minutes' | 'hours' | 'days'): number {
  return unit === 'days' ? value * 1440 : unit === 'hours' ? value * 60 : value;
}

export function describeDelay(minutes: number): string {
  if (minutes === 0) return 'Immediately';
  const { value, unit } = splitDelay(minutes);
  return `After ${value} ${value === 1 ? unit.slice(0, -1) : unit}`;
}
